import { OperatorConfig, QSORecord, ParsedFT8Message, SlotPack, DigitalRadioEngineEvents, SlotInfo, MODES, QSOCommand, FrameMessage, OperatorSlots } from '@tx5dr/contracts';
import { CycleUtils } from '../utils/cycleUtils.js';
import { ITransmissionStrategy } from './transmission/ITransmissionStrategy';
import { FT8MessageParser } from '../parser/ft8-message-parser.js';
import EventEmitter from 'eventemitter3';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioOperator');

export class RadioOperator {
    // 通联策略（自动化及用户交互）
    private _eventEmitter: EventEmitter<DigitalRadioEngineEvents>;
    private _transmissionStrategy?: ITransmissionStrategy;
    private _config: OperatorConfig;
    private _stopped: boolean = false;
    private _isTransmitting: boolean = false; // 发射状态
    private _checkTargetConflict?: (myCallsign: string, targetCallsign: string, operatorId: string) => boolean;

    // 晚到解码重决策相关状态
    private _decisionInProgress = false;
    private _lastDecisionTransmission: string | null = null;
    private _lastDecisionMessageSet: Set<string> | null = null;

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
        logger.info(`Stopping operator (${this._config.myCallsign}): stopped=${this._stopped}->true, isTransmitting=${this._isTransmitting}->false`);
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

            // 重置重决策状态
            this._lastDecisionTransmission = null;
            this._lastDecisionMessageSet = null;

