/**
 * Decision orchestration — handles the per-operator decision pipeline,
 * message parsing, strategy invocation, and auto-call arbitration.
 *
 * Extracted from PluginManager to separate decision logic from plugin
 * lifecycle management. No reverse dependency on PluginManager.
 */
import type {
  FrameMessage,
  LogbookAnalysis,
  ParsedFT8Message,
  SlotInfo,
  SlotPack,
} from '@tx5dr/contracts';
import type {
  AutoCallExecutionPlan,
  AutoCallExecutionRequest,
  StrategyDecision,
  StrategyDecisionMeta,
} from '@tx5dr/plugin-api';
import type { AutoCallProposalResult } from './PluginHookDispatcher.js';
import { evaluateAutomaticTargetEligibility } from './AutoTargetEligibility.js';
import type { DecisionOrchestratorDeps, OperatorDecisionState } from './types.js';
import { createLogger } from '../utils/logger.js';
import { FT8MessageParser, CycleUtils } from '@tx5dr/core';

const logger = createLogger('DecisionOrchestrator');

function getParsedMessageSenderCallsign(message: ParsedFT8Message['message']): string | undefined {
  return 'senderCallsign' in message && typeof message.senderCallsign === 'string'
    ? message.senderCallsign.toUpperCase()
    : undefined;
}

function getParsedMessageGrid(message: ParsedFT8Message['message']): string | undefined {
  return 'grid' in message && typeof message.grid === 'string' && message.grid.trim().length > 0
    ? message.grid.trim().toUpperCase()
    : undefined;
}

export class DecisionOrchestrator {
  private decisionStates = new Map<string, OperatorDecisionState>();

  constructor(private deps: DecisionOrchestratorDeps) {}

  // ===== Public API =====

  async handleSlotStart(slotInfo: SlotInfo, slotPack: SlotPack | null): Promise<void> {
    for (const operator of this.deps.getOperators()) {
      const parsedMessages = slotPack
        ? await this.parseSlotPackMessages(slotPack, operator.config.id)
        : [];

      await this.deps.dispatcher.dispatchBroadcast(
        operator.config.id,
        'onSlotStart',
        (hook, ctx) => hook(slotInfo, parsedMessages, ctx),
        (instance) => this.deps.getCtxForInstance(instance),
      );

      await this.deps.dispatcher.dispatchBroadcast(
        operator.config.id,
        'onDecode',
        (hook, ctx) => hook(parsedMessages, ctx),
        (instance) => this.deps.getCtxForInstance(instance),
      );

      let automaticTargetMessages: ParsedFT8Message[] | undefined;
      if (this.isOperatorPureStandby(operator.config.id)) {
        automaticTargetMessages = await this.getFilteredAutomaticTargetMessages(
          operator.config.id,
          parsedMessages,
        );

        const autoCallProposals = await this.deps.dispatcher.dispatchAutoCallCandidates(
          operator.config.id,
          slotInfo,
          automaticTargetMessages,
          (instance) => this.deps.getCtxForInstance(instance),
        );
        await this.applyAutoCallProposal(operator.config.id, slotInfo, automaticTargetMessages, autoCallProposals);
      }

      if (!operator.isTransmitting) continue;

      const session = this.getOrCreateDecisionState(operator.config.id);
      session.lastDecisionTransmission = null;
      session.lastDecisionMessageSet = null;
      session.preDecisionEncodedTransmission = undefined;
      automaticTargetMessages ??= await this.getFilteredAutomaticTargetMessages(
        operator.config.id,
        parsedMessages,
      );
      const scored = await this.deps.dispatcher.dispatchScoreCandidates(
        operator.config.id,
        automaticTargetMessages.map((message) => ({ ...message, score: 0 })),
        (instance) => this.deps.getCtxForInstance(instance),
      );
      scored.sort((a, b) => b.score - a.score);

      let decision;
      session.decisionInProgress = true;
      try {
        decision = await this.invokeStrategyDecision(operator.config.id, scored, { isReDecision: false });
      } finally {
        session.decisionInProgress = false;
      }

      if (slotPack) {
        session.lastDecisionMessageSet = this.buildDecisionMessageSet(slotPack, operator.config.id);
      }
      session.lastDecisionTransmission = this.readCurrentTransmission(operator.config.id);
      await this.notifyQSOFailIfPresent(operator.config.id, decision);

      // 竞态检测：如果 handleEncodeStart 在决策完成前已排队了发射内容，
      // 且决策结果与之不同，触发替换编码以纠正过时的发射
      if (session.preDecisionEncodedTransmission !== undefined
          && session.lastDecisionTransmission !== null
          && session.lastDecisionTransmission !== session.preDecisionEncodedTransmission) {
        logger.info('Stale encode corrected after decision', {
          operatorId: operator.config.id,
          stale: session.preDecisionEncodedTransmission,
          correct: session.lastDecisionTransmission,
        });
        this.deps.triggerReEncode?.(operator.config.id);
      }
      session.preDecisionEncodedTransmission = undefined;

      if (decision?.stop) {
        await this.applyStrategyStop(operator.config.id);
      }
    }
  }

