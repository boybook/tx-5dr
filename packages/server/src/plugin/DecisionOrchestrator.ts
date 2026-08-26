/**
 * Decision orchestration — handles the per-operator decision pipeline,
 * message parsing, strategy invocation, and auto-call arbitration.
 *
 * Extracted from PluginManager to separate decision logic from plugin
 * lifecycle management. No reverse dependency on PluginManager.
 */
import {
  FT8MessageType,
  type FrameMessage,
  type LogbookAnalysis,
  type ParsedFT8Message,
  type SlotInfo,
  type SlotPack,
} from '@tx5dr/contracts';
import {
  normalizeCallsign,
  type AutoCallExecutionPlan,
  type AutoCallExecutionRequest,
  type ScoredCandidate,
  type StrategyDecision,
  type StrategyDecisionResult,
  type StrategyDecisionSource,
  type StrategyTransmission,
} from '@tx5dr/plugin-api';
import type { AutoCallProposalResult } from './PluginHookDispatcher.js';
import { evaluateAutomaticTargetEligibility } from './AutoTargetEligibility.js';
import type { DecisionOrchestratorDeps, OperatorDecisionState } from './types.js';
import { createLogger } from '../utils/logger.js';
import { snapshotPluginData } from './plugin-data-boundary.js';
import { FT8MessageParser, CycleUtils, isUndecodedCallsignPlaceholder } from '@tx5dr/core';
import type { OperatorCommandToken } from '../transmission/OperatorIntentCoordinator.js';

const logger = createLogger('DecisionOrchestrator');

interface SilentDirectedCallGate {
  expiresAtWallMs: number;
  expiresAtSlotStartMs: number;
  excludeCallsigns: Set<string>;
}

function getParsedMessageSenderCallsign(message: ParsedFT8Message['message']): string | undefined {
  return 'senderCallsign' in message && typeof message.senderCallsign === 'string'
    ? message.senderCallsign.toUpperCase()
    : undefined;
}

function getParsedMessageTargetCallsign(message: ParsedFT8Message['message']): string | undefined {
  return 'targetCallsign' in message && typeof message.targetCallsign === 'string'
    ? message.targetCallsign.toUpperCase()
    : undefined;
}

function callsignMatches(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalizedLeft = left.trim().toUpperCase();
  const normalizedRight = right.trim().toUpperCase();
  return normalizedLeft === normalizedRight
    || normalizeCallsign(normalizedLeft) === normalizeCallsign(normalizedRight);
}

function getParsedMessageGrid(message: ParsedFT8Message['message']): string | undefined {
  return 'grid' in message && typeof message.grid === 'string' && message.grid.trim().length > 0
    ? message.grid.trim().toUpperCase()
    : undefined;
}

function getParsedMessageKey(message: ParsedFT8Message): string {
  return `${message.slotId}|${message.rawMessage}|${message.df}|${message.dt}`;
}

function getScoredCandidateScore(message: ParsedFT8Message | undefined): number | undefined {
  const score = (message as { score?: unknown } | undefined)?.score;
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}

export class DecisionOrchestrator {
  private decisionStates = new Map<string, OperatorDecisionState>();
  private silentDirectedCallGates = new Map<string, SilentDirectedCallGate>();
  private qsoCompletionTails = new Map<string, Promise<void>>();

  constructor(private deps: DecisionOrchestratorDeps) {}

  // ===== Public API =====

  async handleSlotStart(slotInfo: SlotInfo, slotPack: SlotPack | null): Promise<void> {
    await Promise.all(this.deps.getOperators().map(async (operator) => {
      await this.deps.intentCoordinator.submit(
        operator.config.id,
        this.deps.hasTargetQueue?.(operator.config.id) === true ? 'assisted-queue' : 'slot-auto',
        (token, signal) => this.handleOperatorSlotStart(operator.config.id, slotInfo, slotPack, token, signal),
      );
    }));
  }

  private async handleOperatorSlotStart(
    operatorId: string,
    slotInfo: SlotInfo,
    slotPack: SlotPack | null,
    token: OperatorCommandToken,
    signal: AbortSignal,
  ): Promise<void> {
      const operator = this.deps.getOperatorById(operatorId);
      if (!operator) return;
      const parsedMessages = slotPack
        ? await this.parseSlotPackMessages(slotPack, operatorId)
        : [];
      if (!this.isCommandCurrent(token, signal)) return;
      // 决策分水岭：部分解码消息仅供广播/监控观察，绝不进入任何自动决策路径
      const actionableMessages = parsedMessages.filter((message) => !message.isPartialDecode);
      const hasTargetQueue = this.deps.hasTargetQueue?.(operatorId) === true;
      this.deps.observeStrategyMessages?.(
        operatorId,
        actionableMessages,
        slotInfo,
        'slot-auto',
        token,
        signal,
      );
      if (!this.isCommandCurrent(token, signal)) return;

      // Passive hooks are guarded and observed, but never hold the RF decision lane.
      void this.deps.dispatcher.dispatchBroadcast(
        operatorId,
        'onSlotActivity',
        (hook, ctx) => hook(snapshotPluginData({
          slotInfo,
          slotPack,
          frames: slotPack?.frames ?? [],
          messages: parsedMessages,
          source: 'live',
        }, 'structured'), ctx),
        (instance) => this.deps.getCtxForInstance(instance),
      );

      void this.deps.dispatcher.dispatchBroadcast(
        operatorId,
        'onSlotStart',
        (hook, ctx) => hook(
          snapshotPluginData(slotInfo, 'structured'),
          snapshotPluginData(parsedMessages, 'structured'),
          ctx,
        ),
        (instance) => this.deps.getCtxForInstance(instance),
      );

      void this.deps.dispatcher.dispatchBroadcast(
        operatorId,
        'onDecode',
        (hook, ctx) => hook(snapshotPluginData(parsedMessages, 'structured'), ctx),
        (instance) => this.deps.getCtxForInstance(instance),
      );

      if (!hasTargetQueue && !operator.isTransmitting
          && await this.tryWakeFromSilentDirectedCallGate(operatorId, actionableMessages, slotInfo, slotPack, token, signal)) {
        return;
      }
      if (!this.isCommandCurrent(token, signal)) return;

      if (!hasTargetQueue && !operator.isTransmitting
          && await this.tryWakeFromStoppedDirectCallAutoReply(operatorId, actionableMessages, slotInfo, slotPack, token, signal)) {
        return;
      }
      if (!this.isCommandCurrent(token, signal)) return;

      let automaticTargetMessages: ParsedFT8Message[] | undefined;
      if (!hasTargetQueue && this.isOperatorPureStandby(operatorId)) {
        automaticTargetMessages = await this.getScoredAutomaticTargetMessages(
          operatorId,
          actionableMessages,
        );
        if (!this.isCommandCurrent(token, signal)) return;

        const autoCallProposals = await this.deps.dispatcher.dispatchAutoCallCandidates(
          operatorId,
          slotInfo,
          automaticTargetMessages,
          (instance) => this.deps.getCtxForInstance(instance),
        );
        if (!this.isCommandCurrent(token, signal)) return;
        await this.applyAutoCallProposal(operatorId, slotInfo, automaticTargetMessages, autoCallProposals, token);
      }

      if (!operator.isTransmitting || !this.isCommandCurrent(token, signal)) return;

      const session = this.getOrCreateDecisionState(operatorId);
      session.lastDecisionTransmission = null;
      session.lastDecisionMessageSet = null;
      session.preDecisionEncodedTransmission = undefined;
      automaticTargetMessages ??= await this.getScoredAutomaticTargetMessages(
        operatorId,
        actionableMessages,
      );
      if (!this.isCommandCurrent(token, signal)) return;

      const decision = await this.invokeStrategyDecision(
        operatorId,
        automaticTargetMessages,
        { isReDecision: false },
        token,
        signal,
      );
      if (!this.isCommandCurrent(token, signal)) return;

      if (slotPack) {
        session.lastDecisionMessageSet = this.buildDecisionMessageSet(slotPack, operatorId);
      }
      session.lastDecisionTransmission = this.getTransmissionSetSignature(
        this.readCurrentTransmissions(operatorId),
      );
      await this.notifyQSOFailIfPresent(operatorId, decision);
      this.updateSilentDirectedCallGate(operatorId, decision, slotInfo, slotPack);

      // 竞态检测：如果 handleEncodeStart 在决策完成前已排队了发射内容，
      // 且决策结果与之不同，触发替换编码以纠正过时的发射
      if (session.preDecisionEncodedTransmission !== undefined
          && session.lastDecisionTransmission !== null
          && session.lastDecisionTransmission !== session.preDecisionEncodedTransmission) {
        logger.info('Stale encode corrected after decision', {
          operatorId,
          stale: session.preDecisionEncodedTransmission,
          correct: session.lastDecisionTransmission,
        });
        this.deps.triggerReEncode?.(operatorId, {
          source: 'late-decode',
          reason: 'slot decision corrected an already encoded frame',
        });
      }
      session.preDecisionEncodedTransmission = undefined;

      if (decision?.stop) {
        await this.applyStrategyStop(operatorId);
      }
  }

