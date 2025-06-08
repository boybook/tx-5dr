import { OperatorConfig, QSORecord, ParsedFT8Message, SlotPack, DigitalRadioEngineEvents, SlotInfo, MODES, QSOCommand } from '@tx5dr/contracts';
import { ITransmissionStrategy } from './transmission/ITransmissionStrategy';
import { FT8MessageParser } from '../parser/ft8-message-parser.js';
import EventEmitter from 'eventemitter3';

export class RadioOperator {
    // 通联策略（自动化及用户交互）
    private _eventEmitter: EventEmitter<DigitalRadioEngineEvents>;
    private _transmissionStrategy?: ITransmissionStrategy;
    private _config: OperatorConfig; 
    private _stopped: boolean = false;
    private _isTransmitting: boolean = false; // 发射状态

    private static readonly DEFAULT_CONFIG: OperatorConfig = {
        mode: MODES.FT8,
        id: '',
        myCallsign: '',
        myGrid: '',
        frequency: 0,
        transmitCycles: [],
        maxQSOTimeoutCycles: 0,
        maxCallAttempts: 0,
        autoReplyToCQ: false,
        autoResumeCQAfterFail: false,
        autoResumeCQAfterSuccess: false,
        replyToWorkedStations: false,
        prioritizeNewCalls: true,
    };

    constructor(config: OperatorConfig, eventEmitter: EventEmitter<DigitalRadioEngineEvents>, strategyFactory: (operator: RadioOperator) => ITransmissionStrategy) {
        this._eventEmitter = eventEmitter;
        this._config = { 
            ...RadioOperator.DEFAULT_CONFIG, 
            ...config, 
        };
        this._transmissionStrategy = strategyFactory(this);
        this.initEventListener(eventEmitter);
    }

    get config(): OperatorConfig {
        return this._config;
    }

    get transmissionStrategy(): ITransmissionStrategy | undefined {
        return this._transmissionStrategy;
    }

    get isTransmitting(): boolean {
        return this._isTransmitting;
    }

    stop() {
        this._stopped = true;
        this._isTransmitting = false;
        this.notifyStatusChanged();
    }

    start() {
        this._stopped = false;
        this._isTransmitting = true;
        this.notifyStatusChanged();
    }

    initEventListener(eventEmitter: EventEmitter<DigitalRadioEngineEvents>) {
        // 周期开始事件 - 用于处理接收到的消息
        eventEmitter.on('slotStart', async (slotInfo: SlotInfo, lastSlotPack: SlotPack | null) => {
            if (this._stopped) {
                return;
            }
            if (!this._isTransmitting) {
                return;
            }
            // 如果当前不是发射时隙，则不处理
            if (!this.isTransmitSlot(slotInfo)) {
                return;
            }
            if (lastSlotPack) {
                const parsedMessages = lastSlotPack.frames.map(frame => {
                    const message = FT8MessageParser.parseMessage(frame.message);
                    const parsedMessage: ParsedFT8Message = {
                        message,
                        snr: frame.snr,
                        dt: frame.dt,
                        df: frame.freq,
                        rawMessage: frame.message,
                        slotId: lastSlotPack.slotId,
                        timestamp: lastSlotPack.startMs
                    }
                    return parsedMessage;
                });
                const result = await this._transmissionStrategy?.handleReceivedAndDicideNext(parsedMessages);
                if (result?.stop) {
                    this.stop();
                }
                console.log(`[RadioOperator.onSlotStart] (${this.config.myCallsign}) 自动决策`, result);
            }
        });
        
        // 发射开始事件 - 用于处理发射
        eventEmitter.on('transmitStart' as any, (slotInfo: SlotInfo) => {
            if (this._stopped) {
                return;
            }
            
            // 判断是否为发射时隙
            const isTransmitSlot = this.isTransmitSlot(slotInfo);
            if (isTransmitSlot) {
                const transmission = this._transmissionStrategy?.handleTransmitSlot();
                if (transmission) {
                    this._eventEmitter.emit('requestTransmit', {
                        operatorId: this._config.id,
                        transmission
                    });
                    console.log(`[RadioOperator.onTransmitStart] (${this.config.myCallsign}) 发射时机到达，发射内容: ${transmission}`);
                } else {
                    console.log(`[RadioOperator.onTransmitStart] (${this.config.myCallsign}) 发射时机到达，但没有发射内容`);
                }
            } else {
                console.log(`[RadioOperator.onTransmitStart] (${this.config.myCallsign}) 发射时机到达，但不是发射时隙`);
            }
        });
    }
    
