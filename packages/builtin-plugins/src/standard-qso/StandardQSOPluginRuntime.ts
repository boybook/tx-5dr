import {
    QSOContext,
    FT8MessageType,
    ParsedFT8Message,
    FT8MessageCQ,
    FT8MessageCall,
    FT8MessageSignalReport,
    FT8MessageRogerReport,
    QSORecord,
    FT8MessageRRR,
    FT8MessageFoxRR73,
    FrameMessage,
    SlotInfo,
    OperatorSlots,
    OperatorConfig,
} from '@tx5dr/contracts';
import {
    normalizeCallsign,
    type PluginLogger,
    StrategyDecision,
    StrategyDecisionMetaV2,
    StrategyDecisionResult,
    StrategyRuntime,
    StrategyRuntimeCheckpoint,
    StrategyRuntimeContext,
    StrategyRuntimeSlot,
    StrategyRuntimeSnapshot,
    StrategyRuntimeSlotContentUpdate,
    QSOFailureInfo,
} from '@tx5dr/plugin-api';
import { FT8MessageParser, isUndecodedCallsignPlaceholder } from '@tx5dr/core';

export const STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING = 'tx6MessageOverride';

export type StandardQSOOperatorConfig = OperatorConfig & {
    autoReplyToDirectCallWhenStopped?: boolean;
    skipTx1?: boolean;
    distinguishWorkedStationsByBand?: boolean;
    tx6MessageOverride?: string;
};

export function normalizeStandardQSOTx6MessageOverride(
    content: unknown,
    defaultMessage: string,
): string {
    if (typeof content !== 'string') {
        return '';
    }
    const trimmed = content.trim();
    if (!trimmed || trimmed === defaultMessage) {
        return '';
    }
    return trimmed;
}

export function buildStandardQSODefaultTx6Message(config: Pick<OperatorConfig, 'myCallsign' | 'myGrid'>): string {
    return FT8MessageParser.generateMessage({
        type: FT8MessageType.CQ,
        senderCallsign: config.myCallsign,
        grid: config.myGrid,
    });
}

/** Fallback logger that writes to console (used when no PluginLogger is provided). */
const fallbackLogger: PluginLogger = {
    debug(msg: string, data?: Record<string, unknown>) { console.debug(`[QSOStrategy] ${msg}`, data ?? ''); },
    info(msg: string, data?: Record<string, unknown>) { console.info(`[QSOStrategy] ${msg}`, data ?? ''); },
    warn(msg: string, data?: Record<string, unknown>) { console.warn(`[QSOStrategy] ${msg}`, data ?? ''); },
    error(msg: string, err?: unknown) { console.error(`[QSOStrategy] ${msg}`, err ?? ''); },
};

function callsignMatches(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) return false;
    const normalizedLeft = left.trim().toUpperCase();
    const normalizedRight = right.trim().toUpperCase();
    return normalizedLeft === normalizedRight
        || normalizeCallsign(normalizedLeft) === normalizeCallsign(normalizedRight);
}

type SlotsIndex = 'TX1' | 'TX2' | 'TX3' | 'TX4' | 'TX5' | 'TX6';

type Slots = {
    [key in SlotsIndex]: string;
}

// TX1：BD5CAM BG5DRB PL09
// TX2：BD5CAM BG5DRB -01
// TX3：BD5CAM BG5DRB R-02
// TX4：BD5CAM BG5DRB RR73
// TX5：BD5CAM BG5DRB 73
// TX6：CQ BG5DRB PL09

interface StateHandleResult {
    stop?: boolean;
    changeState?: SlotsIndex;
    silentListen?: StrategyDecision['silentListen'];
    qsoFailure?: QSOFailureInfo;
}

export interface StandardQSOPluginOperator {
    readonly config: StandardQSOOperatorConfig;
    hasWorkedCallsign(callsign: string, options?: { anyBand?: boolean }): Promise<boolean>;
    isTargetBeingWorkedByOthers(targetCallsign: string): boolean;
    notifySlotsUpdated?(slots: OperatorSlots): void;
    notifyStateChanged?(state: string): void;
}

export interface StandardQSOActivationRequest {
    callsign: string;
    lastMessage?: { message: FrameMessage; slotInfo: SlotInfo };
}

export interface StandardQSOActivationResult {
    accepted: boolean;
    lifecycleEpoch: number;
    initialSlot?: StrategyRuntimeSlot;
}

interface StandardState {
    handle(strategy: StandardQSOPluginRuntime, messages: ParsedFT8Message[]): Promise<StateHandleResult>;
    onTimeout?(strategy: StandardQSOPluginRuntime): StateHandleResult;
    onEnter?(strategy: StandardQSOPluginRuntime): void | Promise<void>;
}

function getCandidatePriorityTuple(strategy: StandardQSOPluginRuntime, candidate: ParsedFT8Message): [number, number, number] {
    const analysis = candidate.logbookAnalysis;
    const isNewDxcc = analysis?.isNewDxccEntity && analysis.dxccStatus !== 'deleted' ? 1 : 0;
    const isNewGrid = analysis?.isNewGrid ? 1 : 0;
    const isNewCallsign = analysis?.isNewCallsign ? 1 : 0;

    switch (strategy.operator.config.targetSelectionPriorityMode) {
        case 'new_callsign_first':
            return [isNewCallsign, isNewGrid, isNewDxcc];
        case 'balanced':
            return [isNewGrid, isNewDxcc, isNewCallsign];
        case 'dxcc_first':
        default:
            return [isNewDxcc, isNewGrid, isNewCallsign];
    }
}

function getCandidateScore(candidate: ParsedFT8Message): number | undefined {
    const score = (candidate as unknown as { score?: unknown }).score;
    return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}

function compareCandidates(strategy: StandardQSOPluginRuntime, left: ParsedFT8Message, right: ParsedFT8Message): number {
    const leftScore = getCandidateScore(left);
    const rightScore = getCandidateScore(right);
    if (leftScore !== undefined && rightScore !== undefined && leftScore !== rightScore) {
        return rightScore - leftScore;
    }

    if (strategy.operator.config.targetSelectionPriorityMode === 'balanced') {
        const snrDiff = right.snr - left.snr;
        if (Math.abs(snrDiff) > 3) {
            return snrDiff;
        }
    }

    const leftTuple = getCandidatePriorityTuple(strategy, left);
    const rightTuple = getCandidatePriorityTuple(strategy, right);
    for (let index = 0; index < leftTuple.length; index += 1) {
        if (leftTuple[index] !== rightTuple[index]) {
            return rightTuple[index] - leftTuple[index];
        }
    }

    if (left.snr !== right.snr) {
        return right.snr - left.snr;
    }
    const leftDf = Math.abs(left.df);
    const rightDf = Math.abs(right.df);
    if (leftDf !== rightDf) {
        return leftDf - rightDf;
    }
    return right.timestamp - left.timestamp;
}

function buildSuccessSilentListen(completedCallsign?: string): StrategyDecision['silentListen'] {
    return {
        reason: 'qso-success',
        acceptDirectedCalls: true,
        graceSlots: 2,
        excludeCallsigns: completedCallsign ? [completedCallsign] : undefined,
    };
}

async function trySwitchToDirectedCall(
    strategy: StandardQSOPluginRuntime,
    messages: ParsedFT8Message[],
    options?: {
        excludeCallsigns?: Array<string | undefined>;
        logPrefix?: string;
        clearPost73Reason?: string;
    },
): Promise<StateHandleResult | null> {
    return trySwitchToDirectedProtocol(strategy, messages, options);
}

