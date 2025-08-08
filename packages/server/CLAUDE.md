# CLAUDE.md - Server

TX-5DR 数字电台核心后端：Fastify + 数字电台引擎 + 音频处理 + FT8 解码 + WebSocket。

## 核心架构

### DigitalRadioEngine (单例)
系统控制器，管理生命周期：配置 → 音频设备 → 解码队列 → WebSocket，支持优雅关闭和错误恢复。

### 音频链路
- **AudioStreamManager**: naudiodon2 低延迟 I/O，多设备动态切换，实时状态监控
- **AudioMixer**: 多操作员混音，独立音量控制，PTT 逻辑
- **SpectrumAnalyzer**: WebWorker 并行 FFT，瀑布图数据，自适应调度

### 解码链路
- **WSJTXDecodeWorkQueue**: Piscina 多进程并行解码，12kHz 重采样，结果验证
- **WSJTXEncodeWorkQueue**: 文本编码为 FT8 音频，标准波形生成，15秒时序控制

### 时隙系统
- **SlotPackManager**: 解码去重，频率分析，日志本集成，实时统计
- **SlotPackPersistence**: 按日期存储，增量更新，历史数据压缩

### WebSocket 系统
- **WSServer**: 多客户端管理，消息广播，连接生命周期
- **WSConnection**: 操作员过滤，定制数据生成，错误隔离

### API 路由
模块化设计：audio(设备/音量) | radio(状态/频率) | operators(管理/传输) | logbooks(查询/QSO) | slotpack(数据/统计) | mode(切换) | storage(存储)

## 开发规范

### API 端点
1. 对应路由文件添加处理器
2. contracts Schema 验证请求
3. 更新 WebSocket 事件
4. 错误处理

### WebSocket 命令
```typescript
private commandHandlers = {
  new_command: async (connection: WSConnection, data: any) => {
    await this.broadcastToAll('event_name', result);
  }
};
```

### 最佳实践
- 音频：缓冲区管理，错误恢复，性能监控
- 解码：工作池配置，内存管理，异常重启

## 运维

### 环境变量
`NODE_ENV` (环境) | `PORT` (端口，默认4000) | `EMBEDDED` (Electron模式)

### 监控
- 日志：应用/音频/WebSocket/解码
- 性能：CPU/内存/网络/音频延迟

## 命令
`yarn dev` (开发) | `yarn build` (构建) | `yarn start` (启动)

## 依赖
依赖: @tx5dr/contracts + naudiodon2 + fastify + piscina