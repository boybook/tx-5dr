# ICOM WLAN 电台连接模式实施文档

## ✅ 已完成的工作

### 1. **Contracts 层（Schema 定义）**
- ✅ 扩展 `HamlibConfig` Schema：
  - 新增 `type: 'icom-wlan'` 枚举值
  - 新增字段：`ip`、`wlanPort`、`userName`、`password`
- ✅ 保持向后兼容性

**位置**: `packages/contracts/src/schema/radio.schema.ts`

---

### 2. **Server 核心实现**

#### 2.1 ✅ **IcomWlanManager 类**（新文件）
负责 ICOM 电台的连接、控制和状态管理。

**位置**: `packages/server/src/radio/IcomWlanManager.ts`

**功能**：
- 连接/断开 ICOM 电台
- CI-V 命令收发（频率、模式、PTT）
- 音频事件订阅
- 连接状态监控和自动重连
- 错误处理和连接丢失检测

**关键方法**：
- `connect(config)` - 连接到 ICOM 设备
- `disconnect(reason?)` - 断开连接
- `setFrequency(freq)` - 设置频率
- `getFrequency()` - 获取频率
- `setMode(mode, dataMode)` - 设置模式
- `getMode()` - 获取模式
- `setPTT(state)` - 控制 PTT
- `sendAudio(samples)` - 发送音频数据
- `testConnection()` - 测试连接

---

#### 2.2 ✅ **IcomWlanAudioAdapter 类**（新文件）
负责音频流的接收、发送和采样率转换（12kHz ↔ 48kHz）。

**位置**: `packages/server/src/audio/IcomWlanAudioAdapter.ts`

**功能**：
- 接收 ICOM 12kHz 音频 → 重采样到 48kHz → 存储到环形缓冲区
- 混音输出 48kHz → 重采样到 12kHz → 发送到 ICOM
- 使用 `@alexanderolsen/libsamplerate-js` 进行高质量重采样
- 备用线性插值方案

**关键方法**：
- `startReceiving()` - 开始接收音频
- `stopReceiving()` - 停止接收
- `sendAudio(samples)` - 发送音频（用于发射）
- `getAudioProvider()` - 获取音频缓冲区提供者

---

#### 2.3 ✅ **PhysicalRadioManager 修改**
整合 ICOM WLAN 管理器，提供统一的电台控制接口。

**位置**: `packages/server/src/radio/PhysicalRadioManager.ts`

**修改内容**：
- 添加 `IcomWlanManager` 实例
- 修改 `applyConfig()` 支持 `icom-wlan` 类型
- 修改所有方法代理到正确的管理器：
  - `setFrequency()`, `getFrequency()`
  - `setPTT()`, `setMode()`, `getMode()`
  - `testConnection()`, `disconnect()`, `isConnected()`
- 添加 `getIcomWlanManager()` 方法供音频适配器使用
- 设置事件转发

---

#### 2.4 ✅ **AudioDeviceManager 修改**
注入 ICOM WLAN 虚拟设备到音频设备列表。

**位置**: `packages/server/src/audio/audio-device-manager.ts`

**修改内容**：
- 添加 `setIcomWlanConnectedCallback()` 回调设置
- 添加 `shouldShowIcomWlanDevice()` 检查逻辑
- 修改 `getAllDevices()` 动态注入虚拟设备：
  ```typescript
  {
    id: 'icom-wlan-input',
    name: 'ICOM WLAN',
    channels: 1,
    sampleRate: 12000,
    type: 'input'
  }
  ```

---

### 3. **Web 前端实现**

#### 3.1 ✅ **RadioDeviceSettings 组件修改**
添加 ICOM WLAN 配置 UI。

**位置**: `packages/web/src/components/RadioDeviceSettings.tsx`

**修改内容**：
- 新增 `<Tab key="icom-wlan" title="📡 ICOM WLAN" />`
- 新增 ICOM WLAN 配置表单：
  - IP 地址输入
  - 端口输入（默认 50001）
  - 用户名输入
  - 密码输入
  - 发射时序补偿配置
  - 测试连接按钮
  - 测试 PTT 按钮

---

## ⚠️ 待完成的工作

### 4. **AudioStreamManager 音频路由** ⏳

**位置**: `packages/server/src/audio/AudioStreamManager.ts`

**需要修改**：

1. **在 `startStream()` 方法中**，检测 ICOM WLAN 虚拟设备：
```typescript
// 在解析设备 ID 后添加检查
if (resolvedDeviceId === 'icom-wlan-input') {
  // 使用 IcomWlanAudioAdapter 替代 naudiodon2
  const radioManager = DigitalRadioEngine.getInstance().getRadioManager();
  const icomWlanManager = radioManager.getIcomWlanManager();

  if (icomWlanManager) {
    this.icomWlanAudioAdapter = new IcomWlanAudioAdapter(icomWlanManager, this.sampleRate);
    this.icomWlanAudioAdapter.startReceiving();

    // 订阅音频数据
    this.icomWlanAudioAdapter.on('audioData', (samples) => {
      this.audioProvider.writeAudio(samples);
      this.emit('audioData', samples);
    });

    this.isStreaming = true;
    return;
  }
}

// 否则使用传统的 naudiodon2 流程
```

