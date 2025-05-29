import { QSOContext, ParsedFT8Message, FT8MessageType, QSOState, SystemConfig, EnrichedParsedFT8Message } from '@tx5dr/contracts';
import { FT8MessageParser } from '../parser/ft8-message-parser';
import { ITransmissionStrategy } from './transmission/ITransmissionStrategy';
import { StandardQSOStrategy } from './transmission/strategies/StandardQSOStrategy';

interface DecodedMessageInput {
    rawMessage: string;
    snr?: number;
    dt?: number;
    df?: number;
}

export class RadioOperator {
    private readonly _callsign: string;
    private readonly _grid: string;

    private _qsoContext: QSOContext;
    private _transmissionStrategy: ITransmissionStrategy;
    private _manualNextMessage: string | null = null;
    private _config: SystemConfig; 

    private static readonly DEFAULT_CONFIG: SystemConfig = {
        myCallsign: '',
        myGrid: '',
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 20, 
        maxCallAttempts: 5,      
        transmitPower: 10,
        frequency: 14074000,
        autoResumeCQAfterFail: true,
        autoResumeCQAfterSuccess: false,
    };

    constructor(callsign: string, grid: string, strategy?: ITransmissionStrategy, initialConfig?: Partial<SystemConfig>) {
        this._callsign = callsign;
        this._grid = grid;
        
        this._config = { 
            ...RadioOperator.DEFAULT_CONFIG, 
            ...initialConfig, 
            myCallsign: callsign, 
            myGrid: grid 
        };

        this._qsoContext = {
            currentState: QSOState.IDLE,
            myCallsign: this._callsign,
            myGrid: this._grid,
            frequency: this._config.frequency,
            cyclesSinceLastTransmission: 0,
            cyclesSinceLastReceptionFromTarget: 0,
            transmissionAttempts: 0,
            timeoutCycles: this._config.maxQSOTimeoutCycles,
        };

        this._transmissionStrategy = strategy || new StandardQSOStrategy();
        this.updateQSOState(QSOState.LISTENING, true); 
    }

    public get callsign(): string {
        return this._callsign;
    }

    public get grid(): string {
        return this._grid;
    }
    
    public get qsoContext(): QSOContext {
        return { ...this._qsoContext }; 
    }
    
    public get config(): SystemConfig {
        return { ...this._config }; 
    }

    public setTransmissionStrategy(strategy: ITransmissionStrategy): void {
        this._transmissionStrategy = strategy;
        if (this._transmissionStrategy.onQSOStateChanged) {
            this._transmissionStrategy.onQSOStateChanged(this._qsoContext.currentState, this._qsoContext);
        }
    }

    public setNextMessageManually(message: string | null): void {
        this._manualNextMessage = message;
        if (message && this._transmissionStrategy.onManualMessageOverride) {
            this._transmissionStrategy.onManualMessageOverride(message, this._qsoContext);
        }
        if (message) {
            this._qsoContext.transmissionAttempts = 0;
        }
    }

    public updateConfig(config: Partial<SystemConfig>): void {
        this._config = { ...this._config, ...config };
        if (config.myCallsign) this._qsoContext.myCallsign = config.myCallsign;
        if (config.myGrid) this._qsoContext.myGrid = config.myGrid;
        if (config.frequency) this._qsoContext.frequency = config.frequency;
        if (config.maxQSOTimeoutCycles) this._qsoContext.timeoutCycles = config.maxQSOTimeoutCycles;
    }

    private resetQSOContextDetails(): void {
        delete this._qsoContext.targetCallsign;
        delete this._qsoContext.targetGrid;
        delete this._qsoContext.reportSent;
        delete this._qsoContext.reportReceived;
        delete this._qsoContext.lastTransmission;
        delete this._qsoContext.lastReceivedMessageFromTarget;
        this._qsoContext.cyclesSinceLastReceptionFromTarget = 0;
        this._qsoContext.transmissionAttempts = 0;
    }
    