async function trySwitchToDirectedProtocol(
    strategy: StandardQSOPluginRuntime,
    messages: ParsedFT8Message[],
    options?: {
        excludeCallsigns?: Array<string | undefined>;
        logPrefix?: string;
        clearPost73Reason?: string;
        acceptFollowUpProtocol?: boolean;
    },
): Promise<StateHandleResult | null> {
    if (strategy.hasUnsettledQSOCompletion()) {
        strategy.logger.debug(`${options?.logPrefix ?? 'direct call'}: waiting for QSO durability before starting another lifecycle`);
        return null;
    }
    const excluded = (options?.excludeCallsigns ?? [])
        .filter((callsign): callsign is string => typeof callsign === 'string' && callsign.trim().length > 0);
    const myCallsign = strategy.context.config.myCallsign;
    const directCalls = messages
        .filter((msg) => {
            if (msg.isPartialDecode) {
                return false;
            }
            const message = msg.message;
            const isInitialDirectCall = message.type === FT8MessageType.CALL
                || message.type === FT8MessageType.SIGNAL_REPORT;
            const isFollowUpProtocol = options?.acceptFollowUpProtocol === true
                && (message.type === FT8MessageType.ROGER_REPORT || message.type === FT8MessageType.RRR);
            if (!isInitialDirectCall && !isFollowUpProtocol) {
                return false;
            }
            return callsignMatches(message.targetCallsign, myCallsign)
                && !excluded.some((callsign) => callsignMatches(message.senderCallsign, callsign));
        })
        .sort((a, b) => compareCandidates(strategy, a, b));

    for (const directCall of directCalls) {
        const msg = directCall.message;
        if (
            msg.type !== FT8MessageType.CALL
            && msg.type !== FT8MessageType.SIGNAL_REPORT
            && msg.type !== FT8MessageType.ROGER_REPORT
            && msg.type !== FT8MessageType.RRR
        ) {
            continue;
        }
        const callsign = msg.senderCallsign;
        if (isUndecodedCallsignPlaceholder(callsign)) {
            strategy.logger.debug(`${options?.logPrefix ?? 'direct call'}: skipping undecoded placeholder sender ${callsign}`);
            continue;
        }
        const hasWorked = await strategy.operator.hasWorkedCallsign(callsign);
        const prefix = options?.logPrefix ?? 'direct call';

        if (hasWorked && !strategy.operator.config.replyToWorkedStations) {
            strategy.logger.debug(`${prefix}: skipping ${callsign} - already worked and replyToWorkedStations=false (SNR: ${directCall.snr})`);
            continue;
        }

        const hasConflict = strategy.operator.isTargetBeingWorkedByOthers(callsign);
        if (hasConflict) {
            strategy.logger.debug(`${prefix}: skipping ${callsign} - other operator conflict (SNR: ${directCall.snr})`);
            continue;
        }

        if (options?.clearPost73Reason) {
            strategy.clearPost73RetryContext(options.clearPost73Reason);
        }
        strategy.clearQSOContext();
        strategy.beginQsoWithTarget(callsign, `${prefix}: directed protocol handoff`);

        if (msg.type === FT8MessageType.CALL) {
            strategy.logger.debug(`${prefix}: switching to direct call ${callsign} (SNR: ${directCall.snr})`);
            const callMsg = msg as FT8MessageCall;
            // Restore grid/frequency cache, but always refresh SNR and clear stale received reports.
            strategy.restoreContext(callsign);
            if (callMsg.grid) {
                strategy.context.targetGrid = callMsg.grid;
            }
            strategy.context.reportSent = directCall.snr;
            strategy.context.reportReceived = undefined;
            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                strategy.context.actualFrequency = strategy.context.config.frequency + directCall.df;
            }
            strategy.updateSlots();
            return { changeState: 'TX2' };
        }

        if (msg.type === FT8MessageType.SIGNAL_REPORT) {
            strategy.logger.debug(`${prefix}: switching to direct signal report ${callsign} (SNR: ${directCall.snr})`);
            // Always apply the fresh report from the air message after restore.
            // Cached context may still hold a UI/default sentinel of 0.
            strategy.restoreContext(callsign);
            strategy.context.reportReceived = (msg as FT8MessageSignalReport).report;
            strategy.context.reportSent = directCall.snr;
            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                strategy.context.actualFrequency = strategy.context.config.frequency + directCall.df;
            }
            strategy.updateSlots();
            return { changeState: 'TX3' };
        }

        if (msg.type === FT8MessageType.ROGER_REPORT) {
            strategy.logger.debug(`${prefix}: resuming from direct R-report ${callsign} (SNR: ${directCall.snr})`);
            strategy.restoreContext(callsign);
            strategy.context.reportReceived = (msg as FT8MessageRogerReport).report;
            strategy.context.reportSent = directCall.snr;
            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                strategy.context.actualFrequency = strategy.context.config.frequency + directCall.df;
            }
            strategy.updateSlots();
            return { changeState: 'TX4' };
        }

        strategy.logger.debug(`${prefix}: resuming from direct RRR/RR73 ${callsign} (SNR: ${directCall.snr})`);
        strategy.restoreContext(callsign);
        strategy.updateSlots();
        return { changeState: 'TX5' };
    }

    return null;
}

