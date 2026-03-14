import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { RadioError } from '../utils/errors/RadioError.js';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { FrequencyManager } from '../radio/FrequencyManager.js';
import type { SlotPackManager } from '../slot/SlotPackManager.js';
import type { RadioOperatorManager } from '../operator/RadioOperatorManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { ListenerManager } from './ListenerManager.js';
import type { TransmissionPipeline } from './TransmissionPipeline.js';
import type { EngineLifecycle } from './EngineLifecycle.js';

export interface RadioBridgeDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  radioManager: PhysicalRadioManager;
  frequencyManager: FrequencyManager;
  slotPackManager: SlotPackManager;
  operatorManager: RadioOperatorManager;
  getTransmissionPipeline: () => TransmissionPipeline;
  getEngineLifecycle: () => EngineLifecycle;
}

/**
 * 电台事件桥接子系统
 *
 * 职责：电台事件转发、频率同步、断线恢复、健康检查
 * 监听器是永久的（整个引擎生命周期），不随 start/stop 变化。
 */
export class RadioBridge {
  private lm = new ListenerManager();

  // 高频事件采样监控（用于健康检查）
  private spectrumEventCount: number = 0;
  private meterEventCount: number = 0;
  private lastHealthCheckTimestamp: number = Date.now();

  // 记录断开前是否在运行
  private _wasRunningBeforeDisconnect = false;

  constructor(private deps: RadioBridgeDeps) {}

  get wasRunningBeforeDisconnect(): boolean {
    return this._wasRunningBeforeDisconnect;
  }

  set wasRunningBeforeDisconnect(val: boolean) {
    this._wasRunningBeforeDisconnect = val;
  }

  /**
   * 记录频谱事件（供 ClockCoordinator 调用）
   */
  onSpectrumEvent(): void {
    this.spectrumEventCount++;
    if (this.spectrumEventCount % 100 === 0) {
      this.checkHighFrequencyEventsHealth();
    }
  }

  /**
   * 记录数值表事件（供内部使用）
   */
  private onMeterEvent(): void {
    this.meterEventCount++;
    if (this.meterEventCount % 100 === 0) {
      this.checkHighFrequencyEventsHealth();
    }
  }

