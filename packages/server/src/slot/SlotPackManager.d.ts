import { EventEmitter } from 'eventemitter3';
import type { SlotPack, DecodeResult } from '@tx5dr/contracts';
export interface SlotPackManagerEvents {
    'slotPackUpdated': (slotPack: SlotPack) => void;
}
/**
 * 时隙包管理器 - 管理同一时隙内的多次解码结果
 * 负责去重、优化选择和维护最优解码结果
 */
export declare class SlotPackManager extends EventEmitter<SlotPackManagerEvents> {
    private slotPacks;
    constructor();
    /**
     * 处理解码结果，更新对应的 SlotPack
     */
    processDecodeResult(result: DecodeResult): SlotPack;
    /**
     * 创建新的 SlotPack
     */
    private createSlotPack;
    /**
     * 去重和优化帧数据
     * 基于消息内容、频率和 SNR 进行去重，保留最优的帧
     * 按照添加顺序排列，而不是按信号强度排序
     */
    private deduplicateAndOptimizeFrames;
    /**
     * 从同一消息的多个帧中选择最优的一个
     */
    private selectBestFrame;
    /**
     * 获取当前所有活跃的时隙包
     */
    getActiveSlotPacks(): SlotPack[];
    /**
     * 获取指定时隙包
     */
    getSlotPack(slotId: string): SlotPack | null;
    /**
     * 清理指定时隙包
     */
    removeSlotPack(slotId: string): boolean;
    /**
     * 清理过期的时隙包（超过指定时间的）
     */
    cleanupExpiredSlotPacks(maxAgeMs?: number): number;
    /**
     * 清理所有时隙包
     */
    cleanup(): void;
}
//# sourceMappingURL=SlotPackManager.d.ts.map