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

## 开发规范
1. 各包有专门 CLAUDE.md，修改时参考对应文档
2. 新功能: contracts定义Schema → server实现 → web集成
3. 提交前: `yarn lint && yarn build`