const states: { [key in SlotsIndex]: StandardState } = {
    TX1: {
        async handle(strategy: StandardQSOPluginRuntime, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 【修复】优先检查当前目标呼号是否回复了，而不是先检查新呼叫
            // 这样可以确保当前QSO的连续性，避免在对方已回复时错误切换到新呼叫者
            const msgSignalReport = messages
                .filter((msg) => msg.message.type === FT8MessageType.SIGNAL_REPORT &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign) &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();
            if (msgSignalReport) {
                const msg = msgSignalReport.message as FT8MessageSignalReport;
                // 对方发来的 SIGNAL_REPORT 表示对我方的报告，应记录为我方"接收的信号报告"
                strategy.context.reportReceived = msg.report;
                // 同时预设我方准备回送给对方的报告值（常以我方测得的SNR为准）
                strategy.context.reportSent = msgSignalReport.snr;
                strategy.context.targetCallsign = msg.senderCallsign;
                // 记录实际通联频率 (基础频率 + 对方信号的频率偏移)
                // 只有当基础频率有效时（大于1MHz）才计算actualFrequency
                if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                    strategy.context.actualFrequency = strategy.context.config.frequency + msgSignalReport.df;
                }
                strategy.updateSlots();
                return {
                    changeState: 'TX3'
                }
            }

            const msgRogerReport = messages
                .filter((msg) => msg.message.type === FT8MessageType.ROGER_REPORT &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign) &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();
            if (msgRogerReport) {
                const msg = msgRogerReport.message as FT8MessageRogerReport;
                strategy.logger.debug('TX1: received ROGER_REPORT, moving to TX4');
                strategy.context.reportReceived = msg.report;
                strategy.context.reportSent = msgRogerReport.snr;
                if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                    strategy.context.actualFrequency = strategy.context.config.frequency + msgRogerReport.df;
                }
                strategy.updateSlots();
                return {
                    changeState: 'TX4'
                }
            }

            // Fox/Hound 模式：Fox 发出邀请 (PREVHOUND RR73; MYCALL <FOXHASH>)
            // 表示 Fox 已有我们之前的信号报告，邀请我们直接发 R-report
            const foxInvite = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.FOX_RR73 &&
                    callsignMatches((msg.message as FT8MessageFoxRR73).nextCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (foxInvite) {
                const foxMsg = foxInvite.message as FT8MessageFoxRR73;
                strategy.logger.debug(`TX1: Fox/Hound invite received (myCallsign=${strategy.context.config.myCallsign}, foxHash=${foxMsg.foxHash}, snrForNext=${foxMsg.snrForNext})`);
                // Fox告知的SNR作为R-report基础；降级使用本机解码SNR
                strategy.context.reportSent = foxMsg.snrForNext ?? foxInvite.snr;
                // 本机解码Fox的SNR记为reportReceived（QSO日志用）
                strategy.context.reportReceived = foxInvite.snr;
                // 记录 Fox 哈希备用
                strategy.foxHash = foxMsg.foxHash;
                strategy.updateSlots();
                return { changeState: 'TX3' };
            }

            // 【智能切换逻辑】只有当前目标没有回复时，才考虑切换到新的直接呼叫
            // 在TX1状态（刚发出呼叫，等待信号报告）时，如果收到其他人的直接呼叫，可以切换
            const directCalls = messages
                .filter((msg) =>
                    (msg.message.type === FT8MessageType.CALL ||
                     msg.message.type === FT8MessageType.SIGNAL_REPORT) &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign) &&
                    !callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign)) // 排除当前目标
                .sort((a, b) => compareCandidates(strategy, a, b));

            if (directCalls.length > 0) {
                const newCall = directCalls[0];
                const msg = newCall.message;

                // 由于filter已确保类型，这里可以安全处理
                if (msg.type === FT8MessageType.CALL) {
                    const callMsg = msg as FT8MessageCall;
                    const newCallsign = callMsg.senderCallsign;

                    // 检查是否已经通联过
                    const hasWorked = await strategy.operator.hasWorkedCallsign(newCallsign);

                    // 根据配置决定是否切换到新呼叫
                    if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                        // 检查是否有其他同呼号操作者正在通联该目标
                        const hasConflict = strategy.operator.isTargetBeingWorkedByOthers(newCallsign);

                        if (hasConflict) {
                            strategy.logger.debug(`TX1: new call ${newCallsign} conflicts with other operator working same callsign, continuing to wait for ${strategy.context.targetCallsign}`);
                        } else {
                            strategy.logger.debug(`TX1: target not replying, switching to new direct call ${newCallsign} (SNR: ${newCall.snr}dB), dropping ${strategy.context.targetCallsign}`);

                            const droppedCallsign = strategy.context.targetCallsign;
                            const qsoFailure = strategy.buildNoReplyFailure(
                                'tx1_switched_to_direct_call',
                                Math.max(1, strategy.callAttempts + 1),
                                droppedCallsign,
                            );

                            // 清空旧上下文（自动保存到缓存）
                            strategy.clearQSOContext();

                            // 切换到新呼号
                            strategy.beginQsoWithTarget(newCallsign, 'TX1 direct-call handoff');

                            // Restore grid/frequency cache, but always refresh SNR and clear stale received reports.
                            strategy.restoreContext(newCallsign);
                            if (callMsg.grid) {
                                strategy.context.targetGrid = callMsg.grid;
                            }
                            strategy.context.reportSent = newCall.snr;
                            strategy.context.reportReceived = undefined;
                            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                                strategy.context.actualFrequency = strategy.context.config.frequency + newCall.df;
                            }

                            strategy.updateSlots();
                            return { changeState: 'TX2', qsoFailure };
                        }
                    } else {
                        strategy.logger.debug(`TX1: new call ${newCallsign} already worked and replyToWorkedStations=false, continuing to wait for ${strategy.context.targetCallsign}`);
                    }
                } else if (msg.type === FT8MessageType.SIGNAL_REPORT) {
                    const reportMsg = msg as FT8MessageSignalReport;
                    const newCallsign = reportMsg.senderCallsign;

                    // 检查是否已经通联过
                    const hasWorked = await strategy.operator.hasWorkedCallsign(newCallsign);

                    // 根据配置决定是否切换到新呼叫
                    if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                        // 检查是否有其他同呼号操作者正在通联该目标
                        const hasConflict = strategy.operator.isTargetBeingWorkedByOthers(newCallsign);

                        if (hasConflict) {
                            strategy.logger.debug(`TX1: new signal report ${newCallsign} conflicts with other operator, continuing to wait for ${strategy.context.targetCallsign}`);
                        } else {
                            strategy.logger.debug(`TX1: target not replying, switching to new direct signal report ${newCallsign} (SNR: ${newCall.snr}dB), dropping ${strategy.context.targetCallsign}`);

                            const droppedCallsign = strategy.context.targetCallsign;
                            const qsoFailure = strategy.buildNoReplyFailure(
                                'tx1_switched_to_direct_signal_report',
                                Math.max(1, strategy.callAttempts + 1),
                                droppedCallsign,
                            );

                            // 清空旧上下文（自动保存到缓存）
                            strategy.clearQSOContext();

                            // 切换到新呼号
                            strategy.beginQsoWithTarget(newCallsign, 'TX1 signal-report handoff');

                            // Restore grid/frequency cache, but always take the fresh report from this message.
                            strategy.restoreContext(newCallsign);
                            strategy.context.reportReceived = reportMsg.report;
                            strategy.context.reportSent = newCall.snr;
                            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                                strategy.context.actualFrequency = strategy.context.config.frequency + newCall.df;
                            }

                            strategy.updateSlots();
                            return { changeState: 'TX3', qsoFailure };
                        }
                    } else {
                        strategy.logger.debug(`TX1: new signal report ${newCallsign} already worked and replyToWorkedStations=false, continuing to wait for ${strategy.context.targetCallsign}`);
                    }
                }
            }

            return {}
        },
        onEnter(strategy: StandardQSOPluginRuntime) {
            // 每次进入TX1时重置呼叫计数器（新的呼叫开始）
            strategy.callAttempts = 0;
            // 记录QSO开始时间
            strategy.qsoStartTime = Date.now();
        },
        onTimeout(strategy: StandardQSOPluginRuntime): StateHandleResult {
            // 增加呼叫尝试次数
            strategy.callAttempts++;

            strategy.logger.debug(`TX1 timeout: target=${strategy.context.targetCallsign}, attempts=${strategy.callAttempts}/${strategy.operator.config.maxCallAttempts}`);

            // 检查是否达到最大呼叫次数
            if (strategy.callAttempts >= strategy.operator.config.maxCallAttempts) {
                strategy.logger.debug(`TX1 timeout: max attempts (${strategy.operator.config.maxCallAttempts}) reached, giving up on ${strategy.context.targetCallsign}`);

                const qsoFailure = strategy.buildNoReplyFailure(
                    'tx1_max_call_attempts',
                    Math.max(8, strategy.operator.config.maxCallAttempts + 3, strategy.callAttempts + 3),
                );

                // 清理QSO开始时间
                strategy.qsoStartTime = undefined;

                // 清理QSO上下文
                strategy.clearQSOContext();

                // 重置呼叫计数器
                strategy.callAttempts = 0;

                // QSO失败，检查是否自动恢复CQ
                if (strategy.operator.config.autoResumeCQAfterFail) {
                    strategy.logger.debug('TX1 timeout: autoResumeCQAfterFail=true, switching to TX6');
                    return { changeState: 'TX6', qsoFailure };
                }

                strategy.logger.debug('TX1 timeout: autoResumeCQAfterFail=false, stopping');
                return { changeState: 'TX6', stop: true, qsoFailure };
            }

            // haven't reached max attempts, continue calling (keep TX1)
            strategy.logger.debug('TX1 timeout: max not reached, continuing call, staying in TX1');
            return {}; // return empty object to stay in current state, continue calling
        }
    },
    TX2: {
        async handle(strategy: StandardQSOPluginRuntime, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // first wait for standard ROGER_REPORT (R-XX)
            const msgRogerReport = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.ROGER_REPORT &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign) &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign)
                )
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msgRogerReport) {
                const msg = msgRogerReport.message as FT8MessageRogerReport;
                strategy.logger.debug('TX2: received ROGER_REPORT, moving to TX4');
                // Always take the report from the air message. A prior UI/default
                // sentinel of 0 must not block updating to the real value.
                strategy.context.reportReceived = msg.report;
                strategy.context.reportSent = msgRogerReport.snr;
                // 记录或更新实际通联频率 (基础频率 + 对方信号的频率偏移)
                // 只有当基础频率有效时（大于1MHz）才计算actualFrequency
                if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                    strategy.context.actualFrequency = strategy.context.config.frequency + msgRogerReport.df;
                }
                strategy.updateSlots();
                return {
                    changeState: 'TX4'
                }
            }

            // 【容错处理】如果对方误发送了SIGNAL_REPORT而非ROGER_REPORT，也视为确认
            // 这种情况在实际操作中可能发生（操作员误操作、软件bug等）
            const msgSignalReport = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.SIGNAL_REPORT &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign) &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign)
                )
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msgSignalReport) {
                const msg = msgSignalReport.message as FT8MessageSignalReport;
                strategy.logger.debug('TX2: fallback - received SIGNAL_REPORT instead of ROGER_REPORT, treating as confirmation, moving to TX4');
                strategy.context.reportReceived = msg.report;
                strategy.context.reportSent = msgSignalReport.snr;
                // 记录或更新实际通联频率
                if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                    strategy.context.actualFrequency = strategy.context.config.frequency + msgSignalReport.df;
                }
                strategy.updateSlots();
                return {
                    changeState: 'TX4'
                }
            }

            return {}
        },
        onEnter(strategy: StandardQSOPluginRuntime) {
            // 如果是直接从回复开始的QSO，记录开始时间
            if (!strategy.qsoStartTime) {
                strategy.qsoStartTime = Date.now();
            }
        },
        onTimeout(strategy: StandardQSOPluginRuntime): StateHandleResult {
            strategy.logger.debug(`TX2 timeout: target=${strategy.context.targetCallsign}, autoResumeCQAfterFail=${strategy.operator.config.autoResumeCQAfterFail}`);
            const qsoFailure = strategy.buildProtocolTimeoutFailure('TX2');

            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;

            // 清理QSO上下文（会调用updateSlots，清空TX1-TX5）
            strategy.clearQSOContext();

            // QSO失败，检查是否自动恢复CQ
            if (strategy.operator.config.autoResumeCQAfterFail) {
                strategy.logger.debug('TX2 timeout: autoResumeCQAfterFail=true, switching to TX6');
                return { changeState: 'TX6', qsoFailure };
            }

            strategy.logger.debug('TX2 timeout: autoResumeCQAfterFail=false, stopping');
            return { changeState: 'TX6', stop: true, qsoFailure };
        }
    },
    TX3: {
        async handle(strategy: StandardQSOPluginRuntime, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 等待对方发送RRR或73
            const msgRRR = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.RRR &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign) &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msgRRR) {
                const msg = msgRRR.message as FT8MessageRogerReport | FT8MessageSignalReport | FT8MessageRRR;
                if (msg.type === FT8MessageType.RRR) {
                    // 如果是RRR消息，直接转换到TX5
                    strategy.updateSlots();
                    return {
                        changeState: 'TX5'
                    }
                } else {
                    strategy.context.reportReceived = msg.report;
                    strategy.context.reportSent = msgRRR.snr;
                    strategy.updateSlots();
                    return {
                        changeState: 'TX5'
                    }
                }
            }

            const msg73 = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.SEVENTY_THREE &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign) &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msg73) {
                strategy.logger.debug('TX3: received 73, moving to TX5');
                strategy.updateSlots();
                return {
                    changeState: 'TX5'
                }
            }

            // Fox/Hound 模式：Fox 发送 FOX_RR73 确认我们的 QSO 完成
            // 格式：MYCALL RR73; NEXTHOUND <FOXHASH>
            const foxRR73Confirm = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.FOX_RR73 &&
                    callsignMatches((msg.message as FT8MessageFoxRR73).completedCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (foxRR73Confirm) {
                strategy.logger.debug(`TX3: Fox/Hound QSO confirmed via FOX_RR73 (myCallsign=${strategy.context.config.myCallsign})`);
                strategy.updateSlots();
                return { changeState: 'TX5' };
            }

            // 【新增】容错处理：如果对方继续发送SIGNAL_REPORT，更新信号报告
            const msgSignalReport = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.SIGNAL_REPORT &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign) &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign))
                .sort((a, b) => compareCandidates(strategy, a, b))
                .shift();  // 取第一个（SNR最高的）

            if (msgSignalReport) {
                const msg = msgSignalReport.message as FT8MessageSignalReport;
                strategy.logger.debug(`TX3: fallback - received repeated SIGNAL_REPORT (SNR: ${msgSignalReport.snr}dB), updating report`);

                strategy.context.reportReceived = msg.report;
                // 更新我方准备发送的报告（使用最新的SNR）
                strategy.context.reportSent = msgSignalReport.snr;

                // 更新实际通联频率
                if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                    strategy.context.actualFrequency = strategy.context.config.frequency + msgSignalReport.df;
                }

                strategy.updateSlots();
            }

            return {}
        },
        onTimeout(strategy: StandardQSOPluginRuntime): StateHandleResult {
            strategy.logger.debug(`TX3 timeout: target=${strategy.context.targetCallsign}, autoResumeCQAfterFail=${strategy.operator.config.autoResumeCQAfterFail}`);
            const qsoFailure = strategy.buildProtocolTimeoutFailure('TX3');

            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;

            // 清理QSO上下文
            strategy.clearQSOContext();

            // QSO失败，检查是否自动恢复CQ
            if (strategy.operator.config.autoResumeCQAfterFail) {
                strategy.logger.debug('TX3 timeout: autoResumeCQAfterFail=true, switching to TX6');
                return { changeState: 'TX6', qsoFailure };
            }

            strategy.logger.debug('TX3 timeout: autoResumeCQAfterFail=false, stopping');
            return { changeState: 'TX6', stop: true, qsoFailure };
        }
    },
    TX4: {
        onEnter(strategy: StandardQSOPluginRuntime) {
            strategy.prepareCompletedQSOEffect();
        },
        async handle(strategy: StandardQSOPluginRuntime, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 首先检查是否收到对方的73
            const msg73 = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.SEVENTY_THREE &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign) &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msg73) {
                // 对方发送了73，QSO已完成
                strategy.logger.debug('TX4: received 73, QSO complete');

                const completedCallsign = strategy.context.targetCallsign;
                const handoff = await trySwitchToDirectedCall(strategy, messages, {
                    excludeCallsigns: [completedCallsign],
                    logPrefix: 'TX4: QSO done',
                });
                if (handoff) {
                    return handoff;
                }

                // 没有新的直接呼叫，转到TX6
                strategy.logger.debug('TX4: no new direct calls, switching to TX6');
                strategy.clearQSOContext();
                if (strategy.operator.config.autoResumeCQAfterSuccess) {
                    return { changeState: 'TX6' };
                }
                return {
                    changeState: 'TX6',
                    stop: true,
                    silentListen: buildSuccessSilentListen(completedCallsign),
                };
            }

            // 其次检查是否收到对方的 RRR/RR73
            const msgRRR = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.RRR &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign) &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msgRRR) {
                // 对方也发送了 RR73，我们应该发送 73 结束通联
                strategy.updateSlots();
                return {
                    changeState: 'TX5'
                }
            }

            // 不处理新消息，等待超时后再转到TX6
            // 这样可以确保优先完成当前QSO
            return {};
        },
        onTimeout(strategy: StandardQSOPluginRuntime): StateHandleResult {
            strategy.logger.debug(`TX4 timeout: target=${strategy.context.targetCallsign}, autoResumeCQAfterFail=${strategy.operator.config.autoResumeCQAfterFail}`);
            const qsoFailure = strategy.buildProtocolTimeoutFailure('TX4');

            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;

            // 清理QSO上下文
            strategy.clearQSOContext();

            // QSO失败，检查是否自动恢复CQ
            if (strategy.operator.config.autoResumeCQAfterFail) {
                strategy.logger.debug('TX4 timeout: autoResumeCQAfterFail=true, switching to TX6');
                return { changeState: 'TX6', qsoFailure };
            }

            strategy.logger.debug('TX4 timeout: autoResumeCQAfterFail=false, stopping');
            return { changeState: 'TX6', stop: true, qsoFailure };
        }
    },
    TX5: {
        onEnter(strategy: StandardQSOPluginRuntime) {
            strategy.prepareCompletedQSOEffect();
        },
        async handle(strategy: StandardQSOPluginRuntime, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 【修复】首先检查是否收到对方重发的RRR/RR73
            // 如果对方没收到我们的73，会重新发送RRR，我们应该保持在TX5状态继续发送73
            const msgRRR = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.RRR &&
                    callsignMatches(msg.message.senderCallsign, strategy.context.targetCallsign) &&
                    callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign))
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msgRRR) {
                // 对方没收到我们的73，重新发送了RRR
                // 保持在TX5状态，下个周期再次发送73
                strategy.logger.debug('TX5: received retransmitted RRR, staying in TX5 to resend 73');
                return {}; // 保持当前状态，不转换
            }

            if (!strategy.tx5TransmissionQueued) {
                strategy.logger.debug('TX5: 73 has not been queued yet, staying in TX5');
                return {};
            }

            // 发送1次73后，检查是否有新的直接呼叫；否则转到TX6或静默停止。
            const completedCallsign = strategy.context.targetCallsign;
            const handoff = await trySwitchToDirectedCall(strategy, messages, {
                excludeCallsigns: [completedCallsign],
                logPrefix: 'TX5',
                clearPost73Reason: 'switching to new direct call from TX5',
            });
            if (handoff) {
                return handoff;
            }

            // 没有新的直接呼叫，按配置决定是否恢复到CQ或停止
            if (strategy.operator.config.autoResumeCQAfterSuccess) {
                strategy.armPost73RetryContext();
            } else {
                strategy.clearPost73RetryContext('success stop after single 73');
            }
            strategy.clearQSOContext();
            if (strategy.operator.config.autoResumeCQAfterSuccess) {
                return { changeState: 'TX6' };
            }
            return {
                changeState: 'TX6',
                stop: true,
                silentListen: buildSuccessSilentListen(completedCallsign),
            };
        },
        onTimeout(strategy: StandardQSOPluginRuntime): StateHandleResult {
            strategy.logger.debug(`TX5 timeout: target=${strategy.context.targetCallsign}, autoResumeCQAfterSuccess=${strategy.operator.config.autoResumeCQAfterSuccess}`);

            if (!strategy.tx5TransmissionQueued) {
                strategy.logger.debug('TX5 timeout: 73 has not been queued yet, staying in TX5');
                return {};
            }

            const completedCallsign = strategy.context.targetCallsign;

            // 清理QSO上下文
            if (strategy.operator.config.autoResumeCQAfterSuccess) {
                strategy.armPost73RetryContext();
            } else {
                strategy.clearPost73RetryContext('success timeout stop');
            }
            strategy.clearQSOContext();

            // TX5超时表示QSO已成功（已记录日志），对方没有回复73
            // 检查是否自动恢复CQ
            if (strategy.operator.config.autoResumeCQAfterSuccess) {
                strategy.logger.debug('TX5 timeout: autoResumeCQAfterSuccess=true, switching to TX6');
                return { changeState: 'TX6' };
            }

            strategy.logger.debug('TX5 timeout: autoResumeCQAfterSuccess=false, stopping');
            return {
                changeState: 'TX6',
                stop: true,
                silentListen: buildSuccessSilentListen(completedCallsign),
            };
        }
    },
    TX6: {
        async handle(strategy: StandardQSOPluginRuntime, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            const retryContext = strategy.getActivePost73RetryContext();
            if (retryContext) {
                const retryRRR = messages
                    .filter((msg) =>
                        msg.message.type === FT8MessageType.RRR &&
                        callsignMatches(msg.message.senderCallsign, retryContext.targetCallsign) &&
                        callsignMatches(msg.message.targetCallsign, strategy.context.config.myCallsign))
                    .sort((a, b) => a.snr - b.snr)
                    .pop();

                if (retryRRR) {
                    strategy.logger.debug(`TX6: resuming post-73 retry for ${retryContext.targetCallsign}`);
                    strategy.restorePost73RetryContext(retryContext);
                    strategy.clearPost73RetryContext('resumed into TX5');
                    return { changeState: 'TX5' };
                }
            }

            // 收集所有CQ消息（部分解码的 `CQ <...>` 不参与回复）
            const cqCalls = messages
                .filter((msg) =>
                    !msg.isPartialDecode &&
                    msg.message.type === FT8MessageType.CQ &&
                    strategy.operator.config.autoReplyToCQ)
                .sort((a, b) => a.snr - b.snr);

            // 优先处理直接呼叫 - 遍历所有直接呼叫，找到第一个没有冲突的
            const directHandoff = await trySwitchToDirectedProtocol(strategy, messages, {
                logPrefix: 'TX6',
                acceptFollowUpProtocol: true,
            });
            if (directHandoff) {
                return directHandoff;
            }

            // 其次处理CQ呼叫
            if (cqCalls.length > 0) {
                // 始终按信号强度从高到低排序，遍历找到第一个未通联过的电台
                const sortedCalls = cqCalls.sort((a, b) => compareCandidates(strategy, a, b));

                for (const cqCall of sortedCalls) {
                    const msg = cqCall.message as FT8MessageCQ;
                    const callsign = msg.senderCallsign;
                    if (isUndecodedCallsignPlaceholder(callsign)) {
                        strategy.logger.debug(`TX6: skipping CQ from undecoded placeholder ${callsign}`);
                        continue;
                    }

                    try {
                        // 检查是否已经通联过
                        const hasWorked = await strategy.operator.hasWorkedCallsign(callsign);

                        // CQ呼叫只回复未通联过的电台(不受replyToWorkedStations配置影响)
                        if (!hasWorked) {
                            // 检查是否有其他同呼号操作者正在通联该目标
                            const hasConflict = strategy.operator.isTargetBeingWorkedByOthers(callsign);

                            if (hasConflict) {
                                strategy.logger.debug(`TX6: skipping CQ from ${callsign} - other operator conflict (SNR: ${cqCall.snr}dB)`);
                                continue; // 跳过这个CQ，继续遍历下一个
                            }

                            strategy.logger.debug(`TX6: replying to CQ from ${callsign} (not worked, SNR: ${cqCall.snr}dB, by signal strength)`);
                            if (strategy.hasUnsettledQSOCompletion()) {
                                strategy.logger.debug(`TX6: delaying CQ reply to ${callsign} until QSO durability settles`);
                                continue;
                            }
                            strategy.beginQsoWithTarget(callsign, 'TX6 CQ reply');

                            // Restore grid/frequency cache, but always refresh SNR and clear stale received reports.
                            strategy.restoreContext(callsign);
                            if (msg.grid) {
                                strategy.context.targetGrid = msg.grid;
                            }
                            strategy.context.reportSent = cqCall.snr;
                            strategy.context.reportReceived = undefined;
                            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                                strategy.context.actualFrequency = strategy.context.config.frequency + cqCall.df;
                            }

                            strategy.updateSlots();
                            return { changeState: strategy.getInitialOutboundCallState() };
                        } else {
                            strategy.logger.debug(`TX6: skipping CQ from ${callsign} - already worked (SNR: ${cqCall.snr})`);
                        }
                    } catch (error) {
                        strategy.logger.error(`TX6: failed to check callsign ${callsign}:`, error);
                        // 如果检查失败，跳过这个呼号
                        continue;
                    }
                }
            } 

            return {};
        }
    }
}