    /**
     * 判断是否为发射时隙
     * @param slotInfo 时隙信息
     * @returns 是否为发射时隙
     */
    private isTransmitSlot(slotInfo: SlotInfo): boolean {
        const { transmitCycles } = this._config;
        if (!transmitCycles || transmitCycles.length === 0) {
            return false;
        }

        // 获取当前时隙的周期号
        const cycleNumber = this.getCycleNumber(slotInfo);
        
        // 检查当前周期是否在发射周期列表中
        return transmitCycles.includes(cycleNumber);
    }

    /**
     * 获取时隙的周期号
     * @param slotInfo 时隙信息
     * @returns 周期号（0=偶数周期，1=奇数周期）
     */
    private getCycleNumber(slotInfo: SlotInfo): number {
        // 从配置中获取当前模式的时隙长度
        const slotMs = this._config.mode.slotMs;
        
        // 根据周期类型计算
        if (this._config.mode.cycleType === 'EVEN_ODD') {
            // 偶奇周期模式：每两个时隙为一个周期
            const cycleMs = slotMs * 2;
            const cyclePosition = (slotInfo.utcSeconds * 1000) % cycleMs;
            return cyclePosition < slotMs ? 0 : 1;
        } else {
            // 连续周期模式：每个时隙都是一个独立的周期
            return Math.floor(slotInfo.utcSeconds * 1000 / slotMs);
        }
    }

    /**
     * 设置发射周期
     * @param transmitCycles 发射周期
     * - 对于 EVEN_ODD 类型：0=偶数周期，1=奇数周期
     * - 对于 CONTINUOUS 类型：数组中的数字表示发射周期
     */
    setTransmitCycles(transmitCycles: number | number[]): void {
        this._config.transmitCycles = Array.isArray(transmitCycles) ? transmitCycles : [transmitCycles];
    }

    userCommand(command: QSOCommand): void {
        // 首先检查是否是RadioOperator级别的命令
        if (command.command === 'set_transmit_cycles') {
            const { transmitCycles } = command.args;
            this.setTransmitCycles(transmitCycles);
            // 通知状态变化
            this.notifyStatusChanged();
            // 发射事件通知发射周期已更改
            this._eventEmitter.emit('operatorTransmitCyclesChanged' as any, {
                operatorId: this._config.id,
                transmitCycles: this._config.transmitCycles
            });
            return;
        }
        
        // 处理update_context命令 - 更新操作员配置
        if (command.command === 'update_context') {
            const { 
                myCall, 
                myGrid, 
                frequency,
                autoReplyToCQ,
                autoResumeCQAfterFail,
                autoResumeCQAfterSuccess,
                replyToWorkedStations,
                prioritizeNewCalls
            } = command.args;
            
            // 更新操作员配置字段
            if (myCall !== undefined) {
                this._config.myCallsign = myCall;
            }
            if (myGrid !== undefined) {
                this._config.myGrid = myGrid;
            }
            if (frequency !== undefined) {
                this._config.frequency = frequency;
            }
            if (autoReplyToCQ !== undefined) {
                this._config.autoReplyToCQ = autoReplyToCQ;
            }
            if (autoResumeCQAfterFail !== undefined) {
                this._config.autoResumeCQAfterFail = autoResumeCQAfterFail;
            }
            if (autoResumeCQAfterSuccess !== undefined) {
                this._config.autoResumeCQAfterSuccess = autoResumeCQAfterSuccess;
            }
            if (replyToWorkedStations !== undefined) {
                this._config.replyToWorkedStations = replyToWorkedStations;
            }
            if (prioritizeNewCalls !== undefined) {
                this._config.prioritizeNewCalls = prioritizeNewCalls;
            }
            
            // 通知状态变化
            this.notifyStatusChanged();
        }
        
        // 其他命令转发给transmission strategy
        const result = this._transmissionStrategy?.userCommand?.(command);
        
        // 检查特定命令，发射相应事件以触发立即发射
        if (command.command === 'set_state') {
            // 切换发射槽位时，发射事件
            this._eventEmitter.emit('operatorSlotChanged' as any, {
                operatorId: this._config.id,
                slot: command.args
            });
        } else if (command.command === 'set_slot_content') {
            // 编辑发射内容时，发射事件
            this._eventEmitter.emit('operatorSlotContentChanged' as any, {
                operatorId: this._config.id,
                slot: command.args.slot,
                content: command.args.content
            });
        }
        
        return result;
    }