            if (lastSlotPack) {
                const t0 = Date.now();
                const parsedMessages = this.parseSlotPackMessages(lastSlotPack);

                this._decisionInProgress = true;
                let result;
                try {
                    result = await this._transmissionStrategy?.handleReceivedAndDicideNext(parsedMessages);
                } finally {
                    this._decisionInProgress = false;
                }

                const elapsed = Date.now() - t0;
                try {
                    // 计算从slotStart到encodeStart的预算时间：transmitTiming - encodeAdvance
                    const mode = this._config.mode;
                    const transmitTiming = ('transmitTiming' in mode ? mode.transmitTiming : 0) || 0;
                    const encodeAdvance = ('encodeAdvance' in mode ? mode.encodeAdvance : 0) || 0;
                    const budget = Math.max(0, transmitTiming - encodeAdvance);
                    if (elapsed > budget) {
                        // 决策耗时超过预算，可能赶不上本周期发射，广播告警（由WSServer转成TEXT_MESSAGE）
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        this._eventEmitter.emit('timingWarning' as any, {
                            title: 'Timing Warning',
                            text: `Decision took ${elapsed}ms, exceeding budget ${budget}ms, may miss this slot transmission (${this._config.myCallsign})`
                        });
                    }
                } catch {}
                if (result?.stop) {
                    logger.debug(`onSlotStart (${this.config.myCallsign}): stop command received, calling stop()`);
                    this.stop();
                }

                // 记录决策结果，用于后续晚到解码重决策比较
                this._lastDecisionTransmission = this._transmissionStrategy?.handleTransmitSlot() ?? null;
                this._lastDecisionMessageSet = new Set(
                    lastSlotPack.frames.filter(f => f.snr !== -999).map(f => f.message)
                );

                logger.debug(`onSlotStart (${this.config.myCallsign}): auto decision result=${JSON.stringify(result)}`);
            }
        });
        
        // 编码开始事件 - 提前触发编码准备（新时序系统）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventEmitter.on('encodeStart' as any, (slotInfo: SlotInfo) => {
            if (this._stopped) {
                logger.debug(`onEncodeStart (${this.config.myCallsign}): operator stopped, skipping encode`);
                return;
            }
            if (!this._isTransmitting) {
                logger.debug(`onEncodeStart (${this.config.myCallsign}): not transmitting, skipping encode`);
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
                    logger.debug(`onEncodeStart (${this.config.myCallsign}): transmit slot, queued transmission: ${transmission}`);
                } else {
                    logger.debug(`onEncodeStart (${this.config.myCallsign}): transmit slot but no transmission content`);
                }
            } else {
                logger.debug(`onEncodeStart (${this.config.myCallsign}): not a transmit slot, skipping`);
            }
        });

        // 目标播放时机事件 - 仅用于日志记录
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventEmitter.on('transmitStart' as any, (slotInfo: SlotInfo) => {
            if (this._stopped || !this._isTransmitting) {
                return;
            }
            // 判断是否为发射时隙
            const isTransmitSlot = this.isTransmitSlot(slotInfo);
            if (isTransmitSlot) {
                logger.debug(`onTransmitStart (${this.config.myCallsign}): target playback time reached`);
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        this._transmissionStrategy?.userCommand?.(command);

        // 手动操作命令：清空消息集合，允许后续重决策
        if (command.command === 'set_state' || command.command === 'set_slot_content' || command.command === 'set_transmit_cycles') {
            this._lastDecisionMessageSet = null;
        }

        // 检查特定命令，发射相应事件以触发立即发射
        if (command.command === 'set_state') {
            // 切换发射槽位时，发射事件
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._eventEmitter.emit('operatorSlotChanged' as any, {
                operatorId: this._config.id,
                slot: command.args
            });
        } else if (command.command === 'set_slot_content') {
            // 编辑发射内容时，发射事件
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._eventEmitter.emit('operatorSlotContentChanged' as any, {
                operatorId: this._config.id,
                slot: command.args.slot,
                content: command.args.content
            });
        }
    }

    requestCall(callsign: string, lastMessage: { message: FrameMessage, slotInfo: SlotInfo } | undefined): void {
        // 手动操作：清空消息集合，使后续所有解码都被视为"新消息"（不阻止重决策，但 deadline 和 mutex 仍保护）
        this._lastDecisionMessageSet = null;
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    this._eventEmitter.off('hasWorkedCallsignResponse' as any, responseHandler);
                    resolve(data.hasWorked);
                }
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._eventEmitter.on('hasWorkedCallsignResponse' as any, responseHandler);

            // 发射查询事件
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._eventEmitter.emit('checkHasWorkedCallsign' as any, {
                operatorId: this._config.id,
                callsign,
                requestId
            });

            // 设置超时（避免永久等待）
            setTimeout(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
     *
     * 注意：这个事件不在 DigitalRadioEngineEvents 中定义，因为它是内部操作员事件
     */
    notifySlotsUpdated(slots: OperatorSlots): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this._eventEmitter.emit('operatorSlotsUpdated' as any, {
            operatorId: this._config.id,
            slots
        });
    }

    /**
     * 添加slots更新监听器
     *
     * 注意：这个事件不在 DigitalRadioEngineEvents 中定义，因为它是内部操作员事件
     */
    addSlotsUpdateListener(callback: (data: { operatorId: string; slots: OperatorSlots }) => void): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this._eventEmitter.on('operatorSlotsUpdated' as any, callback);
    }

    /**
     * 添加状态变化监听器
     *
     * 注意：这个事件不在 DigitalRadioEngineEvents 中定义，因为它是内部操作员事件
     */
    addStateChangeListener(callback: (data: { operatorId: string; state: string }) => void): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this._eventEmitter.on('operatorStateChanged' as any, callback);
    }

    /**
     * 解析 SlotPack 的帧为 ParsedFT8Message 数组
     */
    private parseSlotPackMessages(slotPack: SlotPack): ParsedFT8Message[] {
        return slotPack.frames.map(frame => {
            const message = FT8MessageParser.parseMessage(frame.message);
            return {
                message,
                snr: frame.snr,
                dt: frame.dt,
                df: frame.freq,
                rawMessage: frame.message,
                slotId: slotPack.slotId,
                timestamp: slotPack.startMs
            };
        });
    }

    /**
     * 晚到解码重决策：当上一 RX 时隙的解码结果晚到时，重新评估发射决策。
     * 由 RadioOperatorManager 在 debounce 后调用。
     * @param slotPack 更新后的 SlotPack（来自上一 RX 时隙的晚到解码）
     * @returns true 表示决策发生了变更，需要重新编码发射
     */
    async reDecideWithUpdatedSlotPack(slotPack: SlotPack): Promise<boolean> {
        if (this._stopped || !this._isTransmitting) return false;
        if (this._decisionInProgress) return false;

        // 检查是否有新消息到达（排除发射帧 SNR=-999），仅 SNR/dt 更新不触发重决策
        const newMessages = slotPack.frames.filter(f => f.snr !== -999).map(f => f.message);
        if (this._lastDecisionMessageSet) {
            const hasNewMessage = newMessages.some(m => !this._lastDecisionMessageSet!.has(m));
            if (!hasNewMessage) return false;
        }
        logger.debug(`reDecide (${this._config.myCallsign}): new messages detected, evaluating (slotPack=${slotPack.slotId}, frames=${newMessages.length})`);

        const parsedMessages = this.parseSlotPackMessages(slotPack);

        this._decisionInProgress = true;
        try {
            const result = await this._transmissionStrategy?.handleReceivedAndDicideNext(
                parsedMessages, { isReDecision: true }
            );
            if (result?.stop) {
                logger.debug(`reDecide (${this.config.myCallsign}): stop command received`);
                this.stop();
                return false;
            }
        } finally {
            this._decisionInProgress = false;
        }

        // 更新消息集合记录
        this._lastDecisionMessageSet = new Set(newMessages);

        const newTransmission = this._transmissionStrategy?.handleTransmitSlot() ?? null;
        if (newTransmission !== this._lastDecisionTransmission) {
            logger.info(`Late decode re-decision (${this._config.myCallsign}): "${this._lastDecisionTransmission}" -> "${newTransmission}"`);
            this._lastDecisionTransmission = newTransmission;
            return true;
        }
        return false;
    }

    /**
     * 通知状态变化（发射状态等）
     *
     * 注意：这个事件不在 DigitalRadioEngineEvents 中定义，因为它是内部操作员事件
     */
    private notifyStatusChanged(): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this._eventEmitter.emit('operatorStatusChanged' as any, {
            operatorId: this._config.id,
            isTransmitting: this._isTransmitting,
            isStopped: this._stopped
        });
    }

    /**
     * 通知状态变化
     *
     * 注意：这个事件不在 DigitalRadioEngineEvents 中定义，因为它是内部操作员事件
     */
    notifyStateChanged(state: string): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this._eventEmitter.emit('operatorStateChanged' as any, {
            operatorId: this._config.id,
            state
        });
    }
}