// QSO上下文历史缓存数据结构
interface CachedQSOContext {
    targetGrid?: string;
    reportSent?: number;
    reportReceived?: number;
    actualFrequency?: number;
    lastUpdated: number;
}

interface Post73RetryContext {
    targetCallsign: string;
    targetGrid?: string;
    reportSent?: number;
    reportReceived?: number;
    actualFrequency?: number;
    completedQSO?: QSORecord;
    expiresAt: number;
}

interface StandardQSOCheckpoint {
    state: SlotsIndex;
    slots: Slots;
    context: Omit<QSOContext, 'config'>;
    tx6MessageOverride: string;
    lastConfigTx6MessageOverride?: string;
    timeoutCycles: number;
    callAttempts: number;
    qsoStartTime?: number;
    tx5TransmissionQueued: boolean;
    completedQSORecord?: QSORecord;
    pendingQSOCompletion?: {
        record: QSORecord;
        lifecycleEpoch: number;
    };
    qsoLifecycleEpoch: number;
    post73RetryContext?: Post73RetryContext;
    qsoContextHistory: Array<[string, CachedQSOContext]>;
    foxHash?: string;
}

export class StandardQSOPluginRuntime implements StrategyRuntime {
    public readonly operator: StandardQSOPluginOperator;
    private state: SlotsIndex = 'TX6';
    private slots: Slots = {
        TX1: '',
        TX2: '',
        TX3: '',
        TX4: '',
        TX5: '',
        TX6: '',
    };
    private _context: QSOContext;
    private tx6MessageOverride = '';
    private lastConfigTx6MessageOverride: string | undefined;
    private timeoutCycles: number = 0;
    public callAttempts: number = 0; // 呼叫尝试次数计数器（TX1状态专用）
    public qsoStartTime?: number; // QSO开始时间
    public tx5TransmissionQueued = false;
    private completedQSORecord?: QSORecord;
    private pendingQSOCompletion?: {
        record: QSORecord;
        lifecycleEpoch: number;
    };
    private qsoLifecycleEpoch = 0;
    private speculativeDecisionDepth = 0;
    public post73RetryContext?: Post73RetryContext;

