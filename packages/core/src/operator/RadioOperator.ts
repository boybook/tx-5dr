import {
  OperatorConfig,
  QSORecord,
  DigitalRadioEngineEvents,
  MODES,
  OperatorSlots,
} from '@tx5dr/contracts';
import EventEmitter from 'eventemitter3';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioOperator');

export class RadioOperator {
    private _eventEmitter: EventEmitter<DigitalRadioEngineEvents>;
    private _config: OperatorConfig;
    private _stopped = false;
    private _isTransmitting = false;
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
        targetSelectionPriorityMode: 'dxcc_first',
    };

    constructor(
        config: OperatorConfig,
        eventEmitter: EventEmitter<DigitalRadioEngineEvents>,
        checkTargetConflict?: (myCallsign: string, targetCallsign: string, operatorId: string) => boolean
    ) {
        this._eventEmitter = eventEmitter;
        this._config = {
            ...RadioOperator.DEFAULT_CONFIG,
            ...config,
        };
        this._checkTargetConflict = checkTargetConflict;
    }

    get config(): OperatorConfig {
        return this._config;
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

    setTransmitCycles(transmitCycles: number | number[]): void {
        this._config.transmitCycles = Array.isArray(transmitCycles) ? transmitCycles : [transmitCycles];
        this._eventEmitter.emit('operatorTransmitCyclesChanged' as any, {
            operatorId: this._config.id,
            transmitCycles: this._config.transmitCycles,
        });
    }

    getTransmitCycles(): number[] {
        return [...this._config.transmitCycles];
    }

    recordQSOLog(qsoRecord: QSORecord): void {
        this._eventEmitter.emit('recordQSO' as any, {
            operatorId: this._config.id,
            qsoRecord,
        });
    }

    async hasWorkedCallsign(callsign: string): Promise<boolean> {
        return new Promise((resolve) => {
            const requestId = `${Date.now()}_${Math.random()}`;

            const responseHandler = (data: { requestId: string; hasWorked: boolean }) => {
                if (data.requestId === requestId) {
                    this._eventEmitter.off('hasWorkedCallsignResponse' as any, responseHandler);
                    resolve(data.hasWorked);
                }
            };

            this._eventEmitter.on('hasWorkedCallsignResponse' as any, responseHandler);
            this._eventEmitter.emit('checkHasWorkedCallsign' as any, {
                operatorId: this._config.id,
                callsign,
                requestId,
            });

            setTimeout(() => {
                this._eventEmitter.off('hasWorkedCallsignResponse' as any, responseHandler);
                resolve(false);
            }, 1000);
        });
    }

    isTargetBeingWorkedByOthers(targetCallsign: string): boolean {
        if (!this._checkTargetConflict) {
            return false;
        }
        return this._checkTargetConflict(
            this._config.myCallsign,
            targetCallsign,
            this._config.id
        );
    }

    notifySlotsUpdated(slots: OperatorSlots): void {
        this._eventEmitter.emit('operatorSlotsUpdated' as any, {
            operatorId: this._config.id,
            slots,
        });
    }

    addSlotsUpdateListener(callback: (data: { operatorId: string; slots: OperatorSlots }) => void): void {
        this._eventEmitter.on('operatorSlotsUpdated' as any, callback);
    }

    addStateChangeListener(callback: (data: { operatorId: string; state: string }) => void): void {
        this._eventEmitter.on('operatorStateChanged' as any, callback);
    }

    notifyStateChanged(state: string): void {
        this._eventEmitter.emit('operatorStateChanged' as any, {
            operatorId: this._config.id,
            state,
        });
    }

    private notifyStatusChanged(): void {
        this._eventEmitter.emit('operatorStatusChanged' as any, {
            operatorId: this._config.id,
            isTransmitting: this._isTransmitting,
            isStopped: this._stopped,
        });
    }
}