    public updateQSOState(newState: QSOState, isInitialState: boolean = false, targetCallsign?: string, targetGrid?: string): void {
        if (this._qsoContext.currentState !== newState || isInitialState) {
            console.log(`RadioOperator(${this._callsign}): 状态从 ${this._qsoContext.currentState} 切换到 ${newState} ${targetCallsign ? `目标: ${targetCallsign}`:''}`);
            this._qsoContext.currentState = newState;
            this._qsoContext.cyclesSinceLastTransmission = 0; 

            if (newState === QSOState.IDLE || newState === QSOState.LISTENING) {
                this.resetQSOContextDetails();
            } else if (newState === QSOState.FAILED || newState === QSOState.COMPLETED) {
                const previousTarget = this._qsoContext.targetCallsign;
                this.resetQSOContextDetails(); 
                if (previousTarget) { 
                    this._qsoContext.targetCallsign = previousTarget; 
                }
            }

            if (targetCallsign) {
                this._qsoContext.targetCallsign = targetCallsign;
                this._qsoContext.cyclesSinceLastReceptionFromTarget = 0; 
                this._qsoContext.transmissionAttempts = 0; 
            }
            if (targetGrid) {
                this._qsoContext.targetGrid = targetGrid;
            }

            // 通知传输策略状态变更
            if (this._transmissionStrategy.onQSOStateChanged) {
                this._transmissionStrategy.onQSOStateChanged(newState, { ...this._qsoContext });
            }
        }
    }

    public startCallingCQ(frequency?: number): void {
        if (frequency) this._qsoContext.frequency = frequency;
        this.updateQSOState(QSOState.CALLING_CQ);
    }

    public respondToCall(targetCallsign: string, targetGrid?: string, frequency?: number): void {
        if (frequency) this._qsoContext.frequency = frequency;
        if (this._qsoContext.targetCallsign !== targetCallsign) {
            this.resetQSOContextDetails();
        }
        this.updateQSOState(QSOState.RESPONDING, false, targetCallsign, targetGrid);
    }

    public receivedMessages(messages: DecodedMessageInput[]): void {
        const enrichedMessages: EnrichedParsedFT8Message[] = messages.map(
            m => ({
                ...FT8MessageParser.parseMessage(m.rawMessage),
                snr: m.snr,
                df: m.df,
                dt: m.dt
            } as EnrichedParsedFT8Message)
        ).filter(m => m.isValid);

        if (enrichedMessages.length === 0) return;
        
        // 根据当前状态处理消息
        switch (this._qsoContext.currentState) {
            case QSOState.CALLING_CQ:
                this.handleMessagesInCallingCQ(enrichedMessages);
                break;
            case QSOState.LISTENING:
            case QSOState.COMPLETED:  // 完成的QSO可以接受新的呼叫
            case QSOState.FAILED:     // 失败的QSO也可以接受新的呼叫
                this.handleMessagesInListening(enrichedMessages);
                break;
            case QSOState.RESPONDING:
            case QSOState.EXCHANGING_REPORT:
            case QSOState.CONFIRMING:
                this.handleMessagesInActiveQSO(enrichedMessages);
                break;
        }
    }

    private handleMessagesInCallingCQ(messages: EnrichedParsedFT8Message[]): void {
        // 所有可能的直接呼叫（无论是否带网格）
        const allDirectCalls = messages.filter(m => 
            m.type === FT8MessageType.RESPONSE && 
            m.callsign1 === this._callsign && 
            m.callsign2 && 
            m.callsign2 !== this._callsign
        );

        // 分离无网格（明确的直接呼叫）和有网格的消息
        const noGridCalls = allDirectCalls.filter(m => !m.grid);
        const withGridCalls = allDirectCalls.filter(m => m.grid);

        // 如果有无网格的直接呼叫，优先处理所有直接呼叫（包括带网格的）
        if (noGridCalls.length > 0) {
            // 统一处理所有直接呼叫，按SNR排序
            const allCallsSorted = allDirectCalls.sort((a, b) => (b.snr ?? -99) - (a.snr ?? -99));
            const strongestCall = allCallsSorted[0];
            
            console.log(`RadioOperator(${this._callsign}): 收到${allDirectCalls.length}个直接呼叫，选择信号最强的 ${strongestCall.callsign2} (SNR: ${strongestCall.snr}dB)${strongestCall.grid ? ` [${strongestCall.grid}]` : ''}`);
            
            this._qsoContext.targetCallsign = strongestCall.callsign2!;
            if (strongestCall.grid) this._qsoContext.targetGrid = strongestCall.grid;
            this._qsoContext.lastReceivedMessageFromTarget = strongestCall;
            this._qsoContext.cyclesSinceLastReceptionFromTarget = 0;
            this._qsoContext.transmissionAttempts = 0;
            
            this.updateQSOState(QSOState.RESPONDING, false, strongestCall.callsign2!, strongestCall.grid);
            return;
        }

        // 如果只有带网格的消息，当作CQ响应处理
        if (withGridCalls.length > 0) {
            const strongestResponse = withGridCalls.sort((a, b) => (b.snr ?? -99) - (a.snr ?? -99))[0];
            console.log(`RadioOperator(${this._callsign}): 收到CQ响应来自 ${strongestResponse.callsign2} (SNR: ${strongestResponse.snr}dB)`);
            
            this._qsoContext.targetCallsign = strongestResponse.callsign2;
            if (strongestResponse.grid) this._qsoContext.targetGrid = strongestResponse.grid;
            this._qsoContext.lastReceivedMessageFromTarget = strongestResponse;
            this._qsoContext.cyclesSinceLastReceptionFromTarget = 0;
            this._qsoContext.transmissionAttempts = 0;
            this._qsoContext.reportSent = FT8MessageParser.generateSignalReport(strongestResponse.snr || 0);
            
            this.updateQSOState(QSOState.EXCHANGING_REPORT, false, strongestResponse.callsign2, strongestResponse.grid);
        }
    }