    // QSO上下文历史缓存（呼号 -> 上下文）
    private qsoContextHistory = new Map<string, CachedQSOContext>();
    // 最大缓存数量，避免内存泄漏
    private readonly MAX_CONTEXT_CACHE = 100;
    // Fox/Hound 模式：记录 Fox 的哈希码
    public foxHash?: string;

    readonly logger: PluginLogger;

    constructor(operator: StandardQSOPluginOperator, logger?: PluginLogger) {
        this.operator = operator;
        this.logger = logger ?? fallbackLogger;
        this._context = {
            config: operator.config
        }
        this.updateSlots();
    }

    private syncOperatorConfig(): void {
        const nextConfig = this.operator.config;
        const previousConfig = this._context.config;
        const nextDefaultTx6Message = buildStandardQSODefaultTx6Message(nextConfig);
        const hasConfigTx6MessageOverride = Object.prototype.hasOwnProperty.call(nextConfig, STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING);
        const nextConfigTx6MessageOverride = hasConfigTx6MessageOverride
            ? normalizeStandardQSOTx6MessageOverride(nextConfig.tx6MessageOverride, nextDefaultTx6Message)
            : undefined;
        const nextTx6MessageOverride = hasConfigTx6MessageOverride && nextConfigTx6MessageOverride !== this.lastConfigTx6MessageOverride
            ? nextConfigTx6MessageOverride ?? ''
            : this.tx6MessageOverride;
        const shouldRegenerateSlots =
            previousConfig.myCallsign !== nextConfig.myCallsign ||
            previousConfig.myGrid !== nextConfig.myGrid ||
            this.tx6MessageOverride !== nextTx6MessageOverride;

        this._context = {
            ...this._context,
            config: nextConfig,
        };
        this.tx6MessageOverride = nextTx6MessageOverride;
        if (hasConfigTx6MessageOverride) {
            this.lastConfigTx6MessageOverride = nextConfigTx6MessageOverride ?? '';
        }

        if (shouldRegenerateSlots) {
            this.updateSlots();
        }
    }

    get context(): QSOContext {
        this.syncOperatorConfig();
        return this._context;
    }

    public buildNoReplyFailure(
        reason: string,
        unansweredTransmissions: number,
        targetCallsign = this.context.targetCallsign,
    ): QSOFailureInfo | undefined {
        if (!targetCallsign) {
            return undefined;
        }

        return {
            targetCallsign,
            reason,
            stage: 'TX1',
            unansweredTransmissions,
            hadTargetReply: false,
        };
    }

    public buildProtocolTimeoutFailure(stage: 'TX2' | 'TX3' | 'TX4'): QSOFailureInfo | undefined {
        const targetCallsign = this.context.targetCallsign;
        if (!targetCallsign) return undefined;
        return {
            targetCallsign,
            reason: `${stage.toLowerCase()}_timeout`,
            stage,
            hadTargetReply: true,
        };
    }

    async changeState(state: SlotsIndex): Promise<void> {
        const oldState = this.state;
        this.state = state;
        this.timeoutCycles = 0;

        this.tx5TransmissionQueued = false;

        if (state === 'TX1' || state === 'TX2' || state === 'TX3' || state === 'TX4') {
            this.clearPost73RetryContext(`state changed to ${state}`);
        }

        // 从TX1转换到其他状态时，重置呼叫计数器（表示已成功建立通联）
        if (oldState === 'TX1' && state !== 'TX1') {
            this.callAttempts = 0;
        }

        // 状态变化时通知槽位更新
        if (oldState !== this.state) {
            this.notifyStateChanged();
        }

        // 调用新状态的onEnter
        const newState = states[this.state];
        if (newState.onEnter) {
            await newState.onEnter(this);
        }
    }

    prepareCompletedQSOEffect(): void {
        if (this.completedQSORecord || !this.context.targetCallsign) {
            return;
        }

        const now = Date.now();
        const frequency = (this.context.actualFrequency && this.context.actualFrequency > 1_000_000)
            ? this.context.actualFrequency
            : (this.context.config.frequency || 0);
        const record: QSORecord = {
            id: now.toString(),
            callsign: this.context.targetCallsign,
            grid: this.context.targetGrid,
            frequency,
            mode: this.context.config.mode.name,
            startTime: this.qsoStartTime || now,
            endTime: now,
            reportSent: this.context.reportSent?.toString(),
            reportReceived: this.context.reportReceived?.toString(),
            messageHistory: [],
            comment: undefined,
            myCallsign: this.context.config.myCallsign,
            myGrid: this.context.config.myGrid,
        };
        this.completedQSORecord = record;
        this.pendingQSOCompletion = {
            record,
            lifecycleEpoch: this.qsoLifecycleEpoch,
        };
    }

    private beginQsoLifecycle(reason: string): void {
        this.qsoLifecycleEpoch += 1;
        this.completedQSORecord = undefined;
        this.logger.debug('Started QSO lifecycle', {
            epoch: this.qsoLifecycleEpoch,
            reason,
        });
    }

    hasUnsettledQSOCompletion(): boolean {
        return this.completedQSORecord !== undefined;
    }

