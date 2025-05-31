import { QSOContext, OperatorConfig, QSORecord, ParsedFT8Message, SlotPack, DigitalRadioEngineEvents, SlotInfo, MODES, QSOCommand } from '@tx5dr/contracts';
import { ITransmissionStrategy } from './transmission/ITransmissionStrategy';
import { FT8MessageParser } from '../parser/ft8-message-parser';
import EventEmitter from 'eventemitter3';

export class RadioOperator {
    // 通联策略（自动化及用户交互）
    private _eventEmitter: EventEmitter<DigitalRadioEngineEvents>;
    private _transmissionStrategy?: ITransmissionStrategy;
    private _config: OperatorConfig; 
    private _stopped: boolean = false;

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

    stop() {
        this._stopped = true;
    }

    start() {
        this._stopped = false;
    }

    initEventListener(eventEmitter: EventEmitter<DigitalRadioEngineEvents>) {
        // 时隙包更新事件
        eventEmitter.on('slotPackUpdated', (slotPack: SlotPack) => {
            const parsedMessages = slotPack.frames.map(frame => {
                const message = FT8MessageParser.parseMessage(frame.message);
                const parsedMessage: ParsedFT8Message = {
                    message,
                    snr: frame.snr,
                    dt: frame.dt,
                    df: frame.freq,
                    rawMessage: frame.message,
                    slotId: slotPack.slotId,
                    timestamp: slotPack.startMs
                }
                return parsedMessage;
            });
            const result = this._transmissionStrategy?.handleReceivedAndDicideNext(parsedMessages);
            if (result?.stop) {
                this.stop();
            }
        });
        // 周期开始事件
        eventEmitter.on('slotStart', (slotInfo: SlotInfo) => {
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
                } else {
                    console.log(this.config.id + " 没有发射");
                }
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
        this._transmissionStrategy?.userCommand?.(command);
    }

    recordQSOLog(qsoRecord: QSORecord): void {
        // TODO
    }
}