  private isCommandCurrent(token: OperatorCommandToken, signal: AbortSignal): boolean {
    return !signal.aborted && this.deps.intentCoordinator.isCurrent(token);
  }

  handleEncodeStart(slotInfo: SlotInfo): void {
    // 用引擎当前模式的 slotMs，不要用 operator.config.mode — 后者从 operator 创建后不会更新，
    // FT8↔FT4 切换后会残留陈旧 slotMs，导致 FT4 运行期按 FT8 的 15000ms 判周期（每 15s 而不是
    // 7.5s 一次决策），奇数时隙静默跳过。
    const currentMode = this.deps.getCurrentMode();
    for (const operator of this.deps.getOperators()) {
      if (!operator.isTransmitting) continue;
      if (this.deps.isQueueExecutionSuspended?.(operator.config.id) === true) continue;

      const isTransmitSlot = CycleUtils.isOperatorTransmitCycleFromMs(
        operator.getTransmitCycles(),
        slotInfo.startMs,
        currentMode.slotMs,
      );
      if (!isTransmitSlot) continue;

      try {
        const transmissions = this.readCurrentTransmissions(operator.config.id);
        if (transmissions.length === 0) continue;

        // 记录即将编码的内容，供 handleSlotStart 检测竞态
        const session = this.getOrCreateDecisionState(operator.config.id);
        session.preDecisionEncodedTransmission = this.getTransmissionSetSignature(transmissions) ?? undefined;

        this.deps.eventEmitter.emit('requestTransmitBatch', {
          operatorId: operator.config.id,
          transmissions: transmissions.map((item) => ({
            streamId: item.streamId,
            transmission: item.text,
            audioFrequencyHz: item.audioFrequencyHz,
          })),
          decisionEpoch: this.deps.intentCoordinator.getCurrentEpoch(operator.config.id),
        });
      } catch (err) {
        logger.error(`strategy runtime getTransmitText error: operator=${operator.config.id}`, err);
      }
    }
  }

  async reDecideOperator(operatorId: string, slotPack: SlotPack): Promise<boolean> {
    const outcome = await this.deps.intentCoordinator.submit(
      operatorId,
      'late-decode',
      (token, signal) => this.reDecideOperatorInLane(operatorId, slotPack, token, signal),
    );
    return outcome.status === 'completed' ? outcome.value : false;
  }

  async revalidateQueueExecution(operatorId: string): Promise<void> {
    const outcome = await this.deps.intentCoordinator.submit(
      operatorId,
      'assisted-queue',
      (token, signal) => this.revalidateQueueExecutionInLane(operatorId, token, signal),
    );
    if (outcome.status === 'superseded') {
      logger.debug('Queue execution resume was superseded', { operatorId });
    }
  }