    beginQsoWithTarget(callsign: string, reason: string): void {
        if (!callsignMatches(callsign, this.context.targetCallsign)) {
            this.beginQsoLifecycle(reason);
        }
        this.context.targetCallsign = callsign;
    }

    settleQSOCompletion(settlement: import('@tx5dr/plugin-api').StrategyQSOCompletionSettlement): void {
        if (settlement.lifecycleEpoch !== this.qsoLifecycleEpoch
            || settlement.recordId !== this.completedQSORecord?.id) {
            this.logger.debug('Ignored stale QSO completion settlement', {
                currentEpoch: this.qsoLifecycleEpoch,
                settledEpoch: settlement.lifecycleEpoch,
                recordId: settlement.recordId,
                status: settlement.status,
            });
            return;
        }
        if (settlement.status === 'committed') {
            this.completedQSORecord = undefined;
        }
    }

    async handleReceivedAndDicideNext(messages: ParsedFT8Message[], options?: { isReDecision?: boolean }): Promise<StrategyDecision> {
        const currentState = states[this.state];

        // 过滤掉发送者是我自己的消息；部分解码消息（含 `<...>` 占位符）绝不参与 QSO 决策
        const filteredMessages = messages.filter((msg) => !msg.isPartialDecode && (msg.message.type == FT8MessageType.CUSTOM || msg.message.type == FT8MessageType.UNKNOWN || msg.message.type == FT8MessageType.FOX_RR73 || !callsignMatches(msg.message.senderCallsign, this.operator.config.myCallsign)));

        // 处理接收到的消息
        const result = await currentState.handle(this, filteredMessages);

        // 如果状态需要改变
        if (result.changeState) {
            /* if (result.changeState !== 'TX6') {
                this.operator.start();  // 启动发射
            } */
            try {
                await this.changeState(result.changeState);
            } catch {
                return { stop: true };
            }
        } else if (!options?.isReDecision) {
            // 增加超时计数（重决策时跳过，避免虚假超时累加）
            this.timeoutCycles++;
            // 检查是否超时
            if (this.timeoutCycles >= this.operator.config.maxQSOTimeoutCycles) {
                this.logger.debug(`Timeout count reached limit (${this.timeoutCycles}/${this.operator.config.maxQSOTimeoutCycles}), state=${this.state}, triggering timeout handler`);
                if (currentState.onTimeout) {
                    const timeoutResult = currentState.onTimeout(this);
                    this.logger.debug('Timeout handler result:', { ...timeoutResult });

                    // 使用 changeState() 方法进行状态转换，确保完整的状态转换流程
                    if (timeoutResult.changeState) {
                        this.logger.debug(`State transition after timeout: ${this.state} -> ${timeoutResult.changeState}`);
                        try {
                            await this.changeState(timeoutResult.changeState);
                        } catch {
                            return { stop: true };
                        }
                    }
                    if (timeoutResult.stop) {
                        this.logger.debug('Stopping operator after timeout');
                        return {
                            stop: true,
                            silentListen: timeoutResult.silentListen,
                            qsoFailure: timeoutResult.qsoFailure,
                        };
                    }
                    if (timeoutResult.qsoFailure) {
                        return {
                            qsoFailure: timeoutResult.qsoFailure,
                        };
                    }
                }
            }
        }

        return {
            stop: result.stop,
            silentListen: result.silentListen,
            qsoFailure: result.qsoFailure,
        };
    }

    handleTransmitSlot(): string | null {
        return this.slots[this.state];
    }

    onTransmissionQueued(transmission: string): void {
        // The host invokes this compatibility hook only after the physical
        // frame reaches terminal success, never when encoding is merely queued.
        if (this.state === 'TX5' && transmission === this.slots.TX5) {
            this.tx5TransmissionQueued = true;
        }
    }

    getInitialOutboundCallState(): SlotsIndex {
        return this.operator.config.skipTx1 === true ? 'TX2' : 'TX1';
    }

    activateTarget(request: StandardQSOActivationRequest): StandardQSOActivationResult {
        const accepted = this.requestCallInternal(request.callsign, request.lastMessage);
        return {
            accepted,
            lifecycleEpoch: this.qsoLifecycleEpoch,
            initialSlot: accepted ? this.state : undefined,
        };
    }

    requestCall(callsign: string, lastMessage: { message: FrameMessage, slotInfo: SlotInfo } | undefined): boolean {
        return this.activateTarget({ callsign, lastMessage }).accepted;
    }

    private requestCallInternal(callsign: string, lastMessage: { message: FrameMessage, slotInfo: SlotInfo } | undefined): boolean {
        if (this.hasUnsettledQSOCompletion()) {
            this.logger.warn('requestCall ignored while QSO durability is unsettled', { callsign });
            return false;
        }
        this.syncOperatorConfig();
        if (!this.canAcceptTargetCallsign(callsign, 'requestCall')) {
            return false;
        }
        this.logger.debug(`requestCall: myCallsign=${this.operator.config.myCallsign}, target=${callsign}`, lastMessage);
        this.clearPost73RetryContext('manual requestCall');
        if (!lastMessage) {
            this.beginQsoWithTarget(callsign, 'manual requestCall');
            this.updateSlots();
            this.changeStateSafely(this.getInitialOutboundCallState());  // 呼叫他
            return true;
        }
        this.beginQsoWithTarget(callsign, 'manual requestCall with decoded message');
        this.context.reportSent = lastMessage.message.snr;
        const msg = FT8MessageParser.parseMessage(lastMessage.message.message);
        const parsedMessage: ParsedFT8Message = {
            message: msg,
            snr: lastMessage.message.snr,
            dt: lastMessage.message.dt,
            df: lastMessage.message.freq,
            rawMessage: lastMessage.message.message,
            slotId: lastMessage.slotInfo.id,
            timestamp: lastMessage.slotInfo.startMs
        }
        if (msg.type === FT8MessageType.UNKNOWN || msg.type === FT8MessageType.CUSTOM) {
            this.updateSlots();
            this.changeStateSafely(this.getInitialOutboundCallState());  // 呼叫他
            return true;
        }
        // 包含 targetCallsign 的消息
        if (msg.type === FT8MessageType.SIGNAL_REPORT || msg.type === FT8MessageType.CALL || msg.type === FT8MessageType.ROGER_REPORT || msg.type === FT8MessageType.RRR || msg.type === FT8MessageType.SEVENTY_THREE) {
            if (callsignMatches(msg.targetCallsign, this._context.config.myCallsign)) {
                // 消息是发给我的，直接转到对应的回复状态
                if (msg.type === FT8MessageType.CALL) {
                    // 对方呼叫我，回复信号报告
                    const callMsg = msg as FT8MessageCall;
                    this.context.targetGrid = callMsg.grid;
                    // 记录实际通联频率
                    if (this.context.config.frequency && this.context.config.frequency > 1000000) {
                        this.context.actualFrequency = this.context.config.frequency + parsedMessage.df;
                    }
                    this.updateSlots();
                    this.changeStateSafely('TX2');  // 下周期发送 SIGNAL_REPORT
                    this.logger.debug('requestCall: received CALL, switching to TX2');
                } else if (msg.type === FT8MessageType.SIGNAL_REPORT) {
                    // 对方发了信号报告，回复 ROGER_REPORT
                    const reportMsg = msg as FT8MessageSignalReport;
                    this.context.reportReceived = reportMsg.report;
                    // 记录实际通联频率
                    if (this.context.config.frequency && this.context.config.frequency > 1000000) {
                        this.context.actualFrequency = this.context.config.frequency + parsedMessage.df;
                    }
                    this.updateSlots();
                    this.changeStateSafely('TX3');  // 下周期发送 ROGER_REPORT
                    this.logger.debug('requestCall: received SIGNAL_REPORT, switching to TX3');
                } else if (msg.type === FT8MessageType.ROGER_REPORT) {
                    // 对方发了 ROGER_REPORT，回复 RR73
                    const rogerMsg = msg as FT8MessageRogerReport;
                    // Always take the report from the air message.
                    this.context.reportReceived = rogerMsg.report;
                    // 记录实际通联频率
                    if (this.context.config.frequency && this.context.config.frequency > 1000000) {
                        this.context.actualFrequency = this.context.config.frequency + parsedMessage.df;
                    }
                    this.updateSlots();
                    this.changeStateSafely('TX4');  // 下周期发送 RR73
                    this.logger.debug('requestCall: received ROGER_REPORT, switching to TX4');
                } else if (msg.type === FT8MessageType.RRR) {
                    // 对方发了 RRR，回复 73
                    this.updateSlots();
                    this.changeStateSafely('TX5');  // 下周期发送 73
                    this.logger.debug('requestCall: received RRR, switching to TX5');
                } else if (msg.type === FT8MessageType.SEVENTY_THREE) {
                    // 对方发了 73，QSO 完成，转到待机
                    this.updateSlots();
                    this.changeStateSafely('TX6');  // 待机
                    this.logger.debug('requestCall: received 73, switching to TX6 (standby)');
                }
                // 不再调用 handleReceivedAndDicideNext，避免状态机二次处理
                return true;
            } else {
                // 和我无关，那么就正常CQ他
                this.updateSlots();
                this.changeStateSafely(this.getInitialOutboundCallState());  // 呼叫他
            }
            return true;
        }
        // 不包含 targetCallsign 的消息
        this.updateSlots();
        this.changeStateSafely(this.getInitialOutboundCallState());  // 呼叫他
        return true;
    }

