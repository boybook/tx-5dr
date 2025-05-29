import { QSOContext, ParsedFT8Message, FT8MessageType, QSOState } from '@tx5dr/contracts';
import { ITransmissionStrategy } from '../ITransmissionStrategy';
import { FT8MessageParser } from '../../../parser/ft8-message-parser';

export class StandardQSOStrategy implements ITransmissionStrategy {
    decideNextMessage(context: QSOContext, lastReceivedMessage?: ParsedFT8Message): string | null {
        const { myCallsign, targetCallsign, myGrid, reportSent, reportReceived, currentState } = context;

        if (!myCallsign) {
            console.warn('StandardQSOStrategy: myCallsign is not set in context.');
            return null;
        }

        switch (currentState) {
            case QSOState.CALLING_CQ:
                // CQ <MYCALL> <MYGRID>
                return FT8MessageParser.generateMessage(FT8MessageType.CQ, { myCallsign, grid: myGrid });

            case QSOState.RESPONDING:
                // <TARGET> <MYCALL> <MYGRID>
                if (targetCallsign) {
                    console.log(`StandardQSOStrategy: 生成响应消息。目标: ${targetCallsign}, 我的呼号: ${myCallsign}, 网格: ${myGrid}`);
                    return FT8MessageParser.generateMessage(FT8MessageType.RESPONSE, { myCallsign, targetCallsign, grid: myGrid });
                }
                break;

            case QSOState.EXCHANGING_REPORT:
                // <TARGET> <MYCALL> <REPORT>
                if (targetCallsign && context.reportSent) {
                    console.log(`StandardQSOStrategy: 生成信号报告消息。目标: ${targetCallsign}, 我的呼号: ${myCallsign}, 报告: ${context.reportSent}`);
                    return FT8MessageParser.generateMessage(FT8MessageType.SIGNAL_REPORT, { myCallsign, targetCallsign, report: context.reportSent });
                }
                // <TARGET> <MYCALL> R<REPORTRECEIVED>
                // 实际上 WSJT-X 并不发送 R+报告，而是直接发送 RRR 或 RR73。这里简化为如果已收到对方报告，就发RRR。
                if (targetCallsign && reportReceived) {
                     return FT8MessageParser.generateMessage(FT8MessageType.RRR, { myCallsign, targetCallsign });
                }
                break;

            case QSOState.CONFIRMING:
                // 在CONFIRMING状态下，直接发送73
                if (targetCallsign) {
                    console.log(`StandardQSOStrategy: 在CONFIRMING状态发送73。目标: ${targetCallsign}, 我的呼号: ${myCallsign}`);
                    return FT8MessageParser.generateMessage(FT8MessageType.SEVENTY_THREE, { myCallsign, targetCallsign });
                }
                break;

            case QSOState.COMPLETED: 
                // <TARGET> <MYCALL> 73
                if (targetCallsign) {
                    return FT8MessageParser.generateMessage(FT8MessageType.SEVENTY_THREE, { myCallsign, targetCallsign });
                }
                break;

            case QSOState.IDLE:
            case QSOState.LISTENING:
            case QSOState.FAILED:
                return null; // 在这些状态下，标准策略不主动发送消息

            default:
                console.warn(`StandardQSOStrategy: Unknown QSO state: ${currentState}`);
                return null;
        }
        return null; // 默认不发送
    }

    onQSOStateChanged(newState: QSOState, context: QSOContext): void {
        console.log(`StandardQSOStrategy: QSO state changed to ${newState}${context.targetCallsign ? ` for ${context.targetCallsign}` : ''}`);
        
        // 重置计数器
        if (newState === QSOState.IDLE || newState === QSOState.LISTENING) {
            context.cyclesSinceLastTransmission = 0;
            context.cyclesSinceLastReceptionFromTarget = 0;
            context.transmissionAttempts = 0;
        }
    }

    onManualMessageOverride?(message: string, context: QSOContext): void {
        // 当有手动消息覆盖时，标准策略可以记录这个事件，或者根据需要调整其行为
        // 例如，如果手动发送了CQ，策略可能需要将状态切换到 CALLING_CQ（但这通常由 RadioOperator 处理）
        console.log(`StandardQSOStrategy: Manual message '${message}' will be sent for ${context.targetCallsign || 'CQ'}`);
    }
} 