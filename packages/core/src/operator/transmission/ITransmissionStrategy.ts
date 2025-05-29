import { QSOContext, ParsedFT8Message, QSOState, EnrichedParsedFT8Message } from "@tx5dr/contracts";

/**
 * 传输策略接口，定义了如何根据当前QSO上下文和收到的消息来决定下一条要发送的FT8消息。
 * 也提供了处理手动消息覆盖和QSO状态变化的回调。
 */
export interface ITransmissionStrategy {
    /**
     * 根据当前QSO上下文和最后接收到的来自目标的消息，决定下一条要发送的FT8消息。
     * @param context 当前QSO上下文的只读副本。
     * @param lastMessageFromTarget 从当前目标接收到的最后一条消息 (如果存在)。
     * @returns 要发送的FT8消息字符串，如果当前不应发送任何消息，则返回 null。
     */
    decideNextMessage(
        context: Readonly<QSOContext>,
        lastMessageFromTarget?: Readonly<EnrichedParsedFT8Message | ParsedFT8Message> 
    ): string | null;

    /**
     * 当用户手动设置了下一条要发送的消息时调用此方法。
     * 策略可以选择基于此手动消息更新其内部状态或行为。
     * @param manualMessage 用户设置的手动消息。
     * @param context 当前QSO上下文的只读副本。
     */
    onManualMessageOverride?(manualMessage: string, context: Readonly<QSOContext>): void;

    /**
     * 当QSO状态发生变化时调用此方法。
     * 策略可以利用此信息来重置或调整其内部逻辑。
     * @param newState 新的QSO状态。
     * @param context 当前QSO上下文的只读副本。
     */
    onQSOStateChanged?(newState: QSOState, context: Readonly<QSOContext>): void;
} 