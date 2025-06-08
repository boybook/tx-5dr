import { ParsedFT8Message, QSOCommand, StrategiesResult, SlotInfo, FrameMessage } from "@tx5dr/contracts";

/**
 * 传输策略接口，定义了如何根据当前QSO上下文和收到的消息来决定下一条要发送的FT8消息。
 * 也提供了处理手动消息覆盖和QSO状态变化的回调。
 */
export interface ITransmissionStrategy {
    /**
     * 根据当前QSO上下文和最后接收到的来自目标的消息，决定下一条要发送的FT8消息。
     * @param context 当前QSO上下文的只读副本。
     * @param lastMessageFromTarget 从当前目标接收到的最后一条消息 (如果存在)。
     * @returns 要发送的FT8消息字符串，如果为null，表示直接停止发射。
     */
    handleReceivedAndDicideNext(messages: ParsedFT8Message[]): Promise<StrategiesResult>;

    /**
     * 请求呼叫一个呼号
     * @param callsign 呼号
     * @param lastMessage 从目标接收到的最后一条消息
     */
    requestCall(callsign: string, lastMessage: { message: FrameMessage, slotInfo: SlotInfo } | undefined): void;

    /**
     * 当用户手动设置了下一条要发送的消息时调用此方法。
     * 策略可以选择基于此手动消息更新其内部状态或行为。
     * @param command 用户设置的手动消息。
     * @returns 返回值可以是任何类型，用于与前端通信。
     */
    userCommand?(command: QSOCommand): any;

    /**
     * 处理发射时隙
     * 如果返回null，表示不发射
     * 如果返回字符串，表示发射该字符串
     */
    handleTransmitSlot(): string | null;
} 