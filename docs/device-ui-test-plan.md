# Device UI 测试计划与审计记录

本文面向并行实现 `docs/device-ui-architecture.md` 的多 Agent 工作流，记录当前代码审计结论、必须由主实现 Agent 覆盖的回归点，以及可直接落地的测试建议。本文不修改 `packages/server`、`packages/contracts`、`packages/device-ui/src/native` 等实现文件。

## 1. 当前代码审计结论

### 1.1 普通 WebSocket 用户数现状

已审计文件：

- `packages/server/src/server.ts`
- `packages/server/src/websocket/WSServer.ts`
- `packages/contracts/src/schema/websocket.schema.ts`

当前普通浏览器 WebSocket 入口是 `GET /api/ws`，路由直接调用 `wsServer.addConnection(socket)`。`WSServer` 内部维护 `connections` 和 `clientInstanceConnections`，只有收到 `clientHandshake` 后才把连接标记为 handshake completed，并在 `broadcastClientCount()` 中统计 `getActiveConnections().filter(conn => conn.isHandshakeCompleted()).length`。

对 device-ui 的含义：

- `/api/device-ui/ws` 不能复用 `/api/ws`，也不能调用 `WSServer.addConnection()`。
- device 连接不能发送或触发 `clientHandshake`。
- `DeviceUiProjectionService.browserClientCount` 如果读取普通浏览器用户数，必须只读普通 `WSServer` 已握手连接数，且排除 device WS。
- 如果未来给 `WSServer` 增加公开统计方法，必须返回 handshake completed browser count，而不是 `getStats().active`，因为 `getStats().active` 当前表示所有活跃普通 WS 连接，包括未握手连接。

### 1.2 普通 auth 现状

已审计文件：

- `packages/server/src/auth/authPlugin.ts`
- `packages/server/src/auth/AuthManager.ts`
- `packages/server/src/routes/auth.ts`
- `packages/contracts/src/schema/auth.schema.ts`

当前普通认证模型使用 `JWTPayloadSchema`，字段包含 `tokenId`、`role`、`operatorIds`、`iat`、`exp`，role 来自 `UserRole`。`authPlugin` 在全局 `onRequest` 中验证普通 JWT，再通过 `AuthManager.isTokenStillValid()` 和 `getTokenCurrentPermissions()` 刷新权限。未启用普通 auth 时，普通请求会被视为 local admin。

对 device-ui 的含义：

- device JWT 必须独立于普通 `JWTPayloadSchema`，带 `aud: 'tx5dr-device-ui'`，不产生 `UserRole`。
- device auth 不得受普通 `AuthManager.isAuthEnabled()` 关闭影响；即使普通 auth 关闭，除 `health`/`session`/pairing consume 外的 device API 仍必须要求 device token/JWT。
- 普通用户 JWT 不应通过 device API/WS 的校验；device JWT 也不应通过普通 REST/WS 校验。

### 1.3 Pairing session 现状风险

当前 `AuthManager` 只识别持久化在 `auth.json` 的普通 token；`authPlugin` 也只按普通 token 查 `isTokenStillValid()`。因此 pairing session 需要主实现显式扩展：

- `PairingCodeService` 管理 `pairing-session-*` 临时 session，内存存储，30 分钟有效。
- `authPlugin` 必须在普通 token 校验前或校验路径中识别 `pairing-session-*`，返回 viewer-only `authUser`/ability。
- pairing session 不写入 `auth.json`，不出现在 `GET /api/auth/tokens`。
- pairing viewer JWT 可访问 viewer 级 API，但不能访问 admin/operator API，不能执行 operator/radio 写命令。

## 2. 主 Agent 必须覆盖的测试点

### 2.1 Device auth 与普通 auth 隔离

建议新增 `packages/server/src/device-ui/__tests__/DeviceServiceAuth.test.ts`：