    private handleMessagesInListening(messages: EnrichedParsedFT8Message[]): void {
        if (!this._config.autoReplyToCQ) return;

        // 首先检查是否有直接的信号报告（针对我的）
        const signalReports = messages.filter(m => 
            m.type === FT8MessageType.SIGNAL_REPORT &&
            m.callsign1 === this._callsign && 
            m.callsign2 !== this._callsign &&
            m.callsign2 // 确保有发送方呼号
        ).sort((a, b) => (b.snr ?? -99) - (a.snr ?? -99));

        if (signalReports.length > 0) {
            const strongestReport = signalReports[0];
            console.log(`RadioOperator(${this._callsign}): 直接收到信号报告从 ${strongestReport.callsign2} (报告: ${strongestReport.report}, SNR: ${strongestReport.snr}dB)`);
            
            this._qsoContext.targetCallsign = strongestReport.callsign2!;
            this._qsoContext.lastReceivedMessageFromTarget = strongestReport;
            this._qsoContext.cyclesSinceLastReceptionFromTarget = 0;
            this._qsoContext.transmissionAttempts = 0;
            this._qsoContext.reportReceived = strongestReport.report;
            
            // 直接进入EXCHANGING_REPORT状态，准备发送RRR
            this.updateQSOState(QSOState.EXCHANGING_REPORT, false, strongestReport.callsign2!);
            return;
        }

        // 然后检查CQ呼叫或直接呼叫
        const callsToMe = messages.filter(m => {
            if (m.type === FT8MessageType.CQ) {
                return true; // CQ消息总是可以响应
            }
            
            // 对于响应消息格式（CALLSIGN1 CALLSIGN2 [GRID]），如果我是callsign1，说明对方在呼叫我
            if (m.type === FT8MessageType.RESPONSE && 
                m.callsign1 === this._callsign && 
                m.callsign2 && 
                m.callsign2 !== this._callsign) {
                return true;
            }
            
            return false;
        }).sort((a, b) => (b.snr ?? -99) - (a.snr ?? -99));

        if (callsToMe.length > 0) {
            const chosenCall = callsToMe[0];
            
            // 确定呼叫方和目标呼号
            let callerCallsign: string;
            if (chosenCall.type === FT8MessageType.CQ) {
                callerCallsign = chosenCall.callsign1!;
            } else {
                // 响应消息中，callsign2是呼叫方
                callerCallsign = chosenCall.callsign2!;
            }
            
            this._qsoContext.targetCallsign = callerCallsign;
            if (chosenCall.grid) this._qsoContext.targetGrid = chosenCall.grid;
            this._qsoContext.lastReceivedMessageFromTarget = chosenCall;
            this._qsoContext.cyclesSinceLastReceptionFromTarget = 0;
            this._qsoContext.transmissionAttempts = 0;
            
            this.updateQSOState(QSOState.RESPONDING, false, callerCallsign, chosenCall.grid);
        }
    }