  handleEncodeStart(slotInfo: SlotInfo): void {
    // 用引擎当前模式的 slotMs，不要用 operator.config.mode — 后者从 operator 创建后不会更新，
    // FT8↔FT4 切换后会残留陈旧 slotMs，导致 FT4 运行期按 FT8 的 15000ms 判周期（每 15s 而不是
    // 7.5s 一次决策），奇数时隙静默跳过。
    const currentMode = this.deps.getCurrentMode();
    for (const operator of this.deps.getOperators()) {
      if (!operator.isTransmitting) continue;

      const isTransmitSlot = CycleUtils.isOperatorTransmitCycleFromMs(
        operator.getTransmitCycles(),
        slotInfo.startMs,
        currentMode.slotMs,
      );
      if (!isTransmitSlot) continue;

      const runtime = this.deps.getStrategyRuntime(operator.config.id);
      if (!runtime) continue;

      try {
        const transmission = runtime.getTransmitText();
        if (!transmission) continue;

        // 记录即将编码的内容，供 handleSlotStart 检测竞态
        const session = this.getOrCreateDecisionState(operator.config.id);
        session.preDecisionEncodedTransmission = transmission;

        this.deps.eventEmitter.emit('requestTransmit', {
          operatorId: operator.config.id,
          transmission,
        });
        this.deps.notifyTransmissionQueued(operator.config.id, transmission);
      } catch (err) {
        logger.error(`strategy runtime getTransmitText error: operator=${operator.config.id}`, err);
      }
    }
  }

  async reDecideOperator(operatorId: string, slotPack: SlotPack): Promise<boolean> {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator || !operator.isTransmitting) {
      return false;
    }

    const session = this.getOrCreateDecisionState(operatorId);
    if (session.decisionInProgress) {
      return false;
    }

    const newMessageSet = this.buildDecisionMessageSet(slotPack, operatorId);
    if (session.lastDecisionMessageSet) {
      const hasNewMessage = Array.from(newMessageSet).some((message) => !session.lastDecisionMessageSet?.has(message));
      if (!hasNewMessage) {
        return false;
      }
    }

    const parsedMessages = await this.parseSlotPackMessages(slotPack, operatorId);
    const automaticTargetMessages = await this.getFilteredAutomaticTargetMessages(
      operatorId,
      parsedMessages,
    );
    const scored = await this.deps.dispatcher.dispatchScoreCandidates(
      operatorId,
      automaticTargetMessages.map((message) => ({ ...message, score: 0 })),
      (instance) => this.deps.getCtxForInstance(instance),
    );
    scored.sort((a, b) => b.score - a.score);

    let decision: StrategyDecision | null = null;
    session.decisionInProgress = true;
    try {
      decision = await this.invokeStrategyDecision(operatorId, scored, { isReDecision: true });
    } finally {
      session.decisionInProgress = false;
    }

    await this.notifyQSOFailIfPresent(operatorId, decision);

    if (decision?.stop) {
      await this.applyStrategyStop(operatorId, { interruptActiveTransmission: true });
      return false;
    }

    session.lastDecisionMessageSet = newMessageSet;
    const newTransmission = this.readCurrentTransmission(operatorId);
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
    const runtime = this.deps.getStrategyRuntime(operatorId);
    if (!runtime) {
      return null;
    }

