# CLAUDE.md

TX-5DR 数字电台项目指南。**请使用中文与用户沟通。**

## 项目概述
Node.js 后端 + React 前端 + Electron 桌面应用，Turborepo + Yarn 4 管理 monorepo。

## 包结构
- **contracts**: Schema 和类型 → 详见 `packages/contracts/CLAUDE.md`
- **core**: 通信客户端 → 详见 `packages/core/CLAUDE.md`
- **server**: 后端服务 → 详见 `packages/server/CLAUDE.md`
- **web**: React 前端 → 详见 `packages/web/CLAUDE.md`
- **electron-***: 桌面应用 → 详见各包 CLAUDE.md

依赖: contracts → core → web/electron, core ↔ server

## 常用命令
```bash
# 开发
yarn dev                    # 浏览器模式（启动 server + web，访问 http://localhost:5173）
yarn dev:electron           # Electron模式（启动 server + web + electron-main）

# 独立启动（用于调试）
yarn workspace @tx5dr/server dev    # 单独启动后端（4000端口）
yarn workspace @tx5dr/web dev       # 单独启动前端（5173端口）
yarn workspace @tx5dr/electron-main dev  # 单独启动Electron（需要先启动server和web）

# 构建
yarn build                  # 构建所有包
yarn build:package         # Electron打包
yarn lint                   # 代码检查
yarn test                   # 测试

# Docker
yarn docker:build          # Docker构建
docker-compose up -d        # 启动服务
```

## 技术栈
前端: React 18 + TypeScript + HeroUI + WebGL
后端: Fastify + naudiodon2 + WSJTX + WebSocket
工具: Piscina 工作池 + Turborepo

## 架构亮点

### WebSocket 事件系统
- **直接订阅**: 组件通过 `radioService.wsClientInstance` 直接访问 WSClient 订阅事件
- **多监听器**: 同一事件支持多个监听器互不干扰
- **轻量 Service**: RadioService 仅封装命令方法，暴露 wsClient 实例
- **类型安全**: 基于 contracts 的 `DigitalRadioEngineEvents` 类型定义
- **内存安全**: 必须配对调用 `onWSEvent` / `offWSEvent` 避免内存泄漏

事件流：
```
WSClient → RadioProvider/Components (直接订阅)
```

详见：
- `packages/web/CLAUDE.md` - WebSocket 事件订阅指南
- `packages/core/CLAUDE.md` - 事件系统设计详解

## 开发规范
1. 各包有专门 CLAUDE.md，修改时参考对应文档
2. 新功能: contracts定义Schema → server实现 → web集成
3. 提交前: `yarn lint && yarn build`