    checkpoint(): StrategyRuntimeCheckpoint {
        const { config: _config, ...context } = this._context;
        const checkpoint: StandardQSOCheckpoint = {
            state: this.state,
            slots: { ...this.slots },
            context: { ...context },
            tx6MessageOverride: this.tx6MessageOverride,
            lastConfigTx6MessageOverride: this.lastConfigTx6MessageOverride,
            timeoutCycles: this.timeoutCycles,
            callAttempts: this.callAttempts,
            qsoStartTime: this.qsoStartTime,
            tx5TransmissionQueued: this.tx5TransmissionQueued,
            completedQSORecord: this.completedQSORecord ? { ...this.completedQSORecord } : undefined,
            pendingQSOCompletion: this.pendingQSOCompletion ? {
                lifecycleEpoch: this.pendingQSOCompletion.lifecycleEpoch,
                record: { ...this.pendingQSOCompletion.record },
            } : undefined,
            qsoLifecycleEpoch: this.qsoLifecycleEpoch,
            post73RetryContext: this.post73RetryContext ? { ...this.post73RetryContext } : undefined,
            qsoContextHistory: Array.from(this.qsoContextHistory.entries(), ([callsign, cached]) => [
                callsign,
                { ...cached },
            ]),
            foxHash: this.foxHash,
        };
        return checkpoint;
    }

    restore(checkpoint: StrategyRuntimeCheckpoint): void {
        if (!checkpoint || typeof checkpoint !== 'object') {
            throw new Error('Invalid Standard QSO strategy checkpoint');
        }
        const state = checkpoint as StandardQSOCheckpoint;
        if (!Object.prototype.hasOwnProperty.call(states, state.state)) {
            throw new Error(`Invalid Standard QSO strategy checkpoint state: ${String(state.state)}`);
        }

        this.state = state.state;
        this.slots = { ...state.slots };
        this._context = {
            config: this.operator.config,
            ...state.context,
        };
        this.tx6MessageOverride = state.tx6MessageOverride;
        this.lastConfigTx6MessageOverride = state.lastConfigTx6MessageOverride;
        this.timeoutCycles = state.timeoutCycles;
        this.callAttempts = state.callAttempts;
        this.qsoStartTime = state.qsoStartTime;
        this.tx5TransmissionQueued = state.tx5TransmissionQueued;
        this.completedQSORecord = state.completedQSORecord ? { ...state.completedQSORecord } : undefined;
        this.pendingQSOCompletion = state.pendingQSOCompletion ? {
            lifecycleEpoch: state.pendingQSOCompletion.lifecycleEpoch,
            record: { ...state.pendingQSOCompletion.record },
        } : undefined;
        this.qsoLifecycleEpoch = state.qsoLifecycleEpoch;
        this.post73RetryContext = state.post73RetryContext ? { ...state.post73RetryContext } : undefined;
        this.qsoContextHistory = new Map(
            state.qsoContextHistory.map(([callsign, cached]) => [callsign, { ...cached }]),
        );
        this.foxHash = state.foxHash;
    }

    async decide(messages: ParsedFT8Message[], meta: StrategyDecisionMetaV2): Promise<StrategyDecisionResult> {
        this.syncOperatorConfig();
        if (meta.signal.aborted) {
            throw new DOMException('Strategy decision aborted', 'AbortError');
        }

        this.speculativeDecisionDepth += 1;
        try {
            const decision = await this.handleReceivedAndDicideNext(messages, {
                isReDecision: meta.isReDecision,
            });
            if (meta.signal.aborted) {
                throw new DOMException('Strategy decision aborted', 'AbortError');
            }

            const qsoCompletion = this.pendingQSOCompletion
                ? {
                    lifecycleEpoch: this.pendingQSOCompletion.lifecycleEpoch,
                    record: { ...this.pendingQSOCompletion.record },
                }
                : undefined;
            this.pendingQSOCompletion = undefined;
            return {
                ...decision,
                transmission: this.handleTransmitSlot(),
                snapshot: this.getSnapshot(),
                qsoCompletion,
            };
        } finally {
            this.speculativeDecisionDepth -= 1;
        }
    }

    getTransmitText(): string | null {
        this.syncOperatorConfig();
        return this.handleTransmitSlot();
    }

    getIdleCQText(): string | null {
        this.syncOperatorConfig();
        if (this.state !== 'TX6'
            || this.context.targetCallsign
            || this.hasUnsettledQSOCompletion()) {
            return null;
        }
        return this.slots.TX6 || null;
    }

    getSnapshot(): StrategyRuntimeSnapshot {
        this.syncOperatorConfig();
        return {
            currentState: this.state,
            slots: this.getSlots(),
            context: {
                targetCallsign: this.context.targetCallsign,
                targetGrid: this.context.targetGrid,
                reportSent: this.context.reportSent,
                reportReceived: this.context.reportReceived,
                actualFrequency: this.context.actualFrequency,
            },
            availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6'],
            qsoLifecycleEpoch: this.qsoLifecycleEpoch,
        };
    }

    patchContext(patch: Partial<StrategyRuntimeContext>): void {
        this.syncOperatorConfig();
        if (patch.targetCallsign && !this.canAcceptTargetCallsign(patch.targetCallsign, 'patchContext')) {
            return;
        }
        if (patch.targetCallsign
            && !callsignMatches(patch.targetCallsign, this._context.targetCallsign)) {
            this.beginQsoLifecycle('context target changed');
        }
        const next: QSOContext = {
            ...this._context,
        };
        if (patch.targetCallsign !== undefined) next.targetCallsign = patch.targetCallsign;
        if (patch.targetGrid !== undefined) next.targetGrid = patch.targetGrid;
        if (patch.actualFrequency !== undefined) {
            next.actualFrequency = patch.actualFrequency ?? undefined;
        }
        // The Host preserves an explicit undefined property to mean "clear".
        if (Object.prototype.hasOwnProperty.call(patch, 'reportSent')) {
            next.reportSent = patch.reportSent;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'reportReceived')) {
            next.reportReceived = patch.reportReceived;
        }
        this._context = next;

        const needsSlotUpdate =
            patch.targetCallsign !== undefined ||
            patch.targetGrid !== undefined ||
            Object.prototype.hasOwnProperty.call(patch, 'reportSent') ||
            Object.prototype.hasOwnProperty.call(patch, 'reportReceived');

