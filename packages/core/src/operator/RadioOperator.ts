import { OperatorConfig, QSORecord, ParsedFT8Message, SlotPack, DigitalRadioEngineEvents, SlotInfo, MODES, QSOCommand, FrameMessage } from '@tx5dr/contracts';
import { CycleUtils } from '../utils/cycleUtils.js';
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
    private _checkTargetConflict?: (myCallsign: string, targetCallsign: string, operatorId: string) => boolean;

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

    constructor(
        config: OperatorConfig,
        eventEmitter: EventEmitter<DigitalRadioEngineEvents>,
        strategyFactory: (operator: RadioOperator) => ITransmissionStrategy,
        checkTargetConflict?: (myCallsign: string, targetCallsign: string, operatorId: string) => boolean
    ) {
        this._eventEmitter = eventEmitter;
        this._config = {
            ...RadioOperator.DEFAULT_CONFIG,
            ...config,
        };
        this._checkTargetConflict = checkTargetConflict;
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
        console.log(`[RadioOperator.stop] (${this._config.myCallsign}) 停止操作员，_stopped=${this._stopped} → true, _isTransmitting=${this._isTransmitting} → false`);
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
            if (lastSlotPack) {
                const t0 = Date.now();
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
                const elapsed = Date.now() - t0;
                try {
                    // 计算从slotStart到encodeStart的预算时间：transmitTiming - encodeAdvance
                    const transmitTiming = (this._config.mode as any).transmitTiming || 0;
                    const encodeAdvance = (this._config.mode as any).encodeAdvance || 0;
                    const budget = Math.max(0, transmitTiming - encodeAdvance);
                    if (elapsed > budget) {
                        // 决策耗时超过预算，可能赶不上本周期发射，广播告警（由WSServer转成TEXT_MESSAGE）
                        this._eventEmitter.emit('timingWarning' as any, {
                            title: '⚠️ 时序告警',
                            text: `决策耗时 ${elapsed}ms 超过预算 ${budget}ms，可能赶不上本周期发射（${this._config.myCallsign}）`
                        });
                    }
                } catch {}
                if (result?.stop) {
                    console.log(`[RadioOperator.onSlotStart] (${this.config.myCallsign}) 收到停止指令，调用 stop()`);
                    this.stop();
                }
                console.log(`[RadioOperator.onSlotStart] (${this.config.myCallsign}) 自动决策`, result);
            }
        });
        
        // 编码开始事件 - 提前触发编码准备（新时序系统）
        eventEmitter.on('encodeStart' as any, (slotInfo: SlotInfo) => {
            if (this._stopped) {
                console.log(`[RadioOperator.onEncodeStart] (${this.config.myCallsign}) 操作员已停止，跳过编码`);
                return;
            }
            if (!this._isTransmitting) {
                console.log(`[RadioOperator.onEncodeStart] (${this.config.myCallsign}) 未处于发射状态，跳过编码`);
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
                    console.log(`[RadioOperator.onEncodeStart] (${this.config.myCallsign}) 编码时机到达，准备发射: ${transmission}`);
                } else {
                    console.log(`[RadioOperator.onEncodeStart] (${this.config.myCallsign}) 编码时机到达，但没有发射内容`);
                }
            } else {
                console.log(`[RadioOperator.onEncodeStart] (${this.config.myCallsign}) 编码时机到达，但不是发射时隙`);
            }
        });

        // 目标播放时机事件 - 仅用于日志记录
        eventEmitter.on('transmitStart' as any, (slotInfo: SlotInfo) => {
            if (this._stopped || !this._isTransmitting) {
                return;
            }
            // 判断是否为发射时隙
            const isTransmitSlot = this.isTransmitSlot(slotInfo);
            if (isTransmitSlot) {
                console.log(`[RadioOperator.onTransmitStart] (${this.config.myCallsign}) 目标播放时间到达`);
            }
        });
    }
    
    /**
     * 判断是否为发射时隙
     * @param slotInfo 时隙信息
     * @returns 是否为发射时隙
     */
    private isTransmitSlot(slotInfo: SlotInfo): boolean {
        return CycleUtils.isOperatorTransmitCycle(
            this._config.transmitCycles,
            slotInfo.utcSeconds,
            this._config.mode.slotMs
        );
    }

    /**
     * 设置发射周期
     * @param transmitCycles 发射周期数组，0=偶数周期，1=奇数周期
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

    requestCall(callsign: string, lastMessage: { message: FrameMessage, slotInfo: SlotInfo } | undefined): void {
        // 启用发射
        this.start();
        // 切换周期
        if (lastMessage) {
            this.setTransmitCycles((lastMessage.slotInfo.cycleNumber + 1) % 2);
        }
        // 发送内容决策
        this._transmissionStrategy?.requestCall(callsign, lastMessage);
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
     * 检查指定呼号是否正在被其他同呼号操作者通联
     * 直接同步调用检查函数
     * @param targetCallsign 要检查的目标呼号
     * @returns true表示有冲突，不应回复
     */
    isTargetBeingWorkedByOthers(targetCallsign: string): boolean {
        if (!this._checkTargetConflict) {
            return false; // 如果没有提供检查函数，默认无冲突
        }
        return this._checkTargetConflict(
            this._config.myCallsign,
            targetCallsign,
            this._config.id
        );
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
