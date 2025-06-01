import { QSOContext, FT8MessageType, ParsedFT8Message, QSOCommand, StrategiesResult, FT8MessageCQ, FT8MessageCall, FT8MessageSignalReport, FT8MessageRogerReport, QSORecord, FT8MessageRRR } from '@tx5dr/contracts';
import { ITransmissionStrategy } from '../ITransmissionStrategy';
import { FT8MessageParser } from '../../../parser/ft8-message-parser';
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
    handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): StateHandleResult;
    onTimeout?(strategy: StandardQSOStrategy): StateHandleResult;
    onEnter?(strategy: StandardQSOStrategy): void;
}

const states: { [key in SlotsIndex]: StandardState } = {
    TX1: {
        handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): StateHandleResult {
            // 只接受指定的呼号回复我
            const msgSignalReport = messages
                .filter((msg) => msg.message.type === FT8MessageType.SIGNAL_REPORT && 
                    msg.message.senderCallsign === strategy.context.targetCallsign && 
                    msg.message.targetCallsign === strategy.context.config.myCallsign)
                .sort((a, b) => a.snr - b.snr)
                .pop();
            if (msgSignalReport) {
                const msg = msgSignalReport.message as FT8MessageSignalReport;
                strategy.context.reportSent = msgSignalReport.snr;  // 更新信号报告
                strategy.context.targetCallsign = msg.senderCallsign;
                strategy.updateSlots();
                return {
                    changeState: 'TX3'
                }
            }
            return {}
        },
        onTimeout(strategy: StandardQSOStrategy): StateHandleResult {
            if (strategy.operator.config.autoReplyToCQ) {
                return { changeState: 'TX6' };
            }
            return { stop: true };
        }
    },
    TX2: {
        handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): StateHandleResult {
            /* if (strategy.context.config.id === 'BA1ABC') {
                console.log('TX2', strategy.context, messages);
            } */
            // 只等待当前目标呼号的确认
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
                strategy.context.reportReceived = msg.report;
                strategy.context.reportSent = msgRogerReport.snr;
                strategy.updateSlots();
                return {
                    changeState: 'TX4'
                }
            }
            return {}
        },
        onTimeout(strategy: StandardQSOStrategy): StateHandleResult {
            if (strategy.operator.config.autoReplyToCQ) {
                return { changeState: 'TX6' };
            }
            return { stop: true };
        }
    },
    TX3: {
        handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): StateHandleResult {
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
            return {}
        },
        onTimeout(strategy: StandardQSOStrategy): StateHandleResult {
            if (strategy.operator.config.autoReplyToCQ) {
                return { changeState: 'TX6' };
            }
            return { stop: true };
        }
    },
    TX4: {
        onEnter(strategy: StandardQSOStrategy) {
            // 记录QSO日志
            const qsoRecord: QSORecord = {
                id: Date.now().toString(),
                callsign: strategy.context.targetCallsign!,
                grid: strategy.context.targetGrid,
                frequency: strategy.context.config.frequency,
                mode: 'FT8',
                startTime: Date.now(),
                reportSent: strategy.context.reportSent?.toString(),
                reportReceived: strategy.context.reportReceived?.toString(),
                messages: []
            };
            strategy.operator.recordQSOLog(qsoRecord);
        },
        handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): StateHandleResult {
            // 复用TX6的CQ处理逻辑
            const result = states.TX6.handle(strategy, messages);
            if (!result.stop && !result.changeState) {
                return {
                    changeState: 'TX6'
                }
            }
            return result;
        }
    },
    TX5: {
        onEnter(strategy: StandardQSOStrategy) {
            // 记录QSO日志
            const qsoRecord: QSORecord = {
                id: Date.now().toString(),
                callsign: strategy.context.targetCallsign!,
                grid: strategy.context.targetGrid,
                frequency: strategy.context.config.frequency,
                mode: 'FT8',
                startTime: Date.now(),
                reportSent: strategy.context.reportSent?.toString(),
                reportReceived: strategy.context.reportReceived?.toString(),
                messages: []
            };
            strategy.operator.recordQSOLog(qsoRecord);
        },
        handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): StateHandleResult {
            // 复用TX6的CQ处理逻辑
            const result = states.TX6.handle(strategy, messages);
            if (!result.stop && !result.changeState) {
                return {
                    changeState: 'TX6'
                }
            }
            return result;
        }
    },
    TX6: {
        handle(strategy: StandardQSOStrategy, messages: ParsedFT8Message[]): StateHandleResult {
            // 收集所有TX1和TX2形式的消息
            const directCalls = messages
                .filter((msg) => 
                    (msg.message.type === FT8MessageType.CALL || 
                     msg.message.type === FT8MessageType.SIGNAL_REPORT) && 
                    msg.message.targetCallsign === strategy.context.config.myCallsign)
                .sort((a, b) => a.snr - b.snr);

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
                    strategy.context.targetCallsign = msg.senderCallsign;
                    strategy.context.reportSent = directCalls[0].snr;
                    strategy.context.targetGrid = msg.grid;
                    strategy.updateSlots();
                    return { changeState: 'TX2' };
                } else if (msg.type === FT8MessageType.SIGNAL_REPORT) {
                    strategy.context.targetCallsign = msg.senderCallsign;
                    strategy.context.reportReceived = msg.report;
                    strategy.context.reportSent = directCalls[0].snr;
                    strategy.updateSlots();
                    return { changeState: 'TX3' };
                }
            }

            // 其次处理CQ呼叫
            if (cqCalls.length > 0) {
                const msg = cqCalls[0].message as FT8MessageCQ;
                strategy.context.targetCallsign = msg.senderCallsign;
                strategy.context.targetGrid = msg.grid;
                strategy.context.reportSent = cqCalls[0].snr;
                strategy.updateSlots();
                return { changeState: 'TX1' };
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

    handleReceivedAndDicideNext(messages: ParsedFT8Message[]): StrategiesResult {
        const currentState = states[this.state];

        // 过滤掉发送者是我自己的消息
        const filteredMessages = messages.filter((msg) => msg.message.type == FT8MessageType.CUSTOM || msg.message.type == FT8MessageType.UNKNOWN || msg.message.senderCallsign !== this.operator.config.myCallsign);
        
        // console.log(this.context.config.id, "收到消息", filteredMessages);
        // 处理接收到的消息
        const result = currentState.handle(this, filteredMessages);
        
        // 如果状态需要改变
        if (result.changeState) {
            /* if (result.changeState !== 'TX6') {
                this.operator.start();  // 启动发射
            } */
            const oldState = this.state;
            this.state = result.changeState;
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

    userCommand?(command: QSOCommand): any {
        switch (command.command) {
            case 'update_context':
                this._context = {
                    ...this._context,
                    ...command.args
                }
                this.updateSlots();
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