        if (needsSlotUpdate) {
            this.updateSlots();
        }
    }

    private canAcceptTargetCallsign(callsign: string, operation: 'requestCall' | 'patchContext'): boolean {
        if (isUndecodedCallsignPlaceholder(callsign)) {
            this.logger.warn(`${operation}: refusing undecoded placeholder callsign ${callsign}`);
            return false;
        }
        if (callsignMatches(callsign, this.operator.config.myCallsign)) {
            this.logger.warn(`${operation}: refusing own callsign as target ${callsign}`);
            return false;
        }
        return true;
    }

    setState(state: SlotsIndex): void {
        this.syncOperatorConfig();
        const oldState = this.state;
        // Audit anomaly: external setState that aborts an active QSO by jumping to TX6.
        // Triggered intentionally only when:
        //   - state actually changes
        //   - we were in an active QSO state (TX1..TX5)
        //   - we have a target callsign (i.e. mid-conversation)
        //   - the new state is TX6 (the abort destination)
        // This narrowly targets the "BG5DRB premature CQ" incident pattern and
        // avoids noise from normal slot dropdown moves between TX1..TX5.
        if (
            oldState !== state &&
            oldState !== 'TX6' &&
            this.context.targetCallsign &&
            state === 'TX6'
        ) {
            this.logger.warn('External setState aborts active QSO', {
                from: oldState,
                to: state,
                targetCallsign: this.context.targetCallsign,
                timeoutCycles: this.timeoutCycles,
                reportSent: this.context.reportSent ?? null,
                reportReceived: this.context.reportReceived ?? null,
            });
        }
        this.state = state;
        this.tx5TransmissionQueued = false;
        if (state !== 'TX6') {
            this.clearPost73RetryContext(`manual set_state ${state}`);
        }
        if (oldState !== this.state) {
            this.notifyStateChanged();
        }
    }

    setSlotContent(update: StrategyRuntimeSlotContentUpdate): void {
        const { slot, content } = update;
        if (!Object.prototype.hasOwnProperty.call(this.slots, slot)) {
            throw new Error(`Invalid slot: ${slot}`);
        }
        if (slot === 'TX6') {
            const defaultMessage = buildStandardQSODefaultTx6Message(this.operator.config);
            this.tx6MessageOverride = normalizeStandardQSOTx6MessageOverride(content, defaultMessage);
            this.slots.TX6 = this.tx6MessageOverride || defaultMessage;
            this.notifySlotsUpdated();
            return;
        }
        this.slots[slot as SlotsIndex] = content || '';
        this.notifySlotsUpdated();
    }

    reset(reason?: string): void {
        this.resetRuntime(reason);
    }
    
    /**
     * 获取当前所有时隙的内容
     */
    getSlots(): Slots {
        return { ...this.slots };
    }
    
    /**
     * 获取当前状态
     */
    getCurrentState(): SlotsIndex {
        return this.state;
    }

    private updateTargetSlotsForSpecialCallsign(targetCallsign: string): void {
        const report = this.context.reportSent || 0;
        const wrappedTarget = `<${targetCallsign}>`;
        const myCallsign = this.operator.config.myCallsign;
        const reportText = FT8MessageParser.generateSignalReport(report);
        const gridCall = {
            type: FT8MessageType.CALL,
            senderCallsign: myCallsign,
            targetCallsign,
            grid: this.context.config.myGrid,
        } as const;
        const signalReport = {
            type: FT8MessageType.SIGNAL_REPORT,
            senderCallsign: myCallsign,
            targetCallsign,
            report,
        } as const;

        this.slots.TX1 = FT8MessageParser.generateMessage(gridCall);
        this.slots.TX2 = FT8MessageParser.generateMessage(signalReport);
        // WSJT-X pack77 accepts hashed nonstandard-call structured replies, including RR73.
        this.slots.TX3 = `${wrappedTarget} ${myCallsign} R${reportText}`;
        this.slots.TX4 = `${wrappedTarget} ${myCallsign} RR73`;
        this.slots.TX5 = `${wrappedTarget} ${myCallsign} 73`;
    }
    
    updateSlots() {
        // 防御：占位符目标绝不生成发射槽位（避免把 `...` 包成 `<...>` 上射频）
        if (this.context.targetCallsign && isUndecodedCallsignPlaceholder(this.context.targetCallsign)) {
            this.slots.TX1 = '';
            this.slots.TX2 = '';
            this.slots.TX3 = '';
            this.slots.TX4 = '';
            this.slots.TX5 = '';
            this.notifySlotsUpdated();
            return;
        }
        if (this.context.targetCallsign) {
            if (FT8MessageParser.isStandardCallsign(this.context.targetCallsign)) {
                this.slots.TX1 = FT8MessageParser.generateMessage({
                    type: FT8MessageType.CALL,
                    senderCallsign: this.operator.config.myCallsign,
                    targetCallsign: this.context.targetCallsign,
                    grid: this.context.config.myGrid,
                });
                this.slots.TX2 = FT8MessageParser.generateMessage({
                    type: FT8MessageType.SIGNAL_REPORT,
                    senderCallsign: this.operator.config.myCallsign,
                    targetCallsign: this.context.targetCallsign,
                    report: this.context.reportSent || 0,
                });
                this.slots.TX3 = FT8MessageParser.generateMessage({
                    type: FT8MessageType.ROGER_REPORT,
                    senderCallsign: this.operator.config.myCallsign,
                    targetCallsign: this.context.targetCallsign,
                    report: this.context.reportSent || 0,
                });
                this.slots.TX4 = FT8MessageParser.generateMessage({
                    type: FT8MessageType.RRR,
                    senderCallsign: this.operator.config.myCallsign,
                    targetCallsign: this.context.targetCallsign,
                });
                this.slots.TX5 = FT8MessageParser.generateMessage({
                    type: FT8MessageType.SEVENTY_THREE,
                    senderCallsign: this.operator.config.myCallsign,
                    targetCallsign: this.context.targetCallsign,
                });
            } else {
                this.updateTargetSlotsForSpecialCallsign(this.context.targetCallsign);
            }
        } else {
            this.slots.TX1 = '';
            this.slots.TX2 = '';
            this.slots.TX3 = '';
            this.slots.TX4 = '';
            this.slots.TX5 = '';
        }
        const defaultTx6Message = buildStandardQSODefaultTx6Message(this.operator.config);
        this.slots.TX6 = this.tx6MessageOverride || defaultTx6Message;

        // 通知操作员slots已更新
        this.notifySlotsUpdated();
    }

    /**
     * 保存当前QSO上下文到历史缓存
     */
    private saveCurrentContext(): void {
        if (!this.context.targetCallsign) {
            return;
        }

        this.qsoContextHistory.set(this.context.targetCallsign, {
            targetGrid: this.context.targetGrid,
            reportSent: this.context.reportSent,
            reportReceived: this.context.reportReceived,
            actualFrequency: this.context.actualFrequency,
            lastUpdated: Date.now()
        });

        // 限制缓存大小，删除最老的条目
        if (this.qsoContextHistory.size > this.MAX_CONTEXT_CACHE) {
            const entries = Array.from(this.qsoContextHistory.entries());
            entries.sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
            const oldestKey = entries[0][0];
            this.qsoContextHistory.delete(oldestKey);
            this.logger.debug(`Context cache full, evicting oldest entry: ${oldestKey}`);
        }

        this.logger.debug(`Saving context to cache: ${this.context.targetCallsign}`, {
            grid: this.context.targetGrid,
            reportSent: this.context.reportSent,
            reportReceived: this.context.reportReceived
        });
    }

    /**
     * 从历史缓存恢复QSO上下文
     */
    public restoreContext(targetCallsign: string): boolean {
        const cached = this.qsoContextHistory.get(targetCallsign);
        if (cached) {
            this.context.targetGrid = cached.targetGrid;
            this.context.reportSent = cached.reportSent;
            this.context.reportReceived = cached.reportReceived;
            this.context.actualFrequency = cached.actualFrequency;

            this.logger.debug(`Restored context from cache: ${targetCallsign}`, {
                grid: cached.targetGrid,
                reportSent: cached.reportSent,
                reportReceived: cached.reportReceived
            });
            return true;
        }
        return false;
    }

    public armPost73RetryContext(): void {
        if (!this.context.targetCallsign) {
            return;
        }

        const retryWindowMs = this.context.config.mode.slotMs * 2;
        this.post73RetryContext = {
            targetCallsign: this.context.targetCallsign,
            targetGrid: this.context.targetGrid,
            reportSent: this.context.reportSent,
            reportReceived: this.context.reportReceived,
            actualFrequency: this.context.actualFrequency,
            completedQSO: this.completedQSORecord,
            expiresAt: Date.now() + retryWindowMs,
        };

        this.logger.debug(`Armed post-73 retry context for ${this.context.targetCallsign} (window=${retryWindowMs}ms)`);
    }

    public clearPost73RetryContext(reason: string): void {
        if (!this.post73RetryContext) {
            return;
        }

        this.logger.debug(`Clearing post-73 retry context for ${this.post73RetryContext.targetCallsign}: ${reason}`);
        this.post73RetryContext = undefined;
    }

    public getActivePost73RetryContext(): Post73RetryContext | undefined {
        if (!this.post73RetryContext) {
            return undefined;
        }

        if (this.post73RetryContext.expiresAt < Date.now()) {
            this.clearPost73RetryContext('expired');
            return undefined;
        }

        return this.post73RetryContext;
    }

    public restorePost73RetryContext(context: Post73RetryContext): void {
        this.context.targetCallsign = context.targetCallsign;
        this.context.targetGrid = context.targetGrid;
        this.context.reportSent = context.reportSent;
        this.context.reportReceived = context.reportReceived;
        this.context.actualFrequency = context.actualFrequency;
        this.completedQSORecord = context.completedQSO;
        this.tx5TransmissionQueued = false;
        this.updateSlots();
    }

    /**
     * 清空QSO上下文
     * 在QSO结束时调用，确保干净的下一次通联
     */
    clearQSOContext(): void {
        const previousTarget = this.context.targetCallsign;
        const currentState = this.state;

        // 先保存当前上下文到历史缓存
        this.saveCurrentContext();

        this.context.targetCallsign = undefined;
        this.context.targetGrid = undefined;
        this.context.reportSent = undefined;
        this.context.reportReceived = undefined;
        this.context.actualFrequency = undefined;
        this.foxHash = undefined;
        // 更新slots（TX1-TX5会变为空，只保留TX6的CQ）
        this.updateSlots();

        this.logger.debug(`QSO context cleared (previousTarget=${previousTarget}, state=${currentState}, timeoutCycles=${this.timeoutCycles})`);
    }

    resetRuntime(reason?: string): void {
        this.qsoLifecycleEpoch += 1;
        this.timeoutCycles = 0;
        this.callAttempts = 0;
        this.qsoStartTime = undefined;
        this.tx5TransmissionQueued = false;
        this.completedQSORecord = undefined;
        this.pendingQSOCompletion = undefined;
        this.clearPost73RetryContext(`runtime reset${reason ? `: ${reason}` : ''}`);
        this.clearQSOContext();
        this.changeStateSafely('TX6');
    }

    private changeStateSafely(state: SlotsIndex): void {
        void this.changeState(state).catch((error) => {
            this.logger.error(`Asynchronous state transition to ${state} failed`, error);
        });
    }

    /**
     * 通知slots更新
     */
    private notifySlotsUpdated(): void {
        if (this.speculativeDecisionDepth > 0) {
            return;
        }
        // 通过operator通知slots更新
        this.operator.notifySlotsUpdated?.(this.getSlots());
    }
    
    /**
     * 通知状态变化
     */
    private notifyStateChanged(): void {
        if (this.speculativeDecisionDepth > 0) {
            return;
        }
        // 通过operator通知状态变化
        this.operator.notifyStateChanged?.(this.state);
    }
}