  async revalidateQueueExecutionInLane(
    operatorId: string,
    token: OperatorCommandToken,
    signal: AbortSignal,
  ): Promise<StrategyDecisionResult | null> {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator?.isTransmitting || this.deps.hasTargetQueue?.(operatorId) !== true) return null;
    const decision = await this.invokeStrategyDecision(
      operatorId,
      [],
      { isReDecision: true },
      token,
      signal,
    );
    if (!this.isCommandCurrent(token, signal)) return null;
    await this.notifyQSOFailIfPresent(operatorId, decision);
    if (decision?.stop) await this.applyStrategyStop(operatorId);
    return decision;
  }

  private async reDecideOperatorInLane(
    operatorId: string,
    slotPack: SlotPack,
    token: OperatorCommandToken,
    signal: AbortSignal,
  ): Promise<boolean> {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator) {
      return false;
    }

    if (!operator.isTransmitting) {
      const slotInfo = this.buildSlotInfoFromSlotPack(slotPack);
      const parsedMessages = await this.parseSlotPackMessages(slotPack, operatorId);
      if (!this.isCommandCurrent(token, signal)) return false;
      const actionableMessages = parsedMessages.filter((message) => !message.isPartialDecode);
      this.deps.observeStrategyMessages?.(
        operatorId,
        actionableMessages,
        slotInfo,
        'late-decode',
        token,
        signal,
      );
      if (!this.isCommandCurrent(token, signal)) return false;
      if (this.deps.hasTargetQueue?.(operatorId) === true) return false;
      if (await this.tryWakeFromSilentDirectedCallGate(
        operatorId,
        actionableMessages,
        slotInfo,
        slotPack,
        token,
        signal,
      )) {
        return true;
      }
      return this.tryWakeFromStoppedDirectCallAutoReply(
        operatorId,
        actionableMessages,
        slotInfo,
        slotPack,
        token,
        signal,
      );
    }

    const session = this.getOrCreateDecisionState(operatorId);
    const newMessageSet = this.buildDecisionMessageSet(slotPack, operatorId);
    if (session.lastDecisionMessageSet) {
      const hasNewMessage = Array.from(newMessageSet).some((message) => !session.lastDecisionMessageSet?.has(message));
      if (!hasNewMessage) {
        return false;
      }
    }

    const parsedMessages = await this.parseSlotPackMessages(slotPack, operatorId);
    if (!this.isCommandCurrent(token, signal)) return false;
    const actionableMessages = parsedMessages.filter((message) => !message.isPartialDecode);
    this.deps.observeStrategyMessages?.(
      operatorId,
      actionableMessages,
      this.buildSlotInfoFromSlotPack(slotPack),
      'late-decode',
      token,
      signal,
    );
    if (!this.isCommandCurrent(token, signal)) return false;
    const automaticTargetMessages = await this.getScoredAutomaticTargetMessages(
      operatorId,
      actionableMessages,
    );
    if (!this.isCommandCurrent(token, signal)) return false;

    const decision = await this.invokeStrategyDecision(
      operatorId,
      automaticTargetMessages,
      { isReDecision: true },
      token,
      signal,
    );
    if (!this.isCommandCurrent(token, signal)) return false;

    await this.notifyQSOFailIfPresent(operatorId, decision);
    this.updateSilentDirectedCallGate(operatorId, decision, this.buildSlotInfoFromSlotPack(slotPack), slotPack);

    if (decision?.stop) {
      await this.applyStrategyStop(operatorId);
      return false;
    }

    session.lastDecisionMessageSet = newMessageSet;
    const newTransmission = this.getTransmissionSetSignature(this.readCurrentTransmissions(operatorId));
    if (newTransmission !== session.lastDecisionTransmission) {
      logger.info(`Late decode re-decision changed transmission: operator=${operatorId}`, {
        previousTransmission: session.lastDecisionTransmission,
        nextTransmission: newTransmission,
      });
      session.lastDecisionTransmission = newTransmission;
      return true;
    }

    return false;
  }

  readCurrentTransmission(operatorId: string): string | null {
    const transmissions = this.readCurrentTransmissions(operatorId);
    return transmissions.find((item) => item.streamId === 'default')?.text
      ?? transmissions[0]?.text
      ?? null;
  }

  readCurrentTransmissions(operatorId: string): StrategyTransmission[] {
    try {
      const operator = this.deps.getOperatorById(operatorId);
      if (!operator) return [];
      const transmissions = this.deps.invokeStrategyRuntimeSync(
        operatorId,
        'getTransmissions:read-current',
        (runtime) => {
          if (runtime.getTransmissions) return runtime.getTransmissions();
          const text = runtime.getTransmitText();
          return text ? [{
            streamId: 'default',
            text,
            audioFrequencyHz: operator.config.frequency ?? 0,
          }] : [];
        },
      ) ?? [];
      const operatorMaxStreams = this.deps.getEffectiveOperatorMaxConcurrentStreams?.(operatorId)
        ?? operator.config.maxConcurrentStreams
        ?? 3;
      const strategyMaxStreams = this.deps.getStrategyMaxConcurrentStreams?.(operatorId);
      if (strategyMaxStreams !== undefined
          && (!Number.isInteger(strategyMaxStreams) || strategyMaxStreams < 1)) {
        throw new Error(`Strategy declared an invalid stream limit: ${strategyMaxStreams}`);
      }
      const maxStreams = Math.min(operatorMaxStreams, strategyMaxStreams ?? operatorMaxStreams);
      if (transmissions.length > maxStreams) {
        throw new Error(`Strategy returned ${transmissions.length} streams; operator limit is ${maxStreams}`);
      }
      const streamIds = new Set<string>();
      return transmissions.map((transmission) => {
        const streamId = transmission.streamId.trim();
        const text = transmission.text.trim();
        if (!streamId || streamIds.has(streamId)) throw new Error(`Invalid or duplicate stream id: ${streamId}`);
        if (!text) throw new Error(`Empty transmission for stream ${streamId}`);
        if (!Number.isFinite(transmission.audioFrequencyHz)
            || transmission.audioFrequencyHz < 0
            || transmission.audioFrequencyHz > 5000) {
          throw new Error(`Invalid audio frequency for stream ${streamId}`);
        }
        streamIds.add(streamId);
        return { streamId, text, audioFrequencyHz: transmission.audioFrequencyHz };
      });
    } catch (err) {
      logger.error(`Failed to read current transmissions: operator=${operatorId}`, err);
      return [];
    }
  }

  private getTransmissionSetSignature(transmissions: StrategyTransmission[]): string | null {
    if (transmissions.length === 0) return null;
    return JSON.stringify([...transmissions].sort((a, b) => a.streamId.localeCompare(b.streamId)));
  }

  // ===== Decision state management =====

  initDecisionState(operatorId: string): void {
    this.getOrCreateDecisionState(operatorId);
  }

  removeDecisionState(operatorId: string): void {
    this.decisionStates.delete(operatorId);
    this.silentDirectedCallGates.delete(operatorId);
  }

  clearAllDecisionStates(): void {
    this.decisionStates.clear();
    this.silentDirectedCallGates.clear();
  }

  clearDecisionState(operatorId: string): void {
    this.decisionStates.set(operatorId, {
      lastDecisionTransmission: null,
      lastDecisionMessageSet: null,
    });
    this.silentDirectedCallGates.delete(operatorId);
  }

  invalidateDecisionMessageSet(operatorId: string): void {
    const state = this.getOrCreateDecisionState(operatorId);
    state.lastDecisionMessageSet = null;
  }

  commitQSOCompletionEffectsFromAction(
    operatorId: string,
    effects: import('@tx5dr/plugin-api').StrategyQSOCompletionEffect[],
  ): void {
    const runtimeGeneration = this.deps.getStrategyRuntimeGeneration(operatorId);
    if (runtimeGeneration === undefined || effects.length === 0) return;
    this.commitQSOCompletionEffects(operatorId, runtimeGeneration, effects);
  }

  hasActiveSilentDirectedCallGate(operatorId: string, slotPack?: SlotPack): boolean {
    return this.getActiveSilentDirectedCallGate(operatorId, slotPack?.startMs) !== undefined;
  }

  // ===== Private: Message parsing =====

  private async parseSlotPackMessages(slotPack: SlotPack, operatorId: string): Promise<ParsedFT8Message[]> {
    const LOCAL_OPERATOR_SIMULATED_SNR = 10;
    const operator = this.deps.getOperatorById(operatorId);
    const currentMode = this.deps.getCurrentMode();
    const isOperatorTransmittingInSourceSlot = operator?.isTransmitting === true
      && CycleUtils.isOperatorTransmitCycleFromMs(
        operator.getTransmitCycles(),
        slotPack.startMs,
        currentMode.slotMs,
      );

    const parsedMessages = await Promise.all(slotPack.frames.map(async (frame) => {
      const isLocalTxEcho = frame.snr === -999;
      if (
        isLocalTxEcho
        && frame.operatorId
        && frame.operatorId !== operatorId
        && isOperatorTransmittingInSourceSlot
      ) {
        logger.debug('Filtered same-cycle local TX echo from automatic decision input', {
          operatorId,
          sourceOperatorId: frame.operatorId,
          slotStartMs: slotPack.startMs,
          rawMessage: frame.message,
        });
        return null;
      }

      // 部分解码消息（含 `<...>` 未解码呼号占位符）不得作为自动决策输入，
      // 但需保留在 parsedMessages 中供广播/监控 hook 观察原始解码。
      const isPartialDecode = FT8MessageParser.rawContainsUndecodedCallsign(frame.message);
      const parsedMessage: ParsedFT8Message = {
        message: FT8MessageParser.parseMessage(frame.message),
        snr: isLocalTxEcho ? LOCAL_OPERATOR_SIMULATED_SNR : frame.snr,
        dt: frame.dt,
        df: frame.freq,
        rawMessage: frame.message,
        slotId: slotPack.slotId,
        timestamp: slotPack.startMs,
        isPartialDecode,
        logbookAnalysis: frame.logbookAnalysis,
      };

      if (frame.snr === -999 || isPartialDecode) {
        // 部分解码消息跳过日志本分析，避免以 `...` 查询产生 isNewCallsign 假象污染排序
        return parsedMessage;
      }

      const analysis = await this.analyzeMessageForOperator(parsedMessage, operatorId);
      return {
        ...parsedMessage,
        logbookAnalysis: analysis ?? parsedMessage.logbookAnalysis,
      };
    }));
    return parsedMessages.filter((message): message is ParsedFT8Message => message !== null);
  }

  private async analyzeMessageForOperator(
    parsedMessage: ParsedFT8Message,
    operatorId: string,
  ): Promise<LogbookAnalysis | undefined> {
    if (!this.deps.analyzeCallsignForOperator) {
      return parsedMessage.logbookAnalysis;
    }

    const callsign = getParsedMessageSenderCallsign(parsedMessage.message);
    if (!callsign) {
      return parsedMessage.logbookAnalysis;
    }

    const grid = getParsedMessageGrid(parsedMessage.message)
      ?? this.deps.resolveGrid?.(callsign);
    try {
      return await this.deps.analyzeCallsignForOperator(operatorId, callsign, grid)
        ?? parsedMessage.logbookAnalysis;
    } catch (error) {
      logger.warn(`Failed to analyze parsed message for operator ${operatorId}`, error);
      return parsedMessage.logbookAnalysis;
    }
  }

  // ===== Private: Decision pipeline =====

  private async getFilteredAutomaticTargetMessages(
    operatorId: string,
    messages: ParsedFT8Message[],
  ): Promise<ParsedFT8Message[]> {
    const automaticTargetMessages = this.filterAutomaticTargetMessages(operatorId, messages);
    const filteredMessages = await this.deps.dispatcher.dispatchFilterCandidates(
      operatorId,
      automaticTargetMessages,
      (instance) => this.deps.getCtxForInstance(instance),
    );
    return this.preserveDirectedProtocolMessages(operatorId, automaticTargetMessages, filteredMessages);
  }

  private async getScoredAutomaticTargetMessages(
    operatorId: string,
    messages: ParsedFT8Message[],
  ): Promise<ScoredCandidate[]> {
    const filteredMessages = await this.getFilteredAutomaticTargetMessages(operatorId, messages);
    const scored = await this.deps.dispatcher.dispatchScoreCandidates(
      operatorId,
      filteredMessages.map((message) => ({ ...message, score: 0 })),
      (instance) => this.deps.getCtxForInstance(instance),
    );
    return scored.sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return messages.findIndex((message) => getParsedMessageKey(message) === getParsedMessageKey(left))
        - messages.findIndex((message) => getParsedMessageKey(message) === getParsedMessageKey(right));
    });
  }

  private filterAutomaticTargetMessages(
    operatorId: string,
    messages: ParsedFT8Message[],
  ): ParsedFT8Message[] {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator) {
      return messages;
    }

    return messages.filter((message) => {
      // 部分解码消息不可作为自动目标候选
      if (message.isPartialDecode) {
        return false;
      }
      const decision = evaluateAutomaticTargetEligibility(operator.config.myCallsign, message);
      if (decision.eligible) {
        return true;
      }

      logger.debug('Automatic target message filtered by CQ modifier eligibility', {
        operatorId,
        callsign: getParsedMessageSenderCallsign(message.message),
        modifier: decision.modifier,
        reason: decision.reason,
        rawMessage: message.rawMessage,
      });
      return false;
    });
  }

  private preserveDirectedProtocolMessages(
    operatorId: string,
    sourceMessages: ParsedFT8Message[],
    filteredMessages: ParsedFT8Message[],
  ): ParsedFT8Message[] {
    const operator = this.deps.getOperatorById(operatorId);
    const automation = this.deps.getOperatorAutomationSnapshot(operatorId);
    const currentState = automation?.currentState ?? '';
    const targetCallsign = automation?.context?.targetCallsign?.trim().toUpperCase();
    const myCallsign = operator?.config.myCallsign.trim().toUpperCase();

    if (!operator || !myCallsign) {
      return filteredMessages;
    }

    const filteredKeys = new Set(filteredMessages.map(getParsedMessageKey));
    const preservedMessages = sourceMessages.filter((message) => {
      // 部分解码消息（如 Fox `<...>` 哈希）不可作为进行中 QSO 的协议消息被抢救
      if (message.isPartialDecode) {
        return false;
      }
      if (filteredKeys.has(getParsedMessageKey(message))) {
        return false;
      }
      if (this.isInboundDirectedProtocolMessage(message, myCallsign)) {
        return true;
      }
      return targetCallsign !== undefined
        && currentState !== 'TX6'
        && this.isActiveQsoProtocolMessage(message, targetCallsign, myCallsign);
    });

    if (preservedMessages.length === 0) {
      return filteredMessages;
    }

    logger.debug('Preserved directed protocol messages after candidate filters', {
      operatorId,
      targetCallsign: targetCallsign ?? null,
      currentState,
      preservedMessages: preservedMessages.map((message) => message.rawMessage),
    });

    return [...filteredMessages, ...preservedMessages];
  }

  private isInboundDirectCallMessage(
    message: ParsedFT8Message,
    myCallsign: string,
  ): boolean {
    if (message.isPartialDecode) {
      return false;
    }
    const target = getParsedMessageTargetCallsign(message.message);
    if (!callsignMatches(target, myCallsign)) {
      return false;
    }

    return message.message.type === FT8MessageType.CALL
      || message.message.type === FT8MessageType.SIGNAL_REPORT;
  }

  private isInboundDirectedProtocolMessage(
    message: ParsedFT8Message,
    myCallsign: string,
  ): boolean {
    if (message.isPartialDecode) {
      return false;
    }
    const target = getParsedMessageTargetCallsign(message.message);
    if (!callsignMatches(target, myCallsign)) {
      return false;
    }

    return message.message.type === FT8MessageType.CALL
      || message.message.type === FT8MessageType.SIGNAL_REPORT
      || message.message.type === FT8MessageType.ROGER_REPORT
      || message.message.type === FT8MessageType.RRR;
  }

  private isActiveQsoProtocolMessage(
    message: ParsedFT8Message,
    targetCallsign: string,
    myCallsign: string,
  ): boolean {
    if (message.isPartialDecode) {
      return false;
    }
    if (message.message.type === FT8MessageType.FOX_RR73) {
      const foxMessage = message.message as { completedCallsign?: unknown; senderCallsign?: unknown };
      const completedCallsign = typeof foxMessage.completedCallsign === 'string'
        ? foxMessage.completedCallsign.trim().toUpperCase()
        : undefined;
      if (!callsignMatches(completedCallsign, myCallsign)) {
        return false;
      }

      const senderCallsign = getParsedMessageSenderCallsign(message.message);
      return senderCallsign === undefined || callsignMatches(senderCallsign, targetCallsign);
    }

    const senderCallsign = getParsedMessageSenderCallsign(message.message);
    const target = getParsedMessageTargetCallsign(message.message);
    if (!callsignMatches(senderCallsign, targetCallsign) || !callsignMatches(target, myCallsign)) {
      return false;
    }

    switch (message.message.type) {
      case FT8MessageType.CALL:
      case FT8MessageType.SIGNAL_REPORT:
      case FT8MessageType.ROGER_REPORT:
      case FT8MessageType.RRR:
      case FT8MessageType.SEVENTY_THREE:
        return true;
      default:
        return false;
    }
  }

  private async invokeStrategyDecision(
    operatorId: string,
    messages: ParsedFT8Message[],
    meta: { isReDecision: boolean },
    token: OperatorCommandToken,
    signal: AbortSignal,
  ): Promise<StrategyDecisionResult | null> {
    if (!this.deps.getStrategyRuntime(operatorId)) {
      return null;
    }
    const runtimeGeneration = this.deps.getStrategyRuntimeGeneration(operatorId);
    if (runtimeGeneration === undefined) return null;

    const checkpoint = this.deps.invokeStrategyRuntimeSync(
      operatorId,
      'checkpoint:decision',
      (runtime) => runtime.checkpoint(),
    );
    if (checkpoint === undefined) return null;
    const source: StrategyDecisionSource = meta.isReDecision ? 'late-decode' : 'slot-auto';
    const rejectedTargets = new Set<string>();
    const maxAttempts = Math.max(
      1,
      new Set(messages.map((message) => getParsedMessageSenderCallsign(message.message)).filter(Boolean)).size + 1,
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const result = await this.deps.invokeStrategyRuntime(
          operatorId,
          `decide:${source}`,
          (runtime) => runtime.decide(snapshotPluginData(messages, 'structured'), {
            epoch: token.epoch,
            source,
            isReDecision: meta.isReDecision,
            signal,
          }),
          { signal },
        );
        if (!result) return null;
        if (!this.isCommandCurrent(token, signal)) {
          this.deps.invokeStrategyRuntimeSync(
            operatorId,
            'restore:superseded-decision',
            (runtime) => {
              runtime.restore(snapshotPluginData(checkpoint, 'structured'));
            },
          );
          return null;
        }

        const streamTargets = (result.snapshot.streams ?? []).flatMap((stream) => (
          stream.targetCallsign?.trim()
            ? [{ streamId: stream.streamId, targetCallsign: stream.targetCallsign.trim().toUpperCase() }]
            : []
        ));
        const nextTarget = result.snapshot.context?.targetCallsign?.trim().toUpperCase();
        const reservationAccepted = streamTargets.length > 0 && this.deps.transitionTargetReservations
          ? this.deps.transitionTargetReservations(operatorId, token.epoch, streamTargets)
          : this.deps.transitionTargetReservation
            ? this.deps.transitionTargetReservation(operatorId, token.epoch, nextTarget)
            : true;
        if (!reservationAccepted) {
          this.deps.invokeStrategyRuntimeSync(
            operatorId,
            'restore:target-reservation-conflict',
            (runtime) => {
              runtime.restore(snapshotPluginData(checkpoint, 'structured'));
            },
          );
          if (streamTargets.length > 1 || !nextTarget || rejectedTargets.has(nextTarget)) {
            logger.warn('Strategy repeatedly selected a target reserved by another operator', {
              operatorId,
              epoch: token.epoch,
              targetCallsign: nextTarget ?? null,
              streamTargets,
            });
            return null;
          }
          rejectedTargets.add(nextTarget);
          continue;
        }

        const operator = this.deps.getOperatorById(operatorId);
        if (operator) {
          this.deps.markQueueExecutionValidated?.(operatorId);
          if (Number.isInteger(result.requestedTransmitCycle)
              && result.requestedTransmitCycle! >= 0
              && result.requestedTransmitCycle! <= 1) {
            operator.setTransmitCycles(result.requestedTransmitCycle!, {
              commandEpoch: token.epoch,
              source: 'slot-auto',
              reason: 'queue activation selected transmit cycle from source frame',
            });
          }
          if (result.snapshot.slots) {
            operator.notifySlotsUpdated(result.snapshot.slots as import('@tx5dr/contracts').OperatorSlots);
          }
          operator.notifyStateChanged(result.snapshot.currentState);
        }
        if (result.snapshot.streams && result.snapshot.streams.length > 0) {
          for (const stream of result.snapshot.streams) {
            this.deps.eventEmitter.emit('qsoLifecycleChanged', {
              operatorId,
              streamId: stream.streamId,
              lifecycleEpoch: stream.qsoLifecycleEpoch,
              runtimeGeneration,
            });
          }
        } else if (result.snapshot.qsoLifecycleEpoch !== undefined) {
          this.deps.eventEmitter.emit('qsoLifecycleChanged', {
            operatorId,
            lifecycleEpoch: result.snapshot.qsoLifecycleEpoch,
            runtimeGeneration,
          });
        }
        const qsoCompletions = [
          ...(result.qsoCompletion ? [result.qsoCompletion] : []),
          ...(result.qsoCompletions ?? []),
        ];
        if (qsoCompletions.length > 0) {
          this.commitQSOCompletionEffects(operatorId, runtimeGeneration, qsoCompletions);
        }
        return result;
      } catch (error) {
        this.deps.invokeStrategyRuntimeSync(
          operatorId,
          'restore:failed-decision',
          (runtime) => {
            runtime.restore(snapshotPluginData(checkpoint, 'structured'));
          },
        );
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          logger.debug('Discarded aborted strategy decision', { operatorId, epoch: token.epoch, source });
          return null;
        }
        throw error;
      }
    }
    return null;
  }

  private commitQSOCompletionEffects(
    operatorId: string,
    runtimeGeneration: number,
    effects: import('@tx5dr/plugin-api').StrategyQSOCompletionEffect[],
  ): void {
    const previous = this.qsoCompletionTails.get(operatorId) ?? Promise.resolve();
    let tail = previous;
    for (const effect of effects) {
      tail = tail.then(() => this.commitQSOCompletionEffect(operatorId, runtimeGeneration, effect));
    }
    this.qsoCompletionTails.set(operatorId, tail);
    void tail.finally(() => {
      if (this.qsoCompletionTails.get(operatorId) === tail) this.qsoCompletionTails.delete(operatorId);
    });
  }

  private async commitQSOCompletionEffect(
    operatorId: string,
    runtimeGeneration: number,
    effect: import('@tx5dr/plugin-api').StrategyQSOCompletionEffect,
  ): Promise<void> {
    const { record: qsoRecord, lifecycleEpoch } = effect;
    const streamSegment = effect.streamId
      ? `:stream:${encodeURIComponent(effect.streamId)}`
      : '';
    const qsoLifecycleId = `${operatorId}:runtime:${runtimeGeneration}${streamSegment}:qso:${lifecycleEpoch}:${qsoRecord.id}`;
    await new Promise<import('@tx5dr/contracts').QSORecord>((resolve, reject) => {
      this.deps.eventEmitter.emit('recordQSO', {
        operatorId,
        streamId: effect.streamId,
        qsoLifecycleId,
        qsoLifecycleEpoch: lifecycleEpoch,
        qsoRuntimeGeneration: runtimeGeneration,
        qsoRecord,
        persistencePolicy: effect.persistencePolicy,
        resolve,
        reject,
      });
    }).then((persistedRecord) => {
      this.settleStrategyQSOCompletion(
        operatorId,
        runtimeGeneration,
        lifecycleEpoch,
        qsoRecord.id,
        'committed',
        effect.streamId,
        persistedRecord.id,
      );
    }).catch((error) => {
      this.settleStrategyQSOCompletion(
        operatorId,
        runtimeGeneration,
        lifecycleEpoch,
        qsoRecord.id,
        'failed',
        effect.streamId,
      );
      logger.warn('Declarative QSO completion failed after decision commit', {
        operatorId,
        qsoLifecycleId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private settleStrategyQSOCompletion(
    operatorId: string,
    runtimeGeneration: number,
    lifecycleEpoch: number,
    recordId: string,
    status: 'committed' | 'failed',
    streamId?: string,
    persistedRecordId?: string,
  ): void {
    if (this.deps.getStrategyRuntimeGeneration(operatorId) !== runtimeGeneration) {
      logger.debug('Skipped QSO settlement for a replaced strategy runtime', {
        operatorId,
        runtimeGeneration,
        lifecycleEpoch,
        recordId,
        status,
      });
      return;
    }
    try {
      const beforeQueueVersion = this.deps.invokeStrategyRuntimeSync(
        operatorId,
        'snapshot:before-qso-settlement',
        (runtime) => runtime.getSnapshot().queue?.version,
      );
      this.deps.invokeStrategyRuntimeSync(
        operatorId,
        `settle-qso:${status}`,
        (runtime) => {
          runtime.settleQSOCompletion?.({
            lifecycleEpoch,
            recordId,
            status,
            streamId,
            ...(persistedRecordId ? { persistedRecordId } : {}),
          });
        },
      );
      const afterQueueVersion = this.deps.invokeStrategyRuntimeSync(
        operatorId,
        'snapshot:after-qso-settlement',
        (runtime) => runtime.getSnapshot().queue?.version,
      );
      if (afterQueueVersion !== beforeQueueVersion) {
        this.deps.notifyOperatorStatusChanged?.(operatorId);
      }
    } catch (error) {
      logger.warn('Failed to settle strategy QSO lifecycle', {
        operatorId,
        lifecycleEpoch,
        recordId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyQSOFailIfPresent(
    operatorId: string,
    decision: StrategyDecision | null | undefined,
  ): Promise<void> {
    const failures = [
      ...(decision?.qsoFailure ? [decision.qsoFailure] : []),
      ...(decision?.qsoFailures ?? []),
    ];
    for (const failure of failures) {
      if (!failure.targetCallsign || !failure.reason) continue;
      try {
        await this.deps.notifyQSOFail(operatorId, {
          ...failure,
          targetCallsign: failure.targetCallsign.trim().toUpperCase(),
        });
      } catch (error) {
        logger.warn(`Failed to notify QSO failure for operator ${operatorId}`, error);
      }
    }
  }

  private updateSilentDirectedCallGate(
    operatorId: string,
    decision: StrategyDecision | null | undefined,
    slotInfo: SlotInfo,
    slotPack: SlotPack | null,
  ): void {
    const silentListen = decision?.silentListen;
    if (!decision?.stop || !silentListen?.acceptDirectedCalls || silentListen.reason !== 'qso-success') {
      if (decision && !decision.stop) {
        this.silentDirectedCallGates.delete(operatorId);
      }
      return;
    }

    const currentMode = this.deps.getCurrentMode();
    const graceSlots = Math.max(1, Math.trunc(silentListen.graceSlots ?? 2));
    const sourceSlotStartMs = slotPack?.startMs ?? slotInfo.startMs;
    const wallTtlMs = Math.max(currentMode.slotMs * (graceSlots + 1), 60_000);
    const excludeCallsigns = new Set(
      (silentListen.excludeCallsigns ?? [])
        .map((callsign) => callsign.trim().toUpperCase())
        .filter(Boolean),
    );

    this.silentDirectedCallGates.set(operatorId, {
      expiresAtWallMs: Date.now() + wallTtlMs,
      expiresAtSlotStartMs: sourceSlotStartMs + currentMode.slotMs * graceSlots,
      excludeCallsigns,
    });

    logger.debug('Armed silent directed-call gate after QSO success', {
      operatorId,
      sourceSlotStartMs,
      graceSlots,
      excludeCallsigns: Array.from(excludeCallsigns),
    });
  }

  private getActiveSilentDirectedCallGate(
    operatorId: string,
    messageSlotStartMs?: number,
  ): SilentDirectedCallGate | undefined {
    const gate = this.silentDirectedCallGates.get(operatorId);
    if (!gate) {
      return undefined;
    }

    if (Date.now() > gate.expiresAtWallMs
        || (messageSlotStartMs !== undefined && messageSlotStartMs > gate.expiresAtSlotStartMs)) {
      this.silentDirectedCallGates.delete(operatorId);
      return undefined;
    }

    return gate;
  }

  private async tryWakeFromSilentDirectedCallGate(
    operatorId: string,
    parsedMessages: ParsedFT8Message[],
    slotInfo: SlotInfo,
    slotPack: SlotPack | null,
    token: OperatorCommandToken,
    signal: AbortSignal,
  ): Promise<boolean> {
    const operator = this.deps.getOperatorById(operatorId);
    const gate = this.getActiveSilentDirectedCallGate(operatorId, slotPack?.startMs);
    if (!operator || operator.isTransmitting || !gate) {
      return false;
    }

    const myCallsign = operator.config.myCallsign.trim().toUpperCase();
    const scoredMessages = await this.getScoredAutomaticTargetMessages(operatorId, parsedMessages);
    const directedMessages = scoredMessages.filter((message) => {
      const sender = getParsedMessageSenderCallsign(message.message);
      return this.isInboundDirectCallMessage(message, myCallsign)
        && (!sender || !gate.excludeCallsigns.has(sender));
    });
    if (directedMessages.length === 0) {
      return false;
    }

    const before = this.deps.getOperatorAutomationSnapshot(operatorId);
    const decision = await this.invokeStrategyDecision(
      operatorId,
      directedMessages,
      { isReDecision: true },
      token,
      signal,
    );
    if (!this.isCommandCurrent(token, signal)) return false;
    await this.notifyQSOFailIfPresent(operatorId, decision);
    if (decision?.stop) {
      this.updateSilentDirectedCallGate(operatorId, decision, slotInfo, slotPack);
      return false;
    }

    const after = this.deps.getOperatorAutomationSnapshot(operatorId);
    const beforeState = before?.currentState ?? 'TX6';
    const afterState = after?.currentState ?? 'TX6';
    const targetCallsign = after?.context?.targetCallsign?.trim().toUpperCase();
    if (!targetCallsign || (beforeState === afterState && before?.context?.targetCallsign === after?.context?.targetCallsign)) {
      return false;
    }

    const sourceMessage = directedMessages.find((message) =>
      getParsedMessageSenderCallsign(message.message) === targetCallsign
    ) ?? directedMessages[0];
    const sourceSlotInfo = this.buildSourceSlotInfoFromParsedMessage(operatorId, sourceMessage, slotInfo);

    this.silentDirectedCallGates.delete(operatorId);
    operator.start();
    operator.setTransmitCycles((sourceSlotInfo.cycleNumber + 1) % 2, {
      commandEpoch: token.epoch,
      source: 'late-decode',
      reason: 'silent directed call selected transmit cycle',
    });

    logger.info('Silent directed-call gate woke stopped operator', {
      operatorId,
      targetCallsign,
      fromState: beforeState,
      toState: afterState,
      rawMessage: sourceMessage.rawMessage,
    });

    return true;
  }

  private async tryWakeFromStoppedDirectCallAutoReply(
    operatorId: string,
    parsedMessages: ParsedFT8Message[],
    slotInfo: SlotInfo,
    slotPack: SlotPack | null,
    token: OperatorCommandToken,
    signal: AbortSignal,
  ): Promise<boolean> {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator
        || operator.isTransmitting
        || !this.isOperatorPureStandby(operatorId)
        || this.deps.isStoppedDirectCallAutoReplyEnabled?.(operatorId) !== true) {
      return false;
    }

    const myCallsign = operator.config.myCallsign.trim().toUpperCase();
    const scoredMessages = await this.getScoredAutomaticTargetMessages(operatorId, parsedMessages);
    const directedMessages = scoredMessages.filter((message) =>
      this.isInboundDirectCallMessage(message, myCallsign)
    );
    if (directedMessages.length === 0) {
      return false;
    }

    const before = this.deps.getOperatorAutomationSnapshot(operatorId);
    const decision = await this.invokeStrategyDecision(
      operatorId,
      directedMessages,
      { isReDecision: true },
      token,
      signal,
    );
    if (!this.isCommandCurrent(token, signal)) return false;
    await this.notifyQSOFailIfPresent(operatorId, decision);
    if (decision?.stop) {
      return false;
    }

    const after = this.deps.getOperatorAutomationSnapshot(operatorId);
    const beforeTarget = before?.context?.targetCallsign?.trim().toUpperCase();
    const afterTarget = after?.context?.targetCallsign?.trim().toUpperCase();
    const afterState = after?.currentState ?? 'TX6';
    if (!afterTarget
        || (afterState !== 'TX2' && afterState !== 'TX3')
        || (before?.currentState === afterState && beforeTarget === afterTarget)) {
      return false;
    }

    const sourceMessage = directedMessages.find((message) =>
      getParsedMessageSenderCallsign(message.message) === afterTarget
    ) ?? directedMessages[0];
    const sourceSlotInfo = this.buildSourceSlotInfoFromParsedMessage(operatorId, sourceMessage, slotInfo);

    operator.start();
    operator.setTransmitCycles((sourceSlotInfo.cycleNumber + 1) % 2, {
      commandEpoch: token.epoch,
      source: 'late-decode',
      reason: 'stopped direct call selected transmit cycle',
    });

    logger.info('Stopped direct-call auto-reply woke operator', {
      operatorId,
      targetCallsign: afterTarget,
      fromState: before?.currentState ?? 'TX6',
      toState: afterState,
      rawMessage: sourceMessage.rawMessage,
      sourceSlotId: sourceSlotInfo.id,
    });

    return true;
  }

  private async applyStrategyStop(operatorId: string): Promise<void> {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator) {
      return;
    }

    operator.stop();
    this.deps.requestOperatorStrategyStop?.(operatorId, 'strategy stop');
  }

  private isOperatorPureStandby(operatorId: string): boolean {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator || operator.isTransmitting) {
      return false;
    }

    const automation = this.deps.getOperatorAutomationSnapshot(operatorId);
    if (!automation) {
      return true;
    }

    const targetCallsign = typeof automation.context?.targetCallsign === 'string'
      ? automation.context.targetCallsign.trim()
      : '';
    return automation.currentState === 'TX6' && targetCallsign.length === 0;
  }

  // ===== Private: Auto-call arbitration =====

  private async applyAutoCallProposal(
    operatorId: string,
    slotInfo: SlotInfo,
    messages: ParsedFT8Message[],
    proposals: AutoCallProposalResult[],
    token: OperatorCommandToken,
  ): Promise<void> {
    if (proposals.length === 0 || !this.isOperatorPureStandby(operatorId)) {
      return;
    }

    const snrPriorityEnabled = this.deps.isSnrPriorityEnabled?.(operatorId) === true;
    const ranked = proposals
      .filter((entry) =>
        !isUndecodedCallsignPlaceholder(entry.proposal.callsign)
        && this.isAutoCallProposalEligible(operatorId, entry, messages))
      .map((entry) => this.normalizeAutoCallProposal(operatorId, slotInfo, messages, entry))
      .map((entry) => ({
        ...entry,
        priority: typeof entry.proposal.priority === 'number' ? entry.proposal.priority : 0,
        messageOrder: this.resolveProposalMessageOrder(entry.proposal, messages),
        sourceScore: this.resolveProposalSourceScore(entry.proposal, messages),
      }))
      .sort((left, right) => {
        if (snrPriorityEnabled && left.sourceScore !== right.sourceScore) {
          return right.sourceScore - left.sourceScore;
        }
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }
        if (left.messageOrder !== right.messageOrder) {
          return left.messageOrder - right.messageOrder;
        }
        return left.pluginName.localeCompare(right.pluginName);
      });

    const winner = ranked[0];
    if (!winner) {
      return;
    }

    if (ranked.length > 1) {
      logger.info('Auto call proposals arbitrated', {
        operatorId,
        selectedPlugin: winner.pluginName,
        selectedCallsign: winner.proposal.callsign,
        candidateCount: ranked.length,
      });
    }

    logger.info('Auto call proposal accepted', {
      operatorId,
      pluginName: winner.pluginName,
      callsign: winner.proposal.callsign,
      priority: winner.priority,
    });

    const request: AutoCallExecutionRequest = {
      sourcePluginName: winner.pluginName,
      callsign: winner.proposal.callsign,
      slotInfo,
      sourceSlotInfo: winner.proposal.lastMessage?.slotInfo,
      lastMessage: winner.proposal.lastMessage,
    };
    const executionPlan = await this.resolveAutoCallExecutionPlan(operatorId, request);
    await this.applyAutoCallExecutionPlan(operatorId, request, executionPlan, token);
    this.deps.requestCall(operatorId, request.callsign, request.lastMessage, { commandToken: token });
  }

  private isAutoCallProposalEligible(
    operatorId: string,
    entry: AutoCallProposalResult,
    messages: ParsedFT8Message[],
  ): boolean {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator) {
      return false;
    }

    // 占位符呼号（`<...>`/`...`）的提案一律拒绝，即使找不到源消息（findProposalSourceMessage 兜底放行）
    if (isUndecodedCallsignPlaceholder(entry.proposal.callsign)) {
      logger.info('Auto call proposal rejected by undecoded placeholder callsign', {
        operatorId,
        pluginName: entry.pluginName,
        callsign: entry.proposal.callsign,
      });
      return false;
    }

    const sourceMessage = this.findProposalSourceMessage(entry.proposal, messages);
    if (!sourceMessage) {
      logger.debug('Auto call proposal could not be validated against a source message, keeping proposal for compatibility', {
        operatorId,
        pluginName: entry.pluginName,
        callsign: entry.proposal.callsign,
      });
      return true;
    }

    const decision = evaluateAutomaticTargetEligibility(operator.config.myCallsign, sourceMessage);
    if (decision.eligible) {
      if (!this.deps.isSnrPriorityEnabled?.(operatorId)) {
        return true;
      }

      const sourceScore = getScoredCandidateScore(sourceMessage);
      const topScore = this.resolveTopMessageScore(messages);
      if (sourceScore === undefined || topScore === undefined || sourceScore >= topScore) {
        return true;
      }

      logger.info('Auto call proposal rejected by SNR-priority', {
        operatorId,
        pluginName: entry.pluginName,
        callsign: entry.proposal.callsign,
        sourceScore,
        topScore,
        rawMessage: sourceMessage.rawMessage,
      });
      return false;
    }

    logger.info('Auto call proposal rejected by CQ modifier eligibility', {
      operatorId,
      pluginName: entry.pluginName,
      callsign: entry.proposal.callsign,
      modifier: decision.modifier,
      reason: decision.reason,
      rawMessage: sourceMessage.rawMessage,
    });
    return false;
  }

  private findMatchedParsedMessage(
    lastMessage: { message: FrameMessage; slotInfo: SlotInfo } | undefined,
    messages: ParsedFT8Message[],
  ): ParsedFT8Message | undefined {
    if (!lastMessage) {
      return undefined;
    }

    return messages.find((message) => (
      message.rawMessage === lastMessage.message.message
      && message.df === lastMessage.message.freq
      && message.dt === lastMessage.message.dt
    )) ?? messages.find((message) => (
      message.rawMessage === lastMessage.message.message
    ));
  }

  private findProposalSourceMessage(
    proposal: AutoCallProposalResult['proposal'],
    messages: ParsedFT8Message[],
  ): ParsedFT8Message | undefined {
    const exactMatch = this.findMatchedParsedMessage(proposal.lastMessage, messages);
    if (exactMatch) {
      return exactMatch;
    }

    const proposalCallsign = proposal.callsign.trim().toUpperCase();
    return messages.find((message) => getParsedMessageSenderCallsign(message.message) === proposalCallsign);
  }

  private normalizeAutoCallProposal(
    operatorId: string,
    currentSlotInfo: SlotInfo,
    messages: ParsedFT8Message[],
    entry: AutoCallProposalResult,
  ): AutoCallProposalResult {
    const matchedMessage = this.findMatchedParsedMessage(entry.proposal.lastMessage, messages);
    if (!matchedMessage || !entry.proposal.lastMessage) {
      return entry;
    }

    return {
      ...entry,
      proposal: {
        ...entry.proposal,
        lastMessage: {
          ...entry.proposal.lastMessage,
          slotInfo: this.buildSourceSlotInfoFromParsedMessage(operatorId, matchedMessage, currentSlotInfo),
        },
      },
    };
  }

  private resolveProposalMessageOrder(
    proposal: AutoCallProposalResult['proposal'],
    messages: ParsedFT8Message[],
  ): number {
    const lastMessage = proposal.lastMessage;
    if (!lastMessage) {
      return Number.MAX_SAFE_INTEGER;
    }

    const exactIndex = messages.findIndex((message) => (
      message.rawMessage === lastMessage.message.message
      && message.df === lastMessage.message.freq
      && message.dt === lastMessage.message.dt
    ));
    if (exactIndex >= 0) {
      return exactIndex;
    }

    const rawIndex = messages.findIndex((message) => (
      message.rawMessage === lastMessage.message.message
    ));
    return rawIndex >= 0 ? rawIndex : Number.MAX_SAFE_INTEGER;
  }

  private resolveProposalSourceScore(
    proposal: AutoCallProposalResult['proposal'],
    messages: ParsedFT8Message[],
  ): number {
    const sourceMessage = this.findProposalSourceMessage(proposal, messages);
    return getScoredCandidateScore(sourceMessage) ?? Number.NEGATIVE_INFINITY;
  }

  private resolveTopMessageScore(messages: ParsedFT8Message[]): number | undefined {
    let topScore: number | undefined;
    for (const message of messages) {
      const score = getScoredCandidateScore(message);
      if (score === undefined) {
        continue;
      }
      if (topScore === undefined || score > topScore) {
        topScore = score;
      }
    }
    return topScore;
  }

  private async resolveAutoCallExecutionPlan(
    operatorId: string,
    request: AutoCallExecutionRequest,
  ): Promise<AutoCallExecutionPlan> {
    return this.deps.dispatcher.dispatchAutoCallExecutionPlan(
      operatorId,
      request,
      {},
      (instance) => this.deps.getCtxForInstance(instance),
    );
  }

  private async applyAutoCallExecutionPlan(
    operatorId: string,
    request: AutoCallExecutionRequest,
    plan: AutoCallExecutionPlan,
    token: OperatorCommandToken,
  ): Promise<void> {
    if (!this.deps.setOperatorAudioFrequency) {
      return;
    }

    const requestedFrequency = plan.audioFrequency;
    if (typeof requestedFrequency !== 'number' || !Number.isFinite(requestedFrequency)) {
      return;
    }

    const operator = this.deps.getOperatorById(operatorId);
    if (operator && operator.config.frequency === requestedFrequency) {
      return;
    }

    try {
      await this.deps.setOperatorAudioFrequency(operatorId, requestedFrequency, token);
      logger.info('Auto call execution plan applied audio frequency', {
        operatorId,
        slotId: request.slotInfo.id,
        callsign: request.callsign,
        frequency: requestedFrequency,
      });
    } catch (error) {
      logger.warn(`Failed to apply auto call execution plan for operator ${operatorId}`, error);
    }
  }

  private buildSourceSlotInfoFromParsedMessage(
    _operatorId: string,
    parsedMessage: ParsedFT8Message,
    _fallbackSlotInfo: SlotInfo,
  ): SlotInfo {
    // 用引擎当前模式（理由同 handleEncodeStart）
    const currentMode = this.deps.getCurrentMode();
    const startMs = parsedMessage.timestamp;
    const cycleNumber = CycleUtils.calculateCycleNumberFromMs(startMs, currentMode.slotMs);
    const utcSeconds = Math.floor(startMs / 1000);

    return {
      id: parsedMessage.slotId,
      startMs,
      utcSeconds,
      phaseMs: 0,
      driftMs: 0,
      cycleNumber,
      mode: currentMode.name,
    };
  }

  private buildSlotInfoFromSlotPack(slotPack: SlotPack): SlotInfo {
    const currentMode = this.deps.getCurrentMode();
    const startMs = slotPack.startMs;
    return {
      id: slotPack.slotId,
      startMs,
      utcSeconds: Math.floor(startMs / 1000),
      phaseMs: 0,
      driftMs: 0,
      cycleNumber: CycleUtils.calculateCycleNumberFromMs(startMs, currentMode.slotMs),
      mode: currentMode.name,
    };
  }

  // ===== Private: Decision state helpers =====

  private getOrCreateDecisionState(operatorId: string): OperatorDecisionState {
    let state = this.decisionStates.get(operatorId);
    if (!state) {
      state = {
        lastDecisionTransmission: null,
        lastDecisionMessageSet: null,
      };
      this.decisionStates.set(operatorId, state);
    }
    return state;
  }

  private buildDecisionMessageSet(slotPack: SlotPack, operatorId: string): Set<string> {
    return new Set(
      slotPack.frames
        .filter((frame) => !(frame.snr === -999 && frame.operatorId === operatorId))
        .map((frame) => frame.message),
    );
  }
}