1. `POST /api/device-ui/session` 缺少 `X-TX5DR-Device-Token` 返回 401。
2. `POST /api/device-ui/session` 使用错误 device token 返回 401。
3. 正确 device token 返回短期 JWT，payload 包含 `aud: 'tx5dr-device-ui'`、`sub`、`tokenId`、`capabilities`，不包含普通 `role/operatorIds`。
4. 普通 `AuthManager.isAuthEnabled() === false` 时，`GET /api/device-ui/bootstrap` 仍然要求 device JWT。
5. 普通用户 JWT 访问 `/api/device-ui/bootstrap` 和 `/api/device-ui/ws` 被拒绝。
6. device JWT 访问 `/api/operators`、`/api/radio` 等普通路由被拒绝。
7. `GET /api/device-ui/health` 不需要 auth，响应只包含 `{ status, service, time }`，不得包含 token、operator、radio、network 详情。

### 2.2 Device WS 不计入普通用户数

建议新增 `packages/server/src/device-ui/__tests__/DeviceUiWSServer.test.ts` 或扩展 server 集成测试：

1. 建立普通 `/api/ws` 连接但不发 `clientHandshake`，普通 client count 仍为 0。
2. 普通浏览器完成 `clientHandshake` 后，收到 `clientCountChanged.count === 1`。
3. 建立 `/api/device-ui/ws?token=<device-jwt>` 后，已有普通浏览器不收到 count 增加，或最新 count 仍为 1。
4. 断开 device WS 后，普通浏览器不收到 count 减少。
5. 多个 device WS 重连/替换时，普通 count 始终不变。
6. device WS 发送 `clientHandshake` 或普通 `authToken` 消息时应被忽略或关闭，不能进入 `clientInstanceConnections`。
7. `DeviceUiProjectionService.browserClientCount` 返回值等于普通已握手浏览器数量，不包含 device WS，也不包含未握手普通 WS。

### 2.3 Pairing code 与 viewer-only session

建议新增 `packages/server/src/device-ui/__tests__/PairingCodeService.test.ts` 与 `/api/auth/pairing/consume` 路由测试：

1. `POST /api/device-ui/pairing-code` 只接受带 `device-ui:pairing` capability 的 device JWT。
2. pairing code 是 6 位数字，TTL 默认 5 分钟。
3. code 一次性使用：首次 consume 成功，第二次返回 410/404 类错误。
4. 过期 code 返回 410，并触发 UI/daemon 可识别的过期状态。
5. consume 成功返回普通浏览器可用 JWT，但 tokenId 以 `pairing-session-` 开头，role 固定为 viewer。
6. pairing session 有效期默认 30 分钟；过期后 `/api/auth/me` 返回 401。
7. pairing session 可访问 viewer 级只读 API，例如 `/api/operators` 的只读 GET；不能访问 admin API，例如 `/api/auth/tokens`；不能访问 operator 写接口。
8. `GET /api/auth/tokens` 不包含 `pairing-session-*`。
9. `auth.json` 未写入 pairing session。
10. 同 IP 每分钟失败次数和同 code 失败次数达到阈值后返回 429 或作废。
11. 日志不打印完整 pairing code；最多允许 hash 或末 2 位。

### 2.4 Projection 与裁剪数据

建议新增 `packages/server/src/device-ui/__tests__/DeviceUiProjectionService.test.ts`：

1. bootstrap/snapshot 包含 server、engine、radio、operators、recentMessages、spectrumMini、warnings 的裁剪字段。
2. snapshot 不包含 admin token、device token、普通 JWT、Wi-Fi 密码、热点密码明文、完整 auth token。
3. operator 摘要只包含小屏需要展示的字段，不泄漏 plugin 私有配置或完整日志本。
4. recent messages 只保留架构文档定义的相关消息数量与字段。
5. spectrumMini 降采样到 TFT 64 bins / OLED 16 bins，并限制更新频率。
6. access URL 固定为 `http://<ip>:<webPort>`，不在小屏路径输出 HTTPS URL。

### 2.5 Device daemon / IPC / renderer 回归

建议在 `packages/device-ui` 实现后新增 daemon 侧测试：

