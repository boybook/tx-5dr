import { QSOState, QSOContext, ParsedFT8Message, FT8MessageType } from '@tx5dr/contracts';

// QSO状态机事件类型
export enum QSOEvent {
  START_CQ = 'start_cq',
  RECEIVE_RESPONSE = 'receive_response',
  SEND_REPORT = 'send_report',
  RECEIVE_REPORT = 'receive_report',
  SEND_CONFIRMATION = 'send_confirmation',
  RECEIVE_CONFIRMATION = 'receive_confirmation',
  TIMEOUT = 'timeout',
  RESET = 'reset',
  COMPLETE = 'complete',
}

// 状态转换规则
const STATE_TRANSITIONS: Record<QSOState, Partial<Record<QSOEvent, QSOState>>> = {
  [QSOState.IDLE]: {
    [QSOEvent.START_CQ]: QSOState.CALLING_CQ,
    [QSOEvent.RECEIVE_RESPONSE]: QSOState.RESPONDING,
  },
  [QSOState.LISTENING]: {
    [QSOEvent.RECEIVE_RESPONSE]: QSOState.RESPONDING,
    [QSOEvent.START_CQ]: QSOState.CALLING_CQ,
    [QSOEvent.RESET]: QSOState.IDLE,
  },
  [QSOState.CALLING_CQ]: {
    [QSOEvent.RECEIVE_RESPONSE]: QSOState.EXCHANGING_REPORT,
    [QSOEvent.TIMEOUT]: QSOState.LISTENING,
    [QSOEvent.RESET]: QSOState.IDLE,
  },
  [QSOState.RESPONDING]: {
    [QSOEvent.SEND_REPORT]: QSOState.EXCHANGING_REPORT,
    [QSOEvent.TIMEOUT]: QSOState.LISTENING,
    [QSOEvent.RESET]: QSOState.IDLE,
  },
  [QSOState.EXCHANGING_REPORT]: {
    [QSOEvent.RECEIVE_REPORT]: QSOState.CONFIRMING,
    [QSOEvent.SEND_CONFIRMATION]: QSOState.CONFIRMING,
    [QSOEvent.TIMEOUT]: QSOState.FAILED,
    [QSOEvent.RESET]: QSOState.IDLE,
  },
  [QSOState.CONFIRMING]: {
    [QSOEvent.RECEIVE_CONFIRMATION]: QSOState.COMPLETED,
    [QSOEvent.COMPLETE]: QSOState.COMPLETED,
    [QSOEvent.TIMEOUT]: QSOState.FAILED,
    [QSOEvent.RESET]: QSOState.IDLE,
  },
  [QSOState.COMPLETED]: {
    [QSOEvent.RESET]: QSOState.IDLE,
  },
  [QSOState.FAILED]: {
    [QSOEvent.RESET]: QSOState.IDLE,
  },
};

// QSO状态机类
export class QSOStateMachine {
  private context: QSOContext;
  private listeners: Array<(oldState: QSOState, newState: QSOState, context: QSOContext) => void> = [];

  constructor(initialContext: Omit<QSOContext, 'currentState'>) {
    this.context = {
      ...initialContext,
      currentState: QSOState.IDLE,
    };
  }

  // 获取当前状态
  getCurrentState(): QSOState {
    return this.context.currentState;
  }

  // 获取当前上下文
  getContext(): QSOContext {
    return { ...this.context };
  }

  // 更新上下文
  updateContext(updates: Partial<QSOContext>): void {
    this.context = { ...this.context, ...updates };
  }

  // 处理事件
  handleEvent(event: QSOEvent, message?: ParsedFT8Message): boolean {
    const currentState = this.context.currentState;
    const transitions = STATE_TRANSITIONS[currentState];
    const nextState = transitions?.[event];

    if (!nextState) {
      console.warn(`Invalid transition: ${currentState} -> ${event}`);
      return false;
    }

    // 执行状态转换前的逻辑
    this.onStateExit(currentState, event, message);
    
    // 更新状态
    const oldState = this.context.currentState;
    this.context.currentState = nextState;
    
    // 执行状态转换后的逻辑
    this.onStateEnter(nextState, event, message);
    
    // 通知监听器
    this.notifyListeners(oldState, nextState);
    
    return true;
  }