    private handleMessagesInActiveQSO(messages: EnrichedParsedFT8Message[]): void {
        if (!this._qsoContext.targetCallsign) return;

        // 寻找来自目标的消息
        const messageFromTarget = messages.find(m => 
            FT8MessageParser.messageContainsCallsign(m, this._qsoContext.targetCallsign!) &&
            FT8MessageParser.messageContainsCallsign(m, this._callsign)
        );

        if (!messageFromTarget) return;
        
        this._qsoContext.lastReceivedMessageFromTarget = messageFromTarget;
        this._qsoContext.cyclesSinceLastReceptionFromTarget = 0;

        // 根据当前状态和消息类型推进QSO
        switch (this._qsoContext.currentState) {
            case QSOState.RESPONDING:
                if (messageFromTarget.type === FT8MessageType.SIGNAL_REPORT && messageFromTarget.report) {
                    this._qsoContext.reportReceived = messageFromTarget.report;
                    this.updateQSOState(QSOState.EXCHANGING_REPORT);
                }
                // 如果收到对我们呼叫的响应（包含网格），说明对方响应了我们，我们应该发送信号报告
                else if (messageFromTarget.type === FT8MessageType.RESPONSE && 
                         messageFromTarget.callsign1 === this._callsign && 
                         messageFromTarget.callsign2 === this._qsoContext.targetCallsign &&
                         messageFromTarget.grid) {
                    this._qsoContext.reportSent = FT8MessageParser.generateSignalReport(messageFromTarget.snr || 0);
                    this.updateQSOState(QSOState.EXCHANGING_REPORT);
                }
                break;

            case QSOState.EXCHANGING_REPORT:
                if (messageFromTarget.type === FT8MessageType.RRR || messageFromTarget.type === FT8MessageType.SEVENTY_THREE) {
                    this.updateQSOState(QSOState.CONFIRMING);
                }
                break;

            case QSOState.CONFIRMING:
                if (messageFromTarget.type === FT8MessageType.SEVENTY_THREE) {
                    this.updateQSOState(QSOState.COMPLETED);
                }
                break;
        }
    }
    
    public getNextTransmission(): string | null {
        if (this._manualNextMessage) {
            return this._manualNextMessage; 
        }

        if (this._transmissionStrategy) {
            return this._transmissionStrategy.decideNextMessage(
                { ...this._qsoContext }, 
                this._qsoContext.lastReceivedMessageFromTarget 
            );
        }
        
        return null;
    }

    public handleCycleEnd(didTransmit: boolean, transmittedMessage: string | null): void {
        // 清除手动消息
        if (didTransmit && transmittedMessage && this._manualNextMessage === transmittedMessage) {
            this._manualNextMessage = null;
        }

        // 特殊处理：在CONFIRMING状态下发送73或RR73后，认为QSO完成
        if (didTransmit && transmittedMessage && 
            this._qsoContext.currentState === QSOState.CONFIRMING &&
            (transmittedMessage.includes('73') || transmittedMessage.includes('RR73'))) {
            this.updateQSOState(QSOState.COMPLETED);
            return; // 直接返回，不再进行其他检查
        }

        // 额外处理：在EXCHANGING_REPORT状态下发送RR73也应该完成QSO
        if (didTransmit && transmittedMessage && 
            this._qsoContext.currentState === QSOState.EXCHANGING_REPORT &&
            transmittedMessage.includes('RR73')) {
            this.updateQSOState(QSOState.COMPLETED);
            return; // 直接返回，不再进行其他检查
        }

        // 更新发射相关计数器
        if (didTransmit && transmittedMessage) {
            this._qsoContext.lastTransmission = transmittedMessage;
            this._qsoContext.cyclesSinceLastTransmission = 0;
            this._qsoContext.transmissionAttempts++;
        } else {
            this._qsoContext.cyclesSinceLastTransmission++;
        }

        // 更新接收计数器
        if (this._qsoContext.targetCallsign) {
            this._qsoContext.cyclesSinceLastReceptionFromTarget++;
        }

        // 检查超时和失败条件
        this.checkQSOTimeout();
        
        // 处理QSO结束后的自动CQ
        this.handleAutoResumeCQ();
    }

