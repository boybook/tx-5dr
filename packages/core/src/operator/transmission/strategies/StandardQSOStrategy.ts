import { QSOContext, FT8MessageType, ParsedFT8Message, QSOCommand, StrategiesResult, FT8MessageCQ, FT8MessageCall, FT8MessageSignalReport, FT8MessageRogerReport, QSORecord, FT8MessageRRR, FrameMessage, SlotInfo } from '@tx5dr/contracts';
import { ITransmissionStrategy } from '../ITransmissionStrategy';
import { FT8MessageParser } from '../../../parser/ft8-message-parser.js';
import { RadioOperator } from '../../RadioOperator';

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
}

interface StandardState {
    handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): Promise<StateHandleResult>;
    onTimeout?(strategy: StandardQSOStrategy): StateHandleResult;
    onEnter?(strategy: StandardQSOStrategy): void;
}

const states: { [key in SlotsIndex]: StandardState } = {
    TX1: {
        async handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 【修复】优先检查当前目标呼号是否回复了，而不是先检查新呼叫
            // 这样可以确保当前QSO的连续性，避免在对方已回复时错误切换到新呼叫者
            const msgSignalReport = messages
                .filter((msg) => msg.message.type === FT8MessageType.SIGNAL_REPORT &&
                    msg.message.senderCallsign === strategy.context.targetCallsign &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign)
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

            // 【智能切换逻辑】只有当前目标没有回复时，才考虑切换到新的直接呼叫
            // 在TX1状态（刚发出呼叫，等待信号报告）时，如果收到其他人的直接呼叫，可以切换
            const directCalls = messages
                .filter((msg) =>
                    (msg.message.type === FT8MessageType.CALL ||
                     msg.message.type === FT8MessageType.SIGNAL_REPORT) &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign &&
                    msg.message.senderCallsign !== strategy.context.targetCallsign) // 排除当前目标
                .sort((a, b) => b.snr - a.snr); // 降序排序: 信号最强的在前

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
                        console.log(`[StandardQSOStrategy TX1] 当前目标未回复，收到新的直接呼叫 ${newCallsign} (SNR: ${newCall.snr}dB)，切换目标 (放弃 ${strategy.context.targetCallsign})`);

                        // 立即切换到新呼号
                        strategy.context.targetCallsign = newCallsign;
                        strategy.context.reportSent = newCall.snr;
                        strategy.context.targetGrid = callMsg.grid;
                        // 记录实际通联频率
                        if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                            strategy.context.actualFrequency = strategy.context.config.frequency + newCall.df;
                        }
                        strategy.updateSlots();
                        return { changeState: 'TX2' };
                    } else {
                        console.log(`[StandardQSOStrategy TX1] 收到新呼叫 ${newCallsign} 但已通联过且replyToWorkedStations=false，继续等待 ${strategy.context.targetCallsign}`);
                    }
                } else if (msg.type === FT8MessageType.SIGNAL_REPORT) {
                    const reportMsg = msg as FT8MessageSignalReport;
                    const newCallsign = reportMsg.senderCallsign;

                    // 检查是否已经通联过
                    const hasWorked = await strategy.operator.hasWorkedCallsign(newCallsign);

                    // 根据配置决定是否切换到新呼叫
                    if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                        console.log(`[StandardQSOStrategy TX1] 当前目标未回复，收到新的直接信号报告 ${newCallsign} (SNR: ${newCall.snr}dB)，切换目标 (放弃 ${strategy.context.targetCallsign})`);

                        // 立即切换到新呼号
                        strategy.context.targetCallsign = newCallsign;
                        strategy.context.reportReceived = reportMsg.report;
                        strategy.context.reportSent = newCall.snr;
                        // 记录实际通联频率
                        if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                            strategy.context.actualFrequency = strategy.context.config.frequency + newCall.df;
                        }
                        strategy.updateSlots();
                        return { changeState: 'TX3' };
                    } else {
                        console.log(`[StandardQSOStrategy TX1] 收到新信号报告 ${newCallsign} 但已通联过且replyToWorkedStations=false，继续等待 ${strategy.context.targetCallsign}`);
                    }
                }
            }

            return {}
        },
        onEnter(strategy: StandardQSOStrategy) {
            // 记录QSO开始时间
            strategy.qsoStartTime = Date.now();
        },
        onTimeout(strategy: StandardQSOStrategy): StateHandleResult {
            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;
            // 清理QSO上下文
            strategy.clearQSOContext();
            if (strategy.operator.config.autoReplyToCQ) {
                return { changeState: 'TX6' };
            }
            return { stop: true };
        }
    },
    TX2: {
        async handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            /* if (strategy.context.config.id === 'BA1ABC') {
                console.log('TX2', strategy.context, messages);
            } */
            // 首先等待标准的ROGER_REPORT（R-XX）
            const msgRogerReport = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.ROGER_REPORT &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign &&
                    msg.message.senderCallsign === strategy.context.targetCallsign
                )
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msgRogerReport) {
                const msg = msgRogerReport.message as FT8MessageRogerReport;
                console.log(`[StandardQSOStrategy TX2] 收到标准ROGER_REPORT，进入TX4`);
                // 【修复】ROGER_REPORT也包含对方给我们的信号报告（msg.report）
                // 如果之前没有设置reportReceived，从ROGER_REPORT中获取
                if (strategy.context.reportReceived === undefined || strategy.context.reportReceived === null) {
                    strategy.context.reportReceived = msg.report;
                }
                // 【修复】允许更新reportSent为当前SNR（移除过于保守的条件限制）
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
                    msg.message.targetCallsign === strategy.context.config.myCallsign &&
                    msg.message.senderCallsign === strategy.context.targetCallsign
                )
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msgSignalReport) {
                const msg = msgSignalReport.message as FT8MessageSignalReport;
                console.log(`[StandardQSOStrategy TX2] 容错：收到SIGNAL_REPORT（应为ROGER_REPORT），视为确认，进入TX4`);
                // 【修复】提取对方告诉我们的信号报告值（msg.report）
                if (strategy.context.reportReceived === undefined || strategy.context.reportReceived === null) {
                    strategy.context.reportReceived = msg.report;
                }
                // 【修复】允许更新reportSent（移除过于保守的条件限制）
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
        onEnter(strategy: StandardQSOStrategy) {
            // 如果是直接从回复开始的QSO，记录开始时间
            if (!strategy.qsoStartTime) {
                strategy.qsoStartTime = Date.now();
            }
        },
        onTimeout(strategy: StandardQSOStrategy): StateHandleResult {
            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;
            // 清理QSO上下文
            strategy.clearQSOContext();
            if (strategy.operator.config.autoReplyToCQ) {
                return { changeState: 'TX6' };
            }
            return { stop: true };
        }
    },
    TX3: {
        async handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 等待对方发送RRR或73
            const msgRRR = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.RRR &&
                    msg.message.senderCallsign === strategy.context.targetCallsign &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign)
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

            // 【新增】容错处理：如果对方继续发送SIGNAL_REPORT，更新信号报告
            const msgSignalReport = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.SIGNAL_REPORT &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign &&
                    msg.message.senderCallsign === strategy.context.targetCallsign)
                .sort((a, b) => b.snr - a.snr)  // 按SNR降序，取最强信号
                .shift();  // 取第一个（SNR最高的）

            if (msgSignalReport) {
                const msg = msgSignalReport.message as FT8MessageSignalReport;
                console.log(`[StandardQSOStrategy TX3] 容错：收到对方重复的SIGNAL_REPORT (SNR: ${msgSignalReport.snr}dB)，更新信号报告`);

                // 更新接收的信号报告（如果之前没有设置）
                if (strategy.context.reportReceived === undefined ||
                    strategy.context.reportReceived === null) {
                    strategy.context.reportReceived = msg.report;
                }

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
        onTimeout(strategy: StandardQSOStrategy): StateHandleResult {
            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;
            // 清理QSO上下文
            strategy.clearQSOContext();
            if (strategy.operator.config.autoReplyToCQ) {
                return { changeState: 'TX6' };
            }
            return { stop: true };
        }
    },
    TX4: {
        onEnter(strategy: StandardQSOStrategy) {
            // 记录QSO日志
            // 优先使用actualFrequency（包含音频偏移的精确频率）
            // 如果actualFrequency无效（< 1MHz），则使用config.frequency（基础频率）
            const frequency = (strategy.context.actualFrequency && strategy.context.actualFrequency > 1000000)
                ? strategy.context.actualFrequency
                : (strategy.context.config.frequency || 0);

            const qsoRecord: QSORecord = {
                id: Date.now().toString(),
                callsign: strategy.context.targetCallsign!,
                grid: strategy.context.targetGrid,
                frequency: frequency,
                mode: strategy.context.config.mode.name,
                startTime: strategy.qsoStartTime || Date.now(),
                endTime: Date.now(),
                reportSent: strategy.context.reportSent?.toString(),
                reportReceived: strategy.context.reportReceived?.toString(),
                messages: [],
                myCallsign: strategy.context.config.myCallsign,
                myGrid: strategy.context.config.myGrid
            };
            strategy.operator.recordQSOLog(qsoRecord);
            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;
        },
        async handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 首先检查是否收到对方的73
            const msg73 = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.SEVENTY_THREE &&
                    msg.message.senderCallsign === strategy.context.targetCallsign &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign)
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msg73) {
                // 对方发送了73，QSO已完成
                console.log(`[StandardQSOStrategy TX4] 收到对方73，QSO完成`);

                // 【修复】在转到TX6之前，先检查是否有新的直接呼叫
                const directCalls = messages
                    .filter((msg) =>
                        (msg.message.type === FT8MessageType.CALL ||
                         msg.message.type === FT8MessageType.SIGNAL_REPORT) &&
                        msg.message.targetCallsign === strategy.context.config.myCallsign &&
                        msg.message.senderCallsign !== strategy.context.targetCallsign) // 排除刚完成的QSO对象
                    .sort((a, b) => b.snr - a.snr); // 降序排序: 信号最强的在前

                if (directCalls.length > 0) {
                    const newCall = directCalls[0];
                    const msg = newCall.message;

                    if (msg.type === FT8MessageType.CALL) {
                        const callMsg = msg as FT8MessageCall;
                        const newCallsign = callMsg.senderCallsign;

                        // 检查是否已经通联过
                        const hasWorked = await strategy.operator.hasWorkedCallsign(newCallsign);

                        // 根据配置决定是否切换到新呼叫
                        if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                            console.log(`[StandardQSOStrategy TX4] QSO完成后收到新的直接呼叫 ${newCallsign} (SNR: ${newCall.snr}dB)，立即切换`);

                            // 清空旧QSO上下文
                            strategy.clearQSOContext();

                            // 立即切换到新呼号
                            strategy.context.targetCallsign = newCallsign;
                            strategy.context.reportSent = newCall.snr;
                            strategy.context.targetGrid = callMsg.grid;
                            // 记录实际通联频率
                            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                                strategy.context.actualFrequency = strategy.context.config.frequency + newCall.df;
                            }
                            strategy.updateSlots();
                            return { changeState: 'TX2' };
                        } else {
                            console.log(`[StandardQSOStrategy TX4] QSO完成后收到新呼叫 ${newCallsign} 但已通联过且replyToWorkedStations=false`);
                        }
                    } else if (msg.type === FT8MessageType.SIGNAL_REPORT) {
                        const reportMsg = msg as FT8MessageSignalReport;
                        const newCallsign = reportMsg.senderCallsign;

                        // 检查是否已经通联过
                        const hasWorked = await strategy.operator.hasWorkedCallsign(newCallsign);

                        // 根据配置决定是否切换到新呼叫
                        if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                            console.log(`[StandardQSOStrategy TX4] QSO完成后收到新的直接信号报告 ${newCallsign} (SNR: ${newCall.snr}dB)，立即切换`);

                            // 清空旧QSO上下文
                            strategy.clearQSOContext();

                            // 立即切换到新呼号
                            strategy.context.targetCallsign = newCallsign;
                            strategy.context.reportReceived = reportMsg.report;
                            strategy.context.reportSent = newCall.snr;
                            // 记录实际通联频率
                            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                                strategy.context.actualFrequency = strategy.context.config.frequency + newCall.df;
                            }
                            strategy.updateSlots();
                            return { changeState: 'TX3' };
                        } else {
                            console.log(`[StandardQSOStrategy TX4] QSO完成后收到新信号报告 ${newCallsign} 但已通联过且replyToWorkedStations=false`);
                        }
                    }
                }

                // 没有新的直接呼叫，转到TX6
                console.log(`[StandardQSOStrategy TX4] 没有新的直接呼叫，转到TX6`);
                strategy.clearQSOContext();
                return { changeState: 'TX6' };
            }

            // 其次检查是否收到对方的 RRR/RR73
            const msgRRR = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.RRR &&
                    msg.message.senderCallsign === strategy.context.targetCallsign &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign)
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
        onTimeout(strategy: StandardQSOStrategy): StateHandleResult {
            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;
            strategy.clearQSOContext();
            if (strategy.operator.config.autoReplyToCQ) {
                return { changeState: 'TX6' };
            }
            return { stop: true };
        }
    },
    TX5: {
        onEnter(strategy: StandardQSOStrategy) {
            // 记录QSO日志
            // 优先使用actualFrequency（包含音频偏移的精确频率）
            // 如果actualFrequency无效（< 1MHz），则使用config.frequency（基础频率）
            const frequency = (strategy.context.actualFrequency && strategy.context.actualFrequency > 1000000)
                ? strategy.context.actualFrequency
                : (strategy.context.config.frequency || 0);

            const qsoRecord: QSORecord = {
                id: Date.now().toString(),
                callsign: strategy.context.targetCallsign!,
                grid: strategy.context.targetGrid,
                frequency: frequency,
                mode: strategy.context.config.mode.name,
                startTime: strategy.qsoStartTime || Date.now(),
                endTime: Date.now(),
                reportSent: strategy.context.reportSent?.toString(),
                reportReceived: strategy.context.reportReceived?.toString(),
                messages: [],
                myCallsign: strategy.context.config.myCallsign,
                myGrid: strategy.context.config.myGrid
            };
            strategy.operator.recordQSOLog(qsoRecord);
            // 清理QSO开始时间
            strategy.qsoStartTime = undefined;
        },
        async handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 【修复】首先检查是否收到对方重发的RRR/RR73
            // 如果对方没收到我们的73，会重新发送RRR，我们应该保持在TX5状态继续发送73
            const msgRRR = messages
                .filter((msg) =>
                    msg.message.type === FT8MessageType.RRR &&
                    msg.message.senderCallsign === strategy.context.targetCallsign &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign)
                .sort((a, b) => a.snr - b.snr)
                .pop();

            if (msgRRR) {
                // 对方没收到我们的73，重新发送了RRR
                // 保持在TX5状态，下个周期再次发送73
                console.log(`[StandardQSOStrategy TX5] 收到对方重发的RRR，保持TX5状态重新发送73`);
                return {}; // 保持当前状态，不转换
            }

            // 发送1次73后，检查是否有新的直接呼叫
            // 如果有直接呼叫，优先处理；否则转到TX6
            const directCalls = messages
                .filter((msg) =>
                    (msg.message.type === FT8MessageType.CALL ||
                     msg.message.type === FT8MessageType.SIGNAL_REPORT) &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign &&
                    msg.message.senderCallsign !== strategy.context.targetCallsign) // 排除刚完成的QSO对象
                .sort((a, b) => b.snr - a.snr);

            if (directCalls.length > 0) {
                const msg = directCalls[0].message;

                if (msg.type === FT8MessageType.CALL) {
                    const callsign = msg.senderCallsign;
                    const hasWorked = await strategy.operator.hasWorkedCallsign(callsign);

                    if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                        console.log(`[StandardQSOStrategy TX5] 收到新的直接呼叫 ${callsign}，立即切换`);

                        // 清空旧QSO上下文
                        strategy.clearQSOContext();

                        strategy.context.targetCallsign = callsign;
                        strategy.context.reportSent = directCalls[0].snr;
                        strategy.context.targetGrid = (msg as FT8MessageCall).grid;
                        if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                            strategy.context.actualFrequency = strategy.context.config.frequency + directCalls[0].df;
                        }
                        strategy.updateSlots();
                        return { changeState: 'TX2' };
                    }
                } else if (msg.type === FT8MessageType.SIGNAL_REPORT) {
                    const callsign = msg.senderCallsign;
                    const hasWorked = await strategy.operator.hasWorkedCallsign(callsign);

                    if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                        console.log(`[StandardQSOStrategy TX5] 收到新的直接信号报告 ${callsign}，立即切换`);

                        // 清空旧QSO上下文
                        strategy.clearQSOContext();

                        strategy.context.targetCallsign = callsign;
                        strategy.context.reportReceived = (msg as FT8MessageSignalReport).report;
                        strategy.context.reportSent = directCalls[0].snr;
                        if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                            strategy.context.actualFrequency = strategy.context.config.frequency + directCalls[0].df;
                        }
                        strategy.updateSlots();
                        return { changeState: 'TX3' };
                    }
                }
            }

            // 没有新的直接呼叫，转到TX6（CQ或等待新消息）
            // 这样确保只发送1次73后就转到TX6
            strategy.clearQSOContext();
            return { changeState: 'TX6' };
        },
        onTimeout(strategy: StandardQSOStrategy): StateHandleResult {
            strategy.clearQSOContext();
            if (strategy.operator.config.autoReplyToCQ) {
                return { changeState: 'TX6' };
            }
            return { stop: true };
        }
    },
    TX6: {
        async handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): Promise<StateHandleResult> {
            // 收集所有TX1和TX2形式的消息
            const directCalls = messages
                .filter((msg) =>
                    (msg.message.type === FT8MessageType.CALL ||
                     msg.message.type === FT8MessageType.SIGNAL_REPORT) &&
                    msg.message.targetCallsign === strategy.context.config.myCallsign)
                .sort((a, b) => b.snr - a.snr); // 降序排序: 信号最强的在前

            // 收集所有CQ消息
            const cqCalls = messages
                .filter((msg) => 
                    msg.message.type === FT8MessageType.CQ && 
                    strategy.operator.config.autoReplyToCQ)
                .sort((a, b) => a.snr - b.snr);

            // 优先处理直接呼叫
            if (directCalls.length > 0) {
                const msg = directCalls[0].message;

                if (msg.type === FT8MessageType.CALL) {
                    const callsign = msg.senderCallsign;

                    // 检查是否已经通联过
                    const hasWorked = await strategy.operator.hasWorkedCallsign(callsign);

                    // 根据配置决定是否回复已通联过的直接呼叫
                    if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                        console.log(`[StandardQSOStrategy] 回复直接呼叫: ${callsign} (${hasWorked ? '已通联过' : '未通联过'}, SNR: ${directCalls[0].snr})`);
                        strategy.context.targetCallsign = callsign;
                        strategy.context.reportSent = directCalls[0].snr;
                        strategy.context.targetGrid = msg.grid;
                        // 记录实际通联频率 (基础频率 + 对方信号的频率偏移)
                        // 只有当基础频率有效时（大于1MHz）才计算actualFrequency
                        if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                            strategy.context.actualFrequency = strategy.context.config.frequency + directCalls[0].df;
                        }
                        strategy.updateSlots();
                        return { changeState: 'TX2' };
                    } else {
                        console.log(`[StandardQSOStrategy] 跳过直接呼叫: ${callsign} (已通联过且replyToWorkedStations=false, SNR: ${directCalls[0].snr})`);
                    }
                } else if (msg.type === FT8MessageType.SIGNAL_REPORT) {
                    const callsign = msg.senderCallsign;

                    // 检查是否已经通联过
                    const hasWorked = await strategy.operator.hasWorkedCallsign(callsign);

                    // 根据配置决定是否回复已通联过的直接呼叫
                    if (!hasWorked || strategy.operator.config.replyToWorkedStations) {
                        console.log(`[StandardQSOStrategy] 回复直接信号报告: ${callsign} (${hasWorked ? '已通联过' : '未通联过'}, SNR: ${directCalls[0].snr})`);
                        strategy.context.targetCallsign = callsign;
                        strategy.context.reportReceived = msg.report;
                        strategy.context.reportSent = directCalls[0].snr;
                        // 记录实际通联频率 (基础频率 + 对方信号的频率偏移)
                        // 只有当基础频率有效时（大于1MHz）才计算actualFrequency
                        if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                            strategy.context.actualFrequency = strategy.context.config.frequency + directCalls[0].df;
                        }
                        strategy.updateSlots();
                        return { changeState: 'TX3' };
                    } else {
                        console.log(`[StandardQSOStrategy] 跳过直接信号报告: ${callsign} (已通联过且replyToWorkedStations=false, SNR: ${directCalls[0].snr})`);
                    }
                }
            }

            // 其次处理CQ呼叫
            if (cqCalls.length > 0) {
                // 始终按信号强度从高到低排序，遍历找到第一个未通联过的电台
                const sortedCalls = cqCalls.sort((a, b) => b.snr - a.snr);

                for (const cqCall of sortedCalls) {
                    const msg = cqCall.message as FT8MessageCQ;
                    const callsign = msg.senderCallsign;
                    // 跳过带有区域/活动标记的CQ（例如 CQ NA/EU/AS/AF/OC/SA/JA/DX/TEST/POTA 等）
                    if ((msg as FT8MessageCQ).flag) {
                        console.log(`[StandardQSOStrategy] 跳过带标记的CQ: ${callsign} (flag=${(msg as FT8MessageCQ).flag})`);
                        continue;
                    }
                    
                    try {
                        // 检查是否已经通联过
                        const hasWorked = await strategy.operator.hasWorkedCallsign(callsign);

                        // CQ呼叫只回复未通联过的电台(不受replyToWorkedStations配置影响)
                        if (!hasWorked) {
                            console.log(`[StandardQSOStrategy] 回复CQ: ${callsign} (未通联过, SNR: ${cqCall.snr}dB, 按信号强度优先)`);
                            strategy.context.targetCallsign = callsign;
                            strategy.context.targetGrid = msg.grid;
                            strategy.context.reportSent = cqCall.snr;
                            // 记录实际通联频率 (基础频率 + CQ信号的频率偏移)
                            // 只有当基础频率有效时（大于1MHz）才计算actualFrequency
                            if (strategy.context.config.frequency && strategy.context.config.frequency > 1000000) {
                                strategy.context.actualFrequency = strategy.context.config.frequency + cqCall.df;
                            }
                            strategy.updateSlots();
                            return { changeState: 'TX1' };
                        } else {
                            console.log(`[StandardQSOStrategy] 跳过CQ: ${callsign} (已通联过, SNR: ${cqCall.snr})`);
                        }
                    } catch (error) {
                        console.error(`[StandardQSOStrategy] 检查呼号 ${callsign} 失败:`, error);
                        // 如果检查失败，跳过这个呼号
                        continue;
                    }
                }
            } 

            return {};
        }
    }
}