  // 处理接收到的FT8消息
  handleMessage(message: ParsedFT8Message): void {
    const currentState = this.context.currentState;
    
    // 根据消息类型和当前状态决定事件
    switch (message.type) {
      case FT8MessageType.CQ:
      case FT8MessageType.CQ_DX:
        if (currentState === QSOState.LISTENING || currentState === QSOState.IDLE) {
          // 如果消息中包含我们的呼号，则响应
          if (this.isMessageForMe(message)) {
            this.updateContext({ targetCallsign: message.callsign1 });
            this.handleEvent(QSOEvent.RECEIVE_RESPONSE, message);
          }
        }
        break;
        
      case FT8MessageType.RESPONSE:
        if (currentState === QSOState.CALLING_CQ && this.isMessageForMe(message)) {
          this.updateContext({ targetCallsign: message.callsign1 });
          this.handleEvent(QSOEvent.RECEIVE_RESPONSE, message);
        }
        break;
        
      case FT8MessageType.SIGNAL_REPORT:
        if (this.isMessageForMe(message) && message.callsign1 === this.context.targetCallsign) {
          this.updateContext({ reportReceived: message.report });
          this.handleEvent(QSOEvent.RECEIVE_REPORT, message);
        }
        break;
        
      case FT8MessageType.ROGER_REPORT:
      case FT8MessageType.RRR:
        if (this.isMessageForMe(message) && message.callsign1 === this.context.targetCallsign) {
          this.handleEvent(QSOEvent.RECEIVE_CONFIRMATION, message);
        }
        break;
        
      case FT8MessageType.SEVENTY_THREE:
        if (this.isMessageForMe(message) && message.callsign1 === this.context.targetCallsign) {
          this.handleEvent(QSOEvent.COMPLETE, message);
        }
        break;
    }
  }

  // 检查消息是否是发给我们的
  private isMessageForMe(message: ParsedFT8Message): boolean {
    return message.callsign2 === this.context.myCallsign;
  }

  // 状态退出处理
  private onStateExit(state: QSOState, event: QSOEvent, message?: ParsedFT8Message): void {
    switch (state) {
      case QSOState.CALLING_CQ:
        // 重置周期计数
        this.context.cyclesSinceLastTransmission = 0;
        break;
    }
  }

  // 状态进入处理
  private onStateEnter(state: QSOState, event: QSOEvent, message?: ParsedFT8Message): void {
    switch (state) {
      case QSOState.IDLE:
        // 清理上下文
        this.context.targetCallsign = undefined;
        this.context.reportSent = undefined;
        this.context.reportReceived = undefined;
        this.context.lastTransmission = undefined;
        this.context.cyclesSinceLastTransmission = 0;
        break;
        
      case QSOState.EXCHANGING_REPORT:
        // 如果我们收到了响应，准备发送信号报告
        if (event === QSOEvent.RECEIVE_RESPONSE && message) {
          this.context.reportSent = this.generateSignalReport();
        }
        break;
    }
  }

  // 生成信号报告
  private generateSignalReport(): string {
    // 简单的信号报告生成，实际应用中可能需要更复杂的逻辑
    return '-15'; // 默认-15dB
  }

  // 添加状态变化监听器
  addStateChangeListener(listener: (oldState: QSOState, newState: QSOState, context: QSOContext) => void): void {
    this.listeners.push(listener);
  }

  // 移除状态变化监听器
  removeStateChangeListener(listener: (oldState: QSOState, newState: QSOState, context: QSOContext) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  // 通知所有监听器
  private notifyListeners(oldState: QSOState, newState: QSOState): void {
    this.listeners.forEach(listener => {
      try {
        listener(oldState, newState, this.getContext());
      } catch (error) {
        console.error('Error in state change listener:', error);
      }
    });
  }

  // 重置状态机
  reset(): void {
    this.handleEvent(QSOEvent.RESET);
  }

  // 检查是否需要超时
  checkTimeout(): void {
    if (this.context.cyclesSinceLastTransmission >= this.context.timeoutCycles) {
      this.handleEvent(QSOEvent.TIMEOUT);
    }
  }

  // 增加周期计数
  incrementCycle(): void {
    this.context.cyclesSinceLastTransmission++;
    this.checkTimeout();
  }
} 