    private checkQSOTimeout(): void {
        if (!this._qsoContext.targetCallsign || 
            this._qsoContext.currentState === QSOState.COMPLETED || 
            this._qsoContext.currentState === QSOState.FAILED) {
            return;
        }

        // 特殊处理CONFIRMING状态：在这个状态下QSO基本已经成功
        // 如果长时间没收到最后的73，可以认为QSO成功完成
        if (this._qsoContext.currentState === QSOState.CONFIRMING) {
            // 在CONFIRMING状态下给更长的宽限期
            const confirmingTimeoutCycles = this._qsoContext.timeoutCycles * 2;
            if (this._qsoContext.cyclesSinceLastReceptionFromTarget >= confirmingTimeoutCycles) {
                console.log(`RadioOperator(${this._callsign}): CONFIRMING状态超时，认为QSO已完成 (${this._qsoContext.cyclesSinceLastReceptionFromTarget}/${confirmingTimeoutCycles} 周期)`);
                this.updateQSOState(QSOState.COMPLETED);
            }
            return;
        }

        // 检查最大尝试次数 - 这是主要的失败条件
        if (this._qsoContext.transmissionAttempts >= this._config.maxCallAttempts) {
            console.log(`RadioOperator(${this._callsign}): QSO with ${this._qsoContext.targetCallsign} 失败 - 达到最大尝试次数 (${this._qsoContext.transmissionAttempts}/${this._config.maxCallAttempts})`);
            this.updateQSOState(QSOState.FAILED);
            return;
        }

        // 检查接收超时 - 这是最终的安全网，应该是很长的时间
        // 只有在极端情况下（比如对方完全失联很长时间）才会触发
        if (this._qsoContext.cyclesSinceLastReceptionFromTarget >= this._qsoContext.timeoutCycles) {
            console.log(`RadioOperator(${this._callsign}): QSO with ${this._qsoContext.targetCallsign} 失败 - 长时间未收到回应 (${this._qsoContext.cyclesSinceLastReceptionFromTarget}/${this._qsoContext.timeoutCycles} 周期)`);
            this.updateQSOState(QSOState.FAILED);
        }
    }

    private handleAutoResumeCQ(): void {
        const state = this._qsoContext.currentState;
        
        if (state === QSOState.FAILED && this._config.autoResumeCQAfterFail) {
            console.log(`RadioOperator(${this._callsign}): QSO失败，自动恢复CQ`);
            this.updateQSOState(QSOState.CALLING_CQ);
        } else if (state === QSOState.COMPLETED && this._config.autoResumeCQAfterSuccess) {
            console.log(`RadioOperator(${this._callsign}): QSO完成，自动恢复CQ`);
            this.updateQSOState(QSOState.CALLING_CQ);
        } else if ((state === QSOState.FAILED || state === QSOState.COMPLETED) && 
                   !((state === QSOState.FAILED && this._config.autoResumeCQAfterFail) || 
                     (state === QSOState.COMPLETED && this._config.autoResumeCQAfterSuccess))) {
            this.updateQSOState(QSOState.LISTENING);
        }
    }

    public endQSO(fail: boolean = false, reason?: string): void {
        const currentState = this._qsoContext.currentState;
        const target = this._qsoContext.targetCallsign;
        
        // 如果不能结束QSO（已经是终止状态或非活动状态），直接返回
        if (!this.canEndQSO()) {
            console.log(`RadioOperator(${this._callsign}): 当前状态 ${currentState} 不能手动结束QSO`);
            return;
        }
        
        // 记录手动结束的原因
        const finalState = fail ? QSOState.FAILED : QSOState.COMPLETED;
        const reasonText = reason ? ` - 原因: ${reason}` : ' - 手动结束';
        
        console.log(`RadioOperator(${this._callsign}): 手动结束QSO with ${target || '未知'} -> ${finalState}${reasonText}`);
        
        this.updateQSOState(finalState, false, target);
    }

    /**
     * 检查当前是否可以安全结束QSO
     * @returns true if QSO can be safely ended
     */
    public canEndQSO(): boolean {
        const state = this._qsoContext.currentState;
        return state !== QSOState.COMPLETED && 
               state !== QSOState.FAILED && 
               state !== QSOState.LISTENING && 
               state !== QSOState.IDLE;
    }

    /**
     * 获取当前QSO的进度信息，用于UI显示
     */
    public getQSOProgress(): {
        state: QSOState;
        target?: string;
        canEnd: boolean;
        isActive: boolean;
    } {
        return {
            state: this._qsoContext.currentState,
            target: this._qsoContext.targetCallsign,
            canEnd: this.canEndQSO(),
            isActive: this._qsoContext.currentState !== QSOState.LISTENING && 
                     this._qsoContext.currentState !== QSOState.IDLE &&
                     this._qsoContext.currentState !== QSOState.COMPLETED &&
                     this._qsoContext.currentState !== QSOState.FAILED
        };
    }

    public getQSOState(): QSOState {
        return this._qsoContext.currentState;
    }
}