    /**
     * 获取当前发射周期配置
     */
    getTransmitCycles(): number[] {
        return [...this._config.transmitCycles];
    }

    recordQSOLog(qsoRecord: QSORecord): void {
        // 发射记录QSO日志的事件
        this._eventEmitter.emit('recordQSO' as any, {
            operatorId: this._config.id,
            qsoRecord
        });
    }
    
    /**
     * 检查是否已经与某呼号通联过
     * 通过事件系统查询
     */
    async hasWorkedCallsign(callsign: string): Promise<boolean> {
        return new Promise((resolve) => {
            // 生成唯一的请求ID
            const requestId = `${Date.now()}_${Math.random()}`;
            
            // 设置一次性监听器等待响应
            const responseHandler = (data: { requestId: string; hasWorked: boolean }) => {
                if (data.requestId === requestId) {
                    this._eventEmitter.off('hasWorkedCallsignResponse' as any, responseHandler);
                    resolve(data.hasWorked);
                }
            };
            
            this._eventEmitter.on('hasWorkedCallsignResponse' as any, responseHandler);
            
            // 发射查询事件
            this._eventEmitter.emit('checkHasWorkedCallsign' as any, {
                operatorId: this._config.id,
                callsign,
                requestId
            });
            
            // 设置超时（避免永久等待）
            setTimeout(() => {
                this._eventEmitter.off('hasWorkedCallsignResponse' as any, responseHandler);
                resolve(false); // 默认返回false
            }, 1000);
        });
    }
    
    /**
     * 通知slots更新
     */
    notifySlotsUpdated(slots: any): void {
        this._eventEmitter.emit('operatorSlotsUpdated' as any, {
            operatorId: this._config.id,
            slots
        });
    }
    
    /**
     * 添加slots更新监听器
     */
    addSlotsUpdateListener(callback: (data: { operatorId: string; slots: any }) => void): void {
        this._eventEmitter.on('operatorSlotsUpdated' as any, callback);
    }
    
    /**
     * 添加状态变化监听器
     */
    addStateChangeListener(callback: (data: { operatorId: string; state: string }) => void): void {
        this._eventEmitter.on('operatorStateChanged' as any, callback);
    }

    /**
     * 通知状态变化（发射状态等）
     */
    private notifyStatusChanged(): void {
        this._eventEmitter.emit('operatorStatusChanged' as any, {
            operatorId: this._config.id,
            isTransmitting: this._isTransmitting,
            isStopped: this._stopped
        });
    }

    /**
     * 通知状态变化
     */
    notifyStateChanged(state: string): void {
        this._eventEmitter.emit('operatorStateChanged' as any, {
            operatorId: this._config.id,
            state
        });
    }
}