export class StandardQSOStrategy implements ITransmissionStrategy {
    public readonly operator: RadioOperator;
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
    private timeoutCycles: number = 0;
    public qsoStartTime?: number; // QSO开始时间

    constructor(operator: RadioOperator) {
        this.operator = operator;
        this._context = {
            config: operator.config
        }
        this.updateSlots();
    }

    get context(): QSOContext {
        return this._context;
    }

    changeState(state: SlotsIndex) {
        const oldState = this.state;
        this.state = state;
        this.timeoutCycles = 0;
        
        // 状态变化时通知槽位更新
        if (oldState !== this.state) {
            this.notifyStateChanged();
        }
        
        // 调用新状态的onEnter
        const newState = states[this.state];
        if (newState.onEnter) {
            newState.onEnter(this);
        }
    }

    async handleReceivedAndDicideNext(messages: ParsedFT8Message[]): Promise<StrategiesResult> {
        const currentState = states[this.state];

        // 过滤掉发送者是我自己的消息
        const filteredMessages = messages.filter((msg) => msg.message.type == FT8MessageType.CUSTOM || msg.message.type == FT8MessageType.UNKNOWN || msg.message.senderCallsign !== this.operator.config.myCallsign);
        
        // console.log(this.context.config.id, "收到消息", filteredMessages);
        // 处理接收到的消息
        const result = await currentState.handle(this, filteredMessages);
        
        // 如果状态需要改变
        if (result.changeState) {
            /* if (result.changeState !== 'TX6') {
                this.operator.start();  // 启动发射
            } */
            this.changeState(result.changeState);
        } else {
            // 增加超时计数
            this.timeoutCycles++;
            // 检查是否超时
            if (this.timeoutCycles >= this.operator.config.maxQSOTimeoutCycles) {
                if (currentState.onTimeout) {
                    const timeoutResult = currentState.onTimeout(this);
                    if (timeoutResult.changeState) {
                        const oldState = this.state;
                        this.state = timeoutResult.changeState;
                        this.timeoutCycles = 0;
                        
                        // 状态变化时通知槽位更新
                        if (oldState !== this.state) {
                            this.notifyStateChanged();
                        }
                    }
                    if (timeoutResult.stop) {
                        return { stop: true };
                    }
                }
            }
        }

        return {
            stop: result.stop
        };
    }