  /**
   * 注册所有 RadioManager 事件监听器
   */
  setupListeners(): void {
    const { engineEmitter, radioManager, frequencyManager, slotPackManager, operatorManager } = this.deps;

    // 监听电台连接中
    this.lm.listen(radioManager, 'connecting', () => {
      console.log('📡 [RadioBridge] 物理电台连接中...');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('radioStatusChanged', {
        connected: false,
        status: RadioConnectionStatus.CONNECTING,
        radioInfo: null,
        radioConfig: radioManager.getConfig(),
        connectionHealth: radioManager.getConnectionHealth(),
      });
    });

    // 监听电台连接成功
    this.lm.listen(radioManager, 'connected', async () => {
      console.log('📡 [RadioBridge] 物理电台连接成功');

      const radioInfo = await radioManager.getRadioInfo();
      const radioConfig = radioManager.getConfig();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('radioStatusChanged', {
        connected: true,
        status: RadioConnectionStatus.CONNECTED,
        radioInfo,
        radioConfig,
        connectionHealth: radioManager.getConnectionHealth()
      });

      // 连接成功后自动设置频率
      try {
        const lastFrequency = ConfigManager.getInstance().getLastSelectedFrequency();
        if (lastFrequency && lastFrequency.frequency) {
          console.log(`📡 [RadioBridge] 自动设置频率: ${(lastFrequency.frequency / 1000000).toFixed(3)} MHz (${lastFrequency.description || lastFrequency.mode})`);
          await radioManager.setFrequency(lastFrequency.frequency);
        } else {
          console.log('ℹ️ [RadioBridge] 未找到保存的频率配置，跳过自动设置');
        }
      } catch (err) {
        console.error('❌ [RadioBridge] 自动设置频率失败:', err);
      }

      // 连接成功后恢复之前的运行状态（竞态保护）
      if (this._wasRunningBeforeDisconnect) {
        const lifecycle = this.deps.getEngineLifecycle();
        // 双重检查：不在运行中 且 不在启动中
        const engineState = lifecycle.getEngineState();
        if (!lifecycle.getIsRunning() && engineState !== 'starting') {
          console.log('🚀 [RadioBridge] 电台连接成功，恢复之前的运行状态');
          this._wasRunningBeforeDisconnect = false;
          try {
            await lifecycle.start();
          } catch (err) {
            console.error('❌ [RadioBridge] 自动启动失败:', err);
            this._wasRunningBeforeDisconnect = false;
          }
        } else {
          this._wasRunningBeforeDisconnect = false;
        }
      }
    });

    // 监听电台自动重连中
    this.lm.listen(radioManager, 'reconnecting', (...args: unknown[]) => {
      const attempt = args[0] as number;
      const maxAttempts = args[1] as number;
      const delayMs = args[2] as number | undefined;
      console.log(`🔄 [RadioBridge] 电台重连中 ${attempt}/${maxAttempts}`);

      const lifecycle = this.deps.getEngineLifecycle();

      // 第一次重连尝试时，记录运行状态并停止引擎
      if (attempt === 1) {
        if (lifecycle.getIsRunning()) {
          this._wasRunningBeforeDisconnect = true;
        }
        operatorManager.stopAllOperators();
        const pipeline = this.deps.getTransmissionPipeline();
        if (pipeline.getIsPTTActive()) {
          pipeline.forceStopPTT();
        }
        if (lifecycle.getIsRunning()) {
          lifecycle.sendRadioDisconnected('电台断连，自动重连中');
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('radioStatusChanged', {
        connected: false,
        status: RadioConnectionStatus.RECONNECTING,
        radioInfo: null,
        radioConfig: radioManager.getConfig(),
        message: `正在重新连接电台... (${attempt}/${maxAttempts})`,
        reconnectProgress: { attempt, maxAttempts, nextRetryMs: delayMs },
        connectionHealth: radioManager.getConnectionHealth(),
      });
    });

    // 监听电台断开连接
    this.lm.listen(radioManager, 'disconnected', async (...args: unknown[]) => {
      const reason = args[0] as string | undefined;
      console.log(`📡 [RadioBridge] 物理电台断开连接: ${reason || '未知原因'}`);

      const lifecycle = this.deps.getEngineLifecycle();

      // 记录断开前是否在运行（兜底，reconnecting handler 可能已设置过）
      if (lifecycle.getIsRunning() && !this._wasRunningBeforeDisconnect) {
        this._wasRunningBeforeDisconnect = true;
        console.log('📝 [RadioBridge] 记录断开前运行状态');
      }

      // 立即停止所有操作员的发射
      operatorManager.stopAllOperators();

      const pipeline = this.deps.getTransmissionPipeline();

      // 如果是在PTT激活时断开连接
      if (pipeline.getIsPTTActive()) {
        console.warn('⚠️ [RadioBridge] 电台在发射过程中断开连接，立即停止发射和监听');

        await pipeline.forceStopPTT();

        lifecycle.sendRadioDisconnected(reason || '电台在发射过程中断开连接');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        engineEmitter.emit('radioDisconnectedDuringTransmission', {
          reason: reason || '电台在发射过程中断开连接',
          message: '电台在发射过程中断开连接，可能是发射功率过大导致USB通讯受到干扰。系统已自动停止发射和监听。',
          recommendation: '请检查电台设置，降低发射功率或改善通讯环境，然后重新连接电台。'
        });
      } else if (lifecycle.getIsRunning()) {
        console.warn('⚠️ [RadioBridge] 电台断开连接，自动停止引擎');
        lifecycle.sendRadioDisconnected(reason || '电台断开连接');
      }

      // 区分：曾在运行中断连（CONNECTION_LOST）vs 正常断开（DISCONNECTED）
      const wasReconnecting = this._wasRunningBeforeDisconnect;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('radioStatusChanged', {
        connected: false,
        status: wasReconnecting
          ? RadioConnectionStatus.CONNECTION_LOST
          : RadioConnectionStatus.DISCONNECTED,
        radioInfo: null,
        radioConfig: radioManager.getConfig(),
        reason,
        message: wasReconnecting ? '电台连接丢失' : '电台已断开连接',
        recommendation: this.getDisconnectRecommendation(reason),
        connectionHealth: radioManager.getConnectionHealth()
      });

      this._wasRunningBeforeDisconnect = false;
    });

    // 监听电台错误（提取完整 RadioError 属性 + Profile 关联）
    this.lm.listen(radioManager, 'error', (...args: unknown[]) => {
      const error = args[0] as Error;
      console.error(`📡 [RadioBridge] 物理电台错误: ${error.message}`);

      const configManager = ConfigManager.getInstance();
      const activeProfile = configManager.getActiveProfile();
      const isRadioError = error instanceof RadioError;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('radioError', {
        message: error.message,
        userMessage: isRadioError ? error.userMessage : error.message,
        suggestions: isRadioError ? error.suggestions : [],
        code: isRadioError ? error.code : undefined,
        severity: isRadioError ? error.severity : 'error',
        timestamp: new Date().toISOString(),
        context: isRadioError ? error.context : undefined,
        stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
        connectionHealth: radioManager.getConnectionHealth(),
        profileId: activeProfile?.id ?? null,
        profileName: activeProfile?.name ?? null,
      });
    });

    // 监听电台数值表数据
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.lm.listen(radioManager, 'meterData', (_data: any) => {
      this.onMeterEvent();
    });

    // 监听电台频率变化（自动同步）
    this.lm.listen(radioManager, 'radioFrequencyChanged', async (...args: unknown[]) => {
      const frequency = args[0] as number;
      console.log(`📡 [RadioBridge] 检测到电台频率变化: ${(frequency / 1000000).toFixed(3)} MHz`);

      try {
        const matchResult = frequencyManager.findMatchingPreset(frequency, 500);

        let frequencyInfo: {
          frequency: number;
          mode: string;
          band: string;
          radioMode?: string;
          description: string;
        };

        if (matchResult.preset) {
          console.log(`✅ [RadioBridge] 匹配到预设频率: ${matchResult.preset.description}`);
          frequencyInfo = {
            frequency: matchResult.preset.frequency,
            mode: matchResult.preset.mode,
            band: matchResult.preset.band,
            radioMode: matchResult.preset.radioMode,
            description: matchResult.preset.description || `${(matchResult.preset.frequency / 1000000).toFixed(3)} MHz`
          };
        } else {
          console.log(`🔧 [RadioBridge] 未匹配预设，设为自定义频率`);
          frequencyInfo = {
            frequency: frequency,
            mode: 'FT8',
            band: 'Custom',
            description: `自定义 ${(frequency / 1000000).toFixed(3)} MHz`
          };
        }

        const configManager = ConfigManager.getInstance();
        configManager.updateLastSelectedFrequency({
          frequency: frequencyInfo.frequency,
          mode: frequencyInfo.mode,
          radioMode: frequencyInfo.radioMode,
          band: frequencyInfo.band,
          description: frequencyInfo.description
        });

        slotPackManager.clearInMemory();
        console.log(`🧹 [RadioBridge] 已清空历史解码数据`);

        engineEmitter.emit('frequencyChanged', {
          frequency: frequencyInfo.frequency,
          mode: frequencyInfo.mode,
          band: frequencyInfo.band,
          radioMode: frequencyInfo.radioMode,
          description: frequencyInfo.description,
          radioConnected: true
        });

        console.log(`📡 [RadioBridge] 频率自动同步完成: ${frequencyInfo.description}`);
      } catch (error) {
        console.error(`❌ [RadioBridge] 处理频率变化失败:`, error);
      }
    });

    console.log(`📡 [RadioBridge] 已注册 ${this.lm.count} 个 RadioManager 事件监听器`);
  }

  /**
   * 清理所有监听器
   */
  teardownListeners(): void {
    console.log(`🗑️ [RadioBridge] 移除 ${this.lm.count} 个 RadioManager 事件监听器`);
    this.lm.disposeAll();
  }

  /**
   * 检查高频事件健康状态（采样监控）
   */
  checkHighFrequencyEventsHealth(): void {
    const now = Date.now();
    const timeSinceLastCheck = now - this.lastHealthCheckTimestamp;

    const lifecycle = this.deps.getEngineLifecycle();
    if (!lifecycle.getIsRunning()) {
      return;
    }

    if (timeSinceLastCheck < 10000) {
      return;
    }

    const radioConnected = this.deps.radioManager.isConnected();
    const radioConfig = ConfigManager.getInstance().getRadioConfig();
    // type=none 时电台未连接是正常的，不发出警告
    if (!radioConnected && lifecycle.getIsRunning() && radioConfig.type !== 'none') {
      console.warn('⚠️ [健康检查] 电台未连接，但引擎处于运行状态');
    }

    const spectrumRate = timeSinceLastCheck > 0 ? (this.spectrumEventCount / timeSinceLastCheck) * 1000 : 0;
    const meterRate = timeSinceLastCheck > 0 ? (this.meterEventCount / timeSinceLastCheck) * 1000 : 0;

    if (spectrumRate < 1 && lifecycle.getIsRunning()) {
      console.warn(`⚠️ [健康检查] 频谱事件频率异常低: ${spectrumRate.toFixed(2)} Hz`);
    }

    if (meterRate < 0.5 && lifecycle.getIsRunning() && radioConnected && radioConfig.type !== 'none') {
      console.warn(`⚠️ [健康检查] 数值表事件频率异常低: ${meterRate.toFixed(2)} Hz`);
    }

    console.log(`📊 [健康检查] 高频事件采样统计 (${(timeSinceLastCheck / 1000).toFixed(1)}秒):`);
    console.log(`   频谱事件: ${this.spectrumEventCount} 次 (${spectrumRate.toFixed(1)} Hz)`);
    console.log(`   数值表事件: ${this.meterEventCount} 次 (${meterRate.toFixed(1)} Hz)`);

    this.spectrumEventCount = 0;
    this.meterEventCount = 0;
    this.lastHealthCheckTimestamp = now;
  }

  /**
   * 根据断开原因生成用户友好的解决建议
   */
  private getDisconnectRecommendation(reason?: string): string {
    if (!reason) {
      return '请检查电台是否开机，网络连接是否正常，然后尝试重新连接。';
    }

    const reasonLower = reason.toLowerCase();

    if (reasonLower.includes('usb') || reasonLower.includes('通讯') || reasonLower.includes('通信')) {
      return '可能是USB通讯不稳定。请检查USB线缆连接，尝试更换USB端口或使用更短的USB线。';
    }

    if (reasonLower.includes('network') || reasonLower.includes('网络') || reasonLower.includes('timeout') || reasonLower.includes('超时')) {
      return '可能是网络连接问题。请检查WiFi连接，确认电台和电脑在同一网络，检查防火墙设置。';
    }

    if (reasonLower.includes('disconnect()') || reasonLower.includes('用户') || reasonLower.includes('手动')) {
      return '连接已按要求断开。如需重新连接，请点击"连接电台"按钮。';
    }

    if (reasonLower.includes('timeout') || reasonLower.includes('超时') || reasonLower.includes('timed out')) {
      return '连接超时。请检查电台是否开机，网络或串口连接是否正常，然后重试。';
    }

    if (reasonLower.includes('io error') || reasonLower.includes('i/o') || reasonLower.includes('设备')) {
      return '设备IO错误。请检查电台连接（USB/网络），确认电台开机并工作正常，然后重新连接。';
    }

    if (reasonLower.includes('功率') || reasonLower.includes('power') || reasonLower.includes('干扰')) {
      return '可能是发射功率过大导致干扰。请降低发射功率（建议50W以下），改善通讯环境，然后重新连接。';
    }

    return `连接已断开（${reason}）。请检查电台连接和设置，然后尝试重新连接。`;
  }
}
