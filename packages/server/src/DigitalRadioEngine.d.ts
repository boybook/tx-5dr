import { type ModeDescriptor, type SlotPack, type DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
/**
 * 时钟管理器 - 管理 TX-5DR 的时钟系统
 */
export declare class DigitalRadioEngine extends EventEmitter<DigitalRadioEngineEvents> {
    private static instance;
    private slotClock;
    private slotScheduler;
    private clockSource;
    private currentMode;
    private isRunning;
    private audioStarted;
    private audioStreamManager;
    private realDecodeQueue;
    private slotPackManager;
    private constructor();
    /**
     * 获取单例实例
     */
    static getInstance(): DigitalRadioEngine;
    /**
     * 初始化时钟管理器
     */
    initialize(): Promise<void>;
    /**
     * 启动时钟
     */
    start(): Promise<void>;
    /**
     * 停止时钟
     */
    stop(): Promise<void>;
    /**
     * 切换模式
     */
    setMode(mode: ModeDescriptor): Promise<void>;
    /**
     * 获取当前状态
     */
    getStatus(): {
        isRunning: boolean;
        isDecoding: boolean;
        currentMode: {
            name: string;
            slotMs: number;
            toleranceMs: number;
            windowTiming: number[];
        };
        currentTime: number;
        nextSlotIn: number;
        audioStarted: boolean;
    };
    /**
     * 获取可用的模式列表
     */
    getAvailableModes(): ModeDescriptor[];
    /**
     * 获取活跃的时隙包
     */
    getActiveSlotPacks(): SlotPack[];
    /**
     * 获取指定时隙包
     */
    getSlotPack(slotId: string): SlotPack | null;
    /**
     * 销毁时钟管理器
     */
    destroy(): Promise<void>;
}
//# sourceMappingURL=DigitalRadioEngine.d.ts.map