2. **在 `playAudio()` 方法中**，路由到正确的输出：
```typescript
async playAudio(audioData: Float32Array, sampleRate?: number): Promise<void> {
  // 如果配置了 ICOM WLAN 输出设备
  const configManager = ConfigManager.getInstance();
  const audioConfig = configManager.getAudioConfig();

  if (audioConfig.outputDeviceName === 'ICOM WLAN' && this.icomWlanAudioAdapter) {
    await this.icomWlanAudioAdapter.sendAudio(audioData);
    return;
  }

  // 否则使用传统的 naudiodon2 输出
  // ... 现有代码
}
```

---

### 5. **DigitalRadioEngine 生命周期管理** ⏳

**位置**: `packages/server/src/DigitalRadioEngine.ts`

**需要修改**：

1. 在构造函数中添加 IcomWlanAudioAdapter 实例：
```typescript
private icomWlanAudioAdapter: IcomWlanAudioAdapter | null = null;
```

2. 在 `start()` 方法中初始化：
```typescript
async start(): Promise<void> {
  // ... 现有启动逻辑

  // 如果配置为 ICOM WLAN 模式，初始化音频适配器
  const radioConfig = ConfigManager.getInstance().getRadioConfig();
  if (radioConfig.type === 'icom-wlan') {
    const icomWlanManager = this.radioManager.getIcomWlanManager();
    if (icomWlanManager) {
      this.icomWlanAudioAdapter = new IcomWlanAudioAdapter(
        icomWlanManager,
        this.audioStreamManager.getSampleRate()
      );

      // 设置回调让 AudioDeviceManager 知道连接状态
      const audioDeviceManager = AudioDeviceManager.getInstance();
      audioDeviceManager.setIcomWlanConnectedCallback(() => {
        return icomWlanManager.isConnected();
      });
    }
  }
}
```

3. 在 `stop()` 方法中清理：
```typescript
async stop(): Promise<void> {
  // ... 现有停止逻辑

  // 停止 ICOM WLAN 音频适配器
  if (this.icomWlanAudioAdapter) {
    this.icomWlanAudioAdapter.stopReceiving();
    this.icomWlanAudioAdapter = null;
  }
}
```

---

### 6. **API Routes 扩展** ⏳

**位置**:
- `packages/server/src/routes/radio.ts`
- `packages/server/src/routes/audio.ts`

**需要修改**：

1. **Radio API** - 支持 ICOM WLAN 配置保存/读取（已自动支持，因为 Schema 已扩展）

2. **Audio API** - 确保 `GET /api/audio/devices` 返回包含 ICOM WLAN 虚拟设备的列表（已自动支持，因为 AudioDeviceManager 已修改）

3. **可选**：添加 ICOM WLAN 专用端点：
```typescript
// GET /api/radio/icom-wlan/status
fastify.get('/radio/icom-wlan/status', async () => {
  const radioManager = DigitalRadioEngine.getInstance().getRadioManager();
  const icomWlanManager = radioManager.getIcomWlanManager();

  if (!icomWlanManager) {
    return { connected: false };
  }

  return {
    connected: icomWlanManager.isConnected(),
    reconnectInfo: icomWlanManager.getReconnectInfo()
  };
});
```

---

### 7. **WebSocket 事件同步** ⏳（可选）

**位置**: `packages/server/src/websocket/WSServer.ts`

**需要添加**（可选，用于实时状态更新）：

```typescript
// 在 setupEngineEventListeners() 中添加
this.radioManager.on('connected', () => {
  this.broadcast(WSMessageType.RADIO_CONNECTED, {
    type: ConfigManager.getInstance().getRadioConfig().type
  });
});

this.radioManager.on('disconnected', (reason) => {
  this.broadcast(WSMessageType.RADIO_DISCONNECTED, { reason });
});
```

**对应的前端处理**（在 `packages/core/src/websocket/WSMessageHandler.ts`）：
```typescript
export const WS_MESSAGE_EVENT_MAP: Record<string, string> = {
  // ... 现有映射
  [WSMessageType.RADIO_CONNECTED]: 'radioConnected',
  [WSMessageType.RADIO_DISCONNECTED]: 'radioDisconnected',
};
```

---

### 8. **AudioDeviceSettings 显示优化** ⏳（可选）

**位置**: `packages/web/src/components/AudioDeviceSettings.tsx`

**建议修改**：

当选择 ICOM WLAN 设备时，显示提示信息：
```tsx
{selectedInputDeviceName === 'ICOM WLAN' && (
  <Alert color="info" variant="flat" title="ICOM WLAN 音频">
    使用 ICOM WLAN 内置音频流（12kHz），系统将自动重采样到 48kHz。无需配置采样率和缓冲区大小。
  </Alert>
)}
```

---