1. renderer 连接后，daemon 先发 `panel.config`，再发完整 `state.replace`。
2. renderer 重连后重复完整 replay，旧 active renderer 被替换。
3. NDJSON 单条消息超过 64 KiB 时返回 `ipc.error` 并丢弃该消息。
4. `daemon.hello`、`panel.config`、`state.replace`、`dialog.show`、`renderer.shutdown` 的 ack 行为符合超时规则。
5. `spectrum.update` 背压时只保留最新帧。
6. fixture 模式不依赖 server，可输出 deterministic TFT/OLED snapshot。

## 3. 建议测试文件落点

| 范围 | 建议文件 | 目的 |
|---|---|---|
| contracts | `packages/contracts/src/schema/__tests__/device-ui.schema.test.ts` | 校验 device schema、snapshot、patch、JWT payload 结构 |
| server auth | `packages/server/src/device-ui/__tests__/DeviceServiceAuth.test.ts` | 校验 device token/JWT 与普通 auth 隔离 |
| server WS | `packages/server/src/device-ui/__tests__/DeviceUiWSServer.test.ts` | 校验 device WS 不进入普通用户统计 |
| pairing | `packages/server/src/device-ui/__tests__/PairingCodeService.test.ts` | 校验 code TTL、一次性、viewer-only session |
| routes | `packages/server/src/device-ui/__tests__/deviceUiRoutes.test.ts` | 校验 health/session/bootstrap/access/pairing API |
| projection | `packages/server/src/device-ui/__tests__/DeviceUiProjectionService.test.ts` | 校验裁剪模型、安全字段、browserClientCount |
| daemon | `packages/device-ui/src/**/*.test.ts` | 校验 ServerApiClient、StateStore、PanelSocketHub、server event mapper、fixture |
| network helper | `packages/device-ui/src/network/__tests__/tx5drNetworkHelper.test.ts` | 校验 nmcli 输出解析、网络优先级、hotspot 识别 |
| native preview | `packages/device-ui/native/**/snapshot-tests` | 校验 SDL/PNG snapshot 和 OLED/TFT 排版 |

## 4. 建议回归命令

主实现 Agent 完成对应代码后，建议按以下顺序执行：

```sh
yarn workspace @tx5dr/contracts test -- device-ui.schema
yarn workspace @tx5dr/server test -- DeviceServiceAuth DeviceUiWSServer PairingCodeService deviceUiRoutes DeviceUiProjectionService
yarn workspace @tx5dr/contracts build
yarn workspace @tx5dr/server build
yarn workspace @tx5dr/server lint
```

`packages/device-ui` workspace 建立后追加：

```sh
yarn workspace @tx5dr/device-ui test
yarn workspace @tx5dr/device-ui build:ts
yarn workspace @tx5dr/device-ui build:native
```

首轮实现后的最小 device-ui 回归命令：

```sh
yarn workspace @tx5dr/contracts build
yarn workspace @tx5dr/server build
yarn workspace @tx5dr/device-ui build
yarn workspace @tx5dr/contracts test -- device-ui.schema
yarn workspace @tx5dr/server test src/device-ui/__tests__/PairingCodeService.test.ts src/device-ui/__tests__/DeviceUiProjectionService.test.ts src/device-ui/__tests__/DeviceUiWSServer.test.ts src/device-ui/__tests__/deviceUiRoutes.test.ts
yarn workspace @tx5dr/device-ui test
yarn workspace @tx5dr/server lint
```

如果 CI 时间允许，最终再执行：

```sh
yarn test
yarn build
```

## 5. 验收阻断项

以下任一项失败应阻断合并：

1. device WS 导致普通 `clientCountChanged.count` 增减。
2. `/api/device-ui/ws` 接受普通用户 JWT。
3. device JWT 可访问普通 admin/operator API。
4. 普通 auth 关闭时 device API 自动绕过鉴权。
5. pairing code 生成或 consume 泄漏 admin token、device token、普通 token 明文。
6. pairing session 写入 `auth.json` 或出现在 `/api/auth/tokens`。
7. pairing session 获得 operator/admin 权限，或能执行写操作。
8. health/bootstrap/projection 返回超出小屏需要的敏感字段。
