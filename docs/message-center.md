# 极简版消息中心（仅字符串）设计与实施计划

本方案将消息中心精简到“仅广播与展示字符串文案”。不定义等级、主题、上下文等扩展字段；消息体就是一段文本（含标题）。服务端把需要用户注意的文本推送到客户端；客户端仅用 HeroUI 的 Toast 即时展示（不提供面板或历史列表）。

---

## 1. 目标与范围
- 将关键运行提示（如“策略决策超时”“编码早于决策”等）以“纯文本”推送到前端。
- 不引入复杂字段与过滤规则；不支持快照持久化与重放；只做简单展示与清空。

---

## 2. 协议与模型（contracts）
- WebSocket 事件：`WSMessageType.TEXT_MESSAGE`（名称可调整）
- 负载（payload）：对象，包含标题与正文
  - 结构：`{ title: string; text: string }`
  - 示例：
    - `{ title: "TIMING", text: "决策超时 320ms (op=OP1 slot=FT8-123...)" }`
- 说明：
  - 不带 id/时间戳/等级等字段；客户端可以本地加“收到时间”。

TODO: 在 `websocket.schema.ts` 新增 `TEXT_MESSAGE`；不新增独立 schema 文件。

---

## 3. 服务端设计（server）

### 3.1 最小化广播接口
- 在 `WSServer` 中新增：`broadcastTextMessage(title: string, text: string): void`
  - 封装：逐连接 `connection.send(WSMessageType.TEXT_MESSAGE, { title, text })`。

### 3.2 发送方调用点（第一批）
- `DigitalRadioEngine`：在 `slotStart/encodeStart` 的时序判断处，构造 `{title, text}` 并调用 `broadcastTextMessage()`。
- `RadioOperator`：在 `handleReceivedAndDicideNext` 超时阈值处发一条 `{title, text}` 告警。
- `RadioOperatorManager`：在“队列拥塞/丢弃”等关键路径发 `{title, text}` 提示。

说明：仅拼接简短文本；避免大对象序列化；不阻塞主流程。

---

## 4. 客户端设计（web）

不做存储或列表，仅即时展示。

### 4.2 事件处理（无需订阅概念）
- 无需实现订阅/握手，只在现有 WebSocket 消息处理表中增加 `TEXT_MESSAGE` 分支：收到后直接触发 Toast（展示 `{ title, text }`）。

### 4.3 UI 展示（HeroUI）
Toast：收到即弹轻量提示（可堆叠），标题+正文两行或并排展示；不提供面板或历史列表。

---

## 5. 实施步骤
- contracts：
  - [ ] 在 `websocket.schema.ts` 新增 `TEXT_MESSAGE` 事件类型（payload: `{ title, text }`）。
- server：
  - [ ] `WSServer.broadcastTextMessage(title, text)`
  - [ ] 在 3.2 所列节点调用广播（以 TODO 标注占位）
- web：
  - [ ] 在 WS 消息处理映射中增加 `TEXT_MESSAGE` -> handler（解包 `{ title, text }`）
  - [ ] `MessageToastHost`（展示标题+正文）

---

## 6. 文案规范（建议）
- 前缀主题标签（可选但推荐）：`[TIMING]`/`[QSO]`/`[AUDIO]` 等，仍然是字符串的一部分。
- 控制长度（推荐 < 120 字），一条表达一个事件，不携带大对象。
- 示例：
  - `{ title: "TIMING", text: "决策超时 320ms (op=BG5DRB slot=FT8-... )" }`
  - `{ title: "TIMING", text: "编码早于决策，本周期发送上一状态内容" }`

---

## 7. 验收标准
- 收到一条文本广播，前端在 1 秒内弹出 Toast（标题+正文）。
- 在时序问题产生时，能出现直观文案提示；Toast 按配置时长自动关闭。

---

## 8. TODO 汇总
- [ ] contracts：新增 `TEXT_MESSAGE` WS 枚举
- [ ] server：`broadcastTextMessage(title, text)` + 接入调用点（以 TODO 标记）
- [ ] web：事件处理映射 + `MessageToastHost`
- [ ] 手工联调：从服务器触发 3 条测试消息，端到端可见

---

本极简设计专注于“把字符串推到前端并展示”，后续如需等级/过滤/快照等能力，可在不破坏现有 `TEXT_MESSAGE` 的前提下逐步演进。