## 🔧 构建和测试

### 构建步骤

```bash
# 1. 构建 contracts 包（已完成）
yarn workspace @tx5dr/contracts build

# 2. 构建 server 包（已完成）
yarn workspace @tx5dr/server build

# 3. 构建 web 和 core 包
yarn workspace @tx5dr/core build
yarn workspace @tx5dr/web build

# 4. 完整构建（推荐）
yarn build
```

### 测试步骤

1. **启动开发服务器**：
```bash
yarn dev
```

2. **配置 ICOM WLAN**：
   - 打开设置 → 电台设置
   - 选择"📡 ICOM WLAN"标签页
   - 输入 IP、端口、用户名、密码
   - 点击"测试连接"

3. **配置音频**：
   - 打开设置 → 音频设置
   - 选择"ICOM WLAN"作为输入/输出设备
   - 保存配置

4. **测试功能**：
   - 接收音频：观察 FT8 解码是否正常
   - 发射测试：点击"测试 PTT"
   - 频率设置：尝试修改频率

---

## 📝 使用说明

### 连接 ICOM 电台

1. **准备工作**：
   - 确保 ICOM 电台的 WLAN 功能已启用
   - 获取电台的 IP 地址（通常在电台菜单中查看）
   - 记录用户名和密码（默认可能是 admin/password）

2. **配置连接**：
   - IP 地址：例如 `192.168.1.100`
   - 端口：默认 `50001`
   - 用户名：通常是 `admin`
   - 密码：您设置的密码

3. **时序补偿**：
   - 本地网络：50-100ms
   - 远程网络：100-200ms
   - 根据实际情况微调

### 音频配置

ICOM WLAN 模式下，音频由电台直接提供：
- 接收音频：12kHz PCM → 自动重采样到 48kHz
- 发射音频：48kHz混音 → 自动重采样到 12kHz → 发送到电台

无需单独配置音频设备，只需在音频设置中选择"ICOM WLAN"虚拟设备。

---

## 🐛 故障排查

### 连接失败

1. **检查网络连接**：
   - Ping 电台 IP：`ping 192.168.1.100`
   - 确保在同一网络或可路由

2. **检查认证信息**：
   - 用户名和密码是否正确
   - 某些电台可能需要在电台端启用远程访问

3. **检查端口**：
   - 默认端口是 50001
   - 某些型号可能使用不同端口

### 音频异常

1. **没有音频输入**：
   - 检查 ICOM WLAN 是否已连接
   - 查看 server 日志是否有音频帧接收记录

2. **音频断续**：
   - 检查网络延迟
   - 增加发射时序补偿值
   - 检查电台音频设置

3. **重采样问题**：
   - 查看日志是否有重采样错误
   - 系统会自动使用备用线性插值方案

### 日志查看

```bash
# 查看 server 日志
tail -f logs/server.log

# 查看关键字
grep "IcomWlan" logs/server.log
grep "音频" logs/server.log
```

---

## 📚 技术细节

### 音频采样率转换

**ICOM WLAN 固定采样率**: 12000 Hz
**系统采样率**: 48000 Hz（可配置）

**转换流程**：
1. **接收（12kHz → 48kHz）**:
   - ICOM 设备 → PCM16 Buffer (12kHz)
   - Buffer → Float32Array 转换
   - libsamplerate 重采样 (12kHz → 48kHz)
   - 写入环形缓冲区
   - 解码器读取

2. **发射（48kHz → 12kHz）**:
   - 混音器输出 Float32Array (48kHz)
   - libsamplerate 重采样 (48kHz → 12kHz)
   - 发送到 ICOM 设备

### 连接状态机

```
DISCONNECTED
    ↓ connect()
CONNECTING
    ↓ 成功
CONNECTED
    ↓ 连接丢失
RECONNECTING
    ↓ 重连成功
CONNECTED
    ↓ 手动断开
DISCONNECTED
```

### 事件流

```
IcomControl.events.on('audio')
    ↓
IcomWlanManager.emit('audioFrame')
    ↓
IcomWlanAudioAdapter.handleAudioFrame()
    ↓ 重采样
audioProvider.writeAudio()
    ↓
emit('audioData')
    ↓
AudioStreamManager → DecodeQueue
```

---

## 🎯 后续优化建议

1. **混合模式增强**：
   - 支持 ICOM WLAN 输入 + 传统声卡输出
   - 多输入源混合

2. **性能优化**：
   - 音频缓冲区大小自适应
   - 重采样算法选择（快速/高质量）

3. **用户体验**：
   - 连接状态实时显示
   - 音频流质量监控
   - 网络延迟测量

4. **高级功能**：
   - 频谱数据获取
   - SWR/ALC 监控
   - 多电台支持

---

## ✨ 贡献者

- **实施**: Claude Code
- **设计**: 基于 icom-wlan-node 模块
- **测试**: 待社区测试反馈

---

**文档版本**: 1.0
**最后更新**: 2025-10-20
**状态**: 核心功能已完成，部分集成待完善