    handleTransmitSlot(): string | null {
        return this.slots[this.state];
    }

    requestCall(callsign: string, lastMessage: { message: FrameMessage, slotInfo: SlotInfo } | undefined): void {
        console.log(`[StandardQSOStrategy.requestCall] (${this.operator.config.myCallsign}) 请求通联 ${callsign}`, lastMessage);
        if (!lastMessage) {
            this.context.targetCallsign = callsign;
            this.updateSlots();
            this.changeState('TX1');  // 呼叫他
            return;
        }
        this.context.targetCallsign = callsign;
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
            this.changeState('TX1');  // 呼叫他
            return;
        }
        // 包含 targetCallsign 的消息
        if (msg.type === FT8MessageType.SIGNAL_REPORT || msg.type === FT8MessageType.CALL || msg.type === FT8MessageType.ROGER_REPORT || msg.type === FT8MessageType.RRR || msg.type === FT8MessageType.SEVENTY_THREE) {
            if (msg.targetCallsign === this._context.config.myCallsign) {
                // 和我有关，则设置当前状态到对应消息的上一步，然后立即执行原始 handleReceivedAndDicideNext
                if (msg.type === FT8MessageType.CALL) {
                    this.changeState('TX6');
                } else if (msg.type === FT8MessageType.SIGNAL_REPORT) {
                    this.changeState('TX1');
                } else if (msg.type === FT8MessageType.ROGER_REPORT) {
                    this.changeState('TX2');
                } else if (msg.type === FT8MessageType.RRR) {
                    this.changeState('TX3');
                } else if (msg.type === FT8MessageType.SEVENTY_THREE) {
                    this.changeState('TX4');
                }
                this.updateSlots();
                this.handleReceivedAndDicideNext([parsedMessage]);
                return;
            } else {
                // 和我无关，那么就正常CQ他
                this.updateSlots();
                this.changeState('TX1');  // 呼叫他
            }
            return;
        }
        // 不包含 targetCallsign 的消息
        this.updateSlots();
        this.changeState('TX1');  // 呼叫他
    }

    userCommand?(command: QSOCommand): any {
        switch (command.command) {
            case 'update_context':
                // 更新context
                this._context = {
                    ...this._context,
                    ...command.args
                }

                // 只有在targetCallsign或reportSent等影响slots内容的字段变化时才调用updateSlots
                // 这避免了频率等字段变化时触发不必要的slots更新和operatorStatusUpdate事件
                const needsSlotUpdate =
                    command.args.targetCallsign !== undefined ||
                    command.args.reportSent !== undefined ||
                    command.args.reportReceived !== undefined;

                if (needsSlotUpdate) {
                    this.updateSlots();
                }

                return { success: true };
            case 'set_state':
                const oldState = this.state;
                this.state = command.args;
                // 手动设置状态时也通知槽位更新
                if (oldState !== this.state) {
                    this.notifyStateChanged();
                }
                return { success: true };
            case 'set_slot_content':
                // 设置指定时隙的内容
                const { slot, content } = command.args;
                if (slot && this.slots.hasOwnProperty(slot)) {
                    this.slots[slot as SlotsIndex] = content || '';
                    this.notifySlotsUpdated();
                    return { success: true };
                }
                return { error: 'Invalid slot or content' };
            case 'get_slots':
                // 返回当前slots状态
                return this.getSlots();
            case 'get_state':
                // 返回当前状态
                return this.state;
            default:
                return { error: 'Unknown command' };
        }
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
    
    updateSlots() {
        if (this.context.targetCallsign) {
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
            this.slots.TX1 = '';
            this.slots.TX2 = '';
            this.slots.TX3 = '';
            this.slots.TX4 = '';
            this.slots.TX5 = '';
        }
        this.slots.TX6 = FT8MessageParser.generateMessage({
            type: FT8MessageType.CQ,
            senderCallsign: this.operator.config.myCallsign,
            grid: this.operator.config.myGrid,
        });

        // 通知操作员slots已更新
        this.notifySlotsUpdated();
    }

    /**
     * 清空QSO上下文
     * 在QSO结束时调用，确保干净的下一次通联
     */
    clearQSOContext(): void {
        this.context.targetCallsign = undefined;
        this.context.targetGrid = undefined;
        this.context.reportSent = undefined;
        this.context.reportReceived = undefined;
        this.context.actualFrequency = undefined;

        // 更新slots（TX1-TX5会变为空，只保留TX6的CQ）
        this.updateSlots();

        console.log(`[StandardQSOStrategy] 已清空QSO上下文`);
    }

    /**
     * 通知slots更新
     */
    private notifySlotsUpdated(): void {
        // 通过operator通知slots更新
        this.operator.notifySlotsUpdated?.(this.getSlots());
    }
    
    /**
     * 通知状态变化
     */
    private notifyStateChanged(): void {
        // 通过operator通知状态变化
        this.operator.notifyStateChanged?.(this.state);
    }
}
