import { SlotClock, SlotScheduler, ClockSourceSystem, } from '@tx5dr/core';
import { MODES } from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import { AudioStreamManager } from './audio/AudioStreamManager.js';
import { WSJTXDecodeWorkQueue } from './decode/WSJTXDecodeWorkQueue.js';
import { SlotPackManager } from './slot/SlotPackManager.js';
import { ConfigManager } from './config/config-manager.js';
/**
 * 时钟管理器 - 管理 TX-5DR 的时钟系统
 */
export class DigitalRadioEngine extends EventEmitter {
    constructor() {
        super();
        this.slotClock = null;
        this.slotScheduler = null;
        this.currentMode = MODES.FT8;
        this.isRunning = false;
        this.audioStarted = false;
        this.clockSource = new ClockSourceSystem();
        this.audioStreamManager = new AudioStreamManager();
        this.realDecodeQueue = new WSJTXDecodeWorkQueue(4); // 4个并发工作线程
        this.slotPackManager = new SlotPackManager();
    }
    /**
     * 获取单例实例
     */
    static getInstance() {
        if (!DigitalRadioEngine.instance) {
            DigitalRadioEngine.instance = new DigitalRadioEngine();
        }
        return DigitalRadioEngine.instance;
    }
    /**
     * 初始化时钟管理器
     */
    async initialize() {
        console.log('🕐 [时钟管理器] 正在初始化...');
        // 创建 SlotClock
        this.slotClock = new SlotClock(this.clockSource, this.currentMode);
        // 监听时钟事件
        this.slotClock.on('slotStart', (slotInfo) => {
            console.log(`🎯 [时隙开始] ID: ${slotInfo.id}, 开始时间: ${new Date(slotInfo.startMs).toISOString()}, 相位: ${slotInfo.phaseMs}ms, 漂移: ${slotInfo.driftMs}ms`);
            this.emit('slotStart', slotInfo);
        });
        this.slotClock.on('subWindow', (slotInfo, windowIdx) => {
            const totalWindows = this.currentMode.windowTiming?.length || 0;
            console.log(`🔍 [子窗口] 时隙: ${slotInfo.id}, 窗口: ${windowIdx}/${totalWindows}, 开始: ${new Date(slotInfo.startMs).toISOString()}`);
            this.emit('subWindow', { slotInfo, windowIdx });
        });
        // 创建 SlotScheduler - 使用真实的音频和解码系统
        this.slotScheduler = new SlotScheduler(this.slotClock, this.realDecodeQueue, this.audioStreamManager.getAudioProvider());
        // 监听解码结果并通过 SlotPackManager 处理
        this.realDecodeQueue.on('decodeComplete', (result) => {
            // 简化单次解码完成的日志
            // console.log(`🔧 [时钟管理器] 解码完成: 时隙=${result.slotId}, 窗口=${result.windowIdx}, 信号数=${result.frames.length}`);
            // 通过 SlotPackManager 处理解码结果
            const updatedSlotPack = this.slotPackManager.processDecodeResult(result);
            // SlotPackManager 会处理详细的日志输出
        });
        this.realDecodeQueue.on('decodeError', (error, request) => {
            console.error(`💥 [时钟管理器] 解码错误: 时隙=${request.slotId}, 窗口=${request.windowIdx}:`, error.message);
            this.emit('decodeError', { error, request });
        });
        // 监听 SlotPackManager 事件
        this.slotPackManager.on('slotPackUpdated', (slotPack) => {
            console.log(`📦 [时钟管理器] 时隙包更新事件: ${slotPack.slotId}`);
            console.log(`   当前状态: ${slotPack.frames.length}个信号, 解码${slotPack.stats.totalDecodes}次`);
            // 如果有解码结果，显示标准格式的解码输出
            if (slotPack.frames.length > 0) {
                // 使用时隙开始时间而不是当前时间
                const slotStartTime = new Date(slotPack.startMs);
                for (const frame of slotPack.frames) {
                    // 格式: HHMMSS SNR DT FREQ ~ MESSAGE
                    const utcTime = slotStartTime.toISOString().slice(11, 19).replace(/:/g, '').slice(0, 6); // HHMMSS
                    const snr = frame.snr >= 0 ? ` ${frame.snr}` : `${frame.snr}`; // SNR 带符号
                    const dt = frame.dt.toFixed(1).padStart(5); // 时间偏移，1位小数，5位宽度
                    const freq = Math.round(frame.freq).toString().padStart(4); // 频率，4位宽度
                    const message = frame.message; // 消息不需要填充
                    console.log(` - ${utcTime} ${snr.padStart(3)} ${dt} ${freq} ~  ${message}`);
                }
            }
            this.emit('slotPackUpdated', slotPack);
        });
        console.log(`✅ [时钟管理器] 初始化完成，当前模式: ${this.currentMode.name}`);
    }
    /**
     * 启动时钟
     */
    async start() {
        if (this.isRunning) {
            console.log('⚠️  [时钟管理器] 时钟已经在运行中');
            return;
        }
        if (!this.slotClock) {
            throw new Error('时钟管理器未初始化');
        }
        console.log(`🚀 [时钟管理器] 启动时钟，模式: ${this.currentMode.name}`);
        // 启动音频流
        let audioStarted = false;
        try {
            // 从配置管理器获取音频设备设置
            const configManager = ConfigManager.getInstance();
            const audioConfig = configManager.getAudioConfig();
            console.log(`🎤 [时钟管理器] 使用音频设备配置:`, audioConfig);
            await this.audioStreamManager.startStream(audioConfig.inputDeviceId);
            console.log(`🎤 [时钟管理器] 音频流启动成功`);
            audioStarted = true;
        }
        catch (error) {
            console.error(`❌ [时钟管理器] 音频流启动失败:`, error);
            console.warn(`⚠️ [时钟管理器] 将在没有音频输入的情况下继续运行`);
            // 不抛出错误，让Engine继续运行
        }
        this.slotClock.start();
        // 启动 SlotScheduler
        if (this.slotScheduler) {
            this.slotScheduler.start();
            console.log(`📡 [时钟管理器] 启动解码调度器`);
        }
        this.isRunning = true;
        this.audioStarted = audioStarted;
        // 发射系统状态变化事件
        const status = this.getStatus();
        this.emit('systemStatus', status);
    }
    /**
     * 停止时钟
     */
    async stop() {
        if (!this.isRunning) {
            console.log('⚠️  [时钟管理器] 时钟已经停止');
            return;
        }
        if (this.slotClock) {
            console.log('🛑 [时钟管理器] 停止时钟');
            this.slotClock.stop();
            // 停止 SlotScheduler
            if (this.slotScheduler) {
                this.slotScheduler.stop();
                console.log(`🛑 [时钟管理器] 停止解码调度器`);
            }
            // 停止音频流
            try {
                await this.audioStreamManager.stopStream();
                console.log(`🛑 [时钟管理器] 音频流停止成功`);
            }
            catch (error) {
                console.error(`❌ [时钟管理器] 音频流停止失败:`, error);
            }
            this.isRunning = false;
            this.audioStarted = false; // 重置音频状态
            // 发射系统状态变化事件
            const status = this.getStatus();
            this.emit('systemStatus', status);
        }
    }
    /**
     * 切换模式
     */
    async setMode(mode) {
        if (this.currentMode.name === mode.name) {
            console.log(`⚠️  [时钟管理器] 已经是 ${mode.name} 模式`);
            return;
        }
        const wasRunning = this.isRunning;
        // 如果正在运行，先停止
        if (wasRunning) {
            await this.stop();
        }
        console.log(`🔄 [时钟管理器] 切换模式: ${this.currentMode.name} -> ${mode.name}`);
        this.currentMode = mode;
        // 重新创建 SlotClock
        if (this.slotClock) {
            this.slotClock.removeAllListeners();
        }
        this.slotClock = new SlotClock(this.clockSource, this.currentMode);
        // 重新绑定事件
        this.slotClock.on('slotStart', (slotInfo) => {
            console.log(`🎯 [时隙开始] ID: ${slotInfo.id}, 开始时间: ${new Date(slotInfo.startMs).toISOString()}, 相位: ${slotInfo.phaseMs}ms, 漂移: ${slotInfo.driftMs}ms`);
            this.emit('slotStart', slotInfo);
        });
        this.slotClock.on('subWindow', (slotInfo, windowIdx) => {
            const totalWindows = this.currentMode.windowTiming?.length || 0;
            console.log(`🔍 [子窗口] 时隙: ${slotInfo.id}, 窗口: ${windowIdx}/${totalWindows}, 开始: ${new Date(slotInfo.startMs).toISOString()}`);
            this.emit('subWindow', { slotInfo, windowIdx });
        });
        // 重新创建 SlotScheduler
        if (this.slotScheduler) {
            this.slotScheduler = new SlotScheduler(this.slotClock, this.realDecodeQueue, this.audioStreamManager.getAudioProvider());
            if (this.isRunning) {
                this.slotScheduler.start();
                console.log(`📡 [时钟管理器] 重新启动解码调度器`);
            }
        }
        this.emit('modeChanged', mode);
        // 如果之前在运行，重新启动
        if (wasRunning) {
            await this.start();
        }
    }
    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            isDecoding: this.slotClock?.isRunning ?? false,
            currentMode: this.currentMode,
            currentTime: this.clockSource.now(),
            nextSlotIn: 0, // 简化实现，暂时返回 0
            audioStarted: this.audioStarted
        };
    }
    /**
     * 获取可用的模式列表
     */
    getAvailableModes() {
        return [
            MODES.FT8,
            MODES.FT4,
            MODES['FT8-MultiWindow'],
            MODES['FT8-HighFreq']
        ];
    }
    /**
     * 获取活跃的时隙包
     */
    getActiveSlotPacks() {
        return this.slotPackManager.getActiveSlotPacks();
    }
    /**
     * 获取指定时隙包
     */
    getSlotPack(slotId) {
        return this.slotPackManager.getSlotPack(slotId);
    }
    /**
     * 销毁时钟管理器
     */
    async destroy() {
        console.log('🗑️  [时钟管理器] 正在销毁...');
        await this.stop();
        // 销毁解码队列
        await this.realDecodeQueue.destroy();
        // 清理 SlotPackManager
        this.slotPackManager.cleanup();
        if (this.slotClock) {
            this.slotClock.removeAllListeners();
            this.slotClock = null;
        }
        this.slotScheduler = null;
        this.removeAllListeners();
        console.log('✅ [时钟管理器] 销毁完成');
    }
}
DigitalRadioEngine.instance = null;
//# sourceMappingURL=DigitalRadioEngine.js.map