# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

TX-5DR 数字电台项目：Node.js 后端 + React 前端 + Electron 桌面应用。使用 Turborepo + Yarn 4 管理 monorepo。

## 架构说明

### 核心包结构
- **contracts**: Zod Schema 和类型定义
- **core**: API 客户端和 WebSocket 客户端
- **server**: Fastify 服务器 + 数字电台引擎
- **web**: React 前端应用
- **electron-main/preload**: 桌面应用

### Server 核心组件

**DigitalRadioEngine**: 核心引擎，单例模式管理系统生命周期
- 音频链路: AudioStreamManager → AudioMixer → PTT控制  
- 解码链路: 音频采集 → WSJTXDecodeWorkQueue → SlotPackManager
- 编码链路: 消息编码 → WSJTXEncodeWorkQueue → 音频混音

**关键系统**:
- **音频**: naudiodon2 流管理、多操作员混音、实时频谱分析 
- **解码**: Piscina 工作池并行 WSJTX 解码，专业重采样 (12kHz)
- **时隙**: 解码结果去重、智能频率分析、日期结构化存储
- **通信**: WebSocket 握手协议、操作员过滤、实时状态推送

## 前端规范

### 技术栈
React 18 + TypeScript + HeroUI + Tailwind CSS + Vite

### 核心组件
- **FramesTable**: FT8 消息表格，时隙分组 + 日志本分析
- **WebGLWaterfall**: 瀑布图，WebGL 优化性能
- **RadioOperator**: 操作员控制面板  
- **SplitLayout**: 可调整分割布局

### 状态管理
- **RadioProvider**: Context + 三层 Reducer (connection/radio/slotPacks)
- **专用 hooks**: useConnection、useRadioState、useSlotPacks
- **事件驱动**: RadioService 映射 WebSocket 事件到状态更新

## 通信架构

### 完整通信链路
```
Components ↔ RadioProvider ↔ RadioService ↔ WSClient ↔ WSServer ↔ DigitalRadioEngine
                                          ↕
                                         api ↔ Fastify Routes
```

### 核心通信组件

**前端 (core/websocket/)**:
- **WSClient**: WebSocket 客户端，自动重连 + 心跳 + 指数退避
- **WSMessageHandler**: 消息序列化/反序列化 + 事件路由
- **RadioService**: 业务封装层，映射 WebSocket 事件到前端事件

**后端 (server/websocket/)**:
- **WSServer**: WebSocket 服务器，管理多客户端连接 + 消息广播
- **WSConnection**: 单客户端连接包装器，支持操作员过滤
- **握手协议**: 客户端发送操作员偏好，服务端返回过滤数据

### 关键通信机制

**握手流程**:
1. 客户端连接 → 服务端发送基础状态 (系统状态、模式、音量)
2. 客户端发送握手 (enabledOperatorIds: string[] | null)
3. 服务端完成握手 → 发送过滤数据 (操作员列表、最近时隙包)

**消息过滤**:
- **操作员过滤**: 每个客户端只接收启用操作员的状态更新
- **时隙包定制**: 服务端为每个客户端生成包含日志本分析的定制时隙包
- **广播优化**: 根据客户端配置进行智能广播，避免无效数据传输

**事件映射** (WS_MESSAGE_EVENT_MAP):
- WSMessageType → 事件名自动映射
- 统一的消息验证和错误处理
- 支持双向消息流 (命令/响应)

### 添加新接口流程
1. **Schema**: contracts/schema 定义 Zod Schema + WSMessageType
2. **后端**: WSServer 添加命令处理器 (commandHandlers)
3. **前端**: WSClient 添加发送方法，WSMessageHandler 映射事件
4. **状态**: RadioService 订阅事件，RadioProvider reducer 处理
5. **组件**: 使用 useRadio hooks 访问状态和调用方法

## 常用命令

### 开发
```bash
# 仅浏览器模式开发
yarn dev

# Electron 完整模式开发
EMBEDDED=true yarn dev

# 预览生产版本
yarn preview
```

### 构建和打包
```bash
# 构建所有包
yarn build

# 构建并打包 Electron
yarn build:package

# 构建并制作发布包
yarn build:make

# 清理构建产物
yarn clean

# 全新构建
yarn fresh-build
```

### 代码质量
```bash
# 代码检查
yarn lint

# 运行测试
yarn test
```

### Docker 部署
```bash
# 快速构建
yarn docker:build

# 多平台构建
yarn docker:build-multi

# 构建并推送
yarn docker:build-and-push

# 使用 Docker Compose
docker-compose up -d
```

## 技术栈
- **前端**: React 18 + TypeScript + HeroUI + WebGL 瀑布图
- **后端**: Fastify + naudiodon2 + WSJTX + WebSocket
- **并发**: Piscina 工作池 + Web Workers
- **构建**: Turborepo + Yarn 4

## 开发环境
- Web: http://localhost:5173 (Vite 代理到 4000)
- Server: http://localhost:4000
- 测试: `yarn workspace @tx5dr/core test` (Vitest)