    try {
      return runtime.getTransmitText() ?? null;
    } catch (err) {
      logger.error(`Failed to read current transmission: operator=${operatorId}`, err);
      return null;
    }
  }

  // ===== Decision state management =====

  initDecisionState(operatorId: string): void {
    this.getOrCreateDecisionState(operatorId);
  }

  removeDecisionState(operatorId: string): void {
    this.decisionStates.delete(operatorId);
  }

  clearAllDecisionStates(): void {
    this.decisionStates.clear();
  }

  clearDecisionState(operatorId: string): void {
    this.decisionStates.set(operatorId, {
      decisionInProgress: false,
      lastDecisionTransmission: null,
      lastDecisionMessageSet: null,
    });
  }

  invalidateDecisionMessageSet(operatorId: string): void {
    const state = this.getOrCreateDecisionState(operatorId);
    state.lastDecisionMessageSet = null;
  }

  // ===== Private: Message parsing =====

  private async parseSlotPackMessages(slotPack: SlotPack, operatorId: string): Promise<ParsedFT8Message[]> {
    const LOCAL_OPERATOR_SIMULATED_SNR = 10;
    return Promise.all(slotPack.frames.map(async (frame) => {
      const parsedMessage: ParsedFT8Message = {
        message: FT8MessageParser.parseMessage(frame.message),
        snr: frame.snr === -999 && frame.operatorId === operatorId ? LOCAL_OPERATOR_SIMULATED_SNR : frame.snr,
        dt: frame.dt,
        df: frame.freq,
        rawMessage: frame.message,
        slotId: slotPack.slotId,
        timestamp: slotPack.startMs,
        logbookAnalysis: frame.logbookAnalysis,
      };

      if (frame.snr === -999) {
        return parsedMessage;
      }

      const analysis = await this.analyzeMessageForOperator(parsedMessage, operatorId);
      return {
        ...parsedMessage,
        logbookAnalysis: analysis ?? parsedMessage.logbookAnalysis,
      };
    }));
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
    return this.deps.dispatcher.dispatchFilterCandidates(
      operatorId,
      automaticTargetMessages,
      (instance) => this.deps.getCtxForInstance(instance),
    );
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

  private async invokeStrategyDecision(
    operatorId: string,
    messages: ParsedFT8Message[],
    meta: StrategyDecisionMeta,
  ): Promise<StrategyDecision | null> {
    const runtime = this.deps.getStrategyRuntime(operatorId);
    if (!runtime) {
      return null;
    }

    const result = runtime.decide(messages, meta);
    return result instanceof Promise ? await result : result;
  }

  private async notifyQSOFailIfPresent(
    operatorId: string,
    decision: StrategyDecision | null | undefined,
  ): Promise<void> {
    const failure = decision?.qsoFailure;
    if (!failure?.targetCallsign || !failure.reason) {
      return;
    }

    try {
      await this.deps.notifyQSOFail(operatorId, {
        ...failure,
        targetCallsign: failure.targetCallsign.trim().toUpperCase(),
      });
    } catch (error) {
      logger.warn(`Failed to notify QSO failure for operator ${operatorId}`, error);
    }
  }

  private async applyStrategyStop(
    operatorId: string,
    options?: { interruptActiveTransmission?: boolean },
  ): Promise<void> {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator) {
      return;
    }

    operator.stop();

    if (!options?.interruptActiveTransmission) {
      return;
    }

    try {
      await this.deps.interruptOperatorTransmission(operatorId);
    } catch (error) {
      logger.error(`Failed to interrupt active transmission after strategy stop: operator=${operatorId}`, error);
      throw error;
    }
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
  ): Promise<void> {
    if (proposals.length === 0 || !this.isOperatorPureStandby(operatorId)) {
      return;
    }

    const ranked = proposals
      .filter((entry) => this.isAutoCallProposalEligible(operatorId, entry, messages))
      .map((entry) => this.normalizeAutoCallProposal(operatorId, slotInfo, messages, entry))
      .map((entry) => ({
        ...entry,
        priority: typeof entry.proposal.priority === 'number' ? entry.proposal.priority : 0,
        messageOrder: this.resolveProposalMessageOrder(entry.proposal, messages),
      }))
      .sort((left, right) => {
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
    await this.applyAutoCallExecutionPlan(operatorId, request, executionPlan);
    this.deps.requestCall(operatorId, request.callsign, request.lastMessage);
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
      return true;
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
      await this.deps.setOperatorAudioFrequency(operatorId, requestedFrequency);
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

  // ===== Private: Decision state helpers =====

  private getOrCreateDecisionState(operatorId: string): OperatorDecisionState {
    let state = this.decisionStates.get(operatorId);
    if (!state) {
      state = {
        decisionInProgress: false,
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
