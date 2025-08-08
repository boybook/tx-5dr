# CLAUDE.md - Contracts

Zod Schema 和 TypeScript 类型定义包，为整个 TX-5DR 系统提供数据契约。

## 核心文件
- **websocket.schema.ts**: WebSocket 消息类型
- **radio/audio.schema.ts**: 电台和音频控制
- **ft8/operator.schema.ts**: FT8 消息和操作员
- **logbook/qso.schema.ts**: 日志本和联络记录
- **其他**: slot-info, mode, cycle, hello

## 开发规范

### 新增 Schema
1. `src/schema/` 创建 `.schema.ts` 文件
2. 定义 Zod Schema:
   ```typescript
   export const DataSchema = z.object({
     id: z.string(),
     value: z.number().optional(),
   });
   export type Data = z.infer<typeof DataSchema>;
   ```
3. `src/index.ts` 导出
4. `yarn build` 生成类型

### WebSocket 消息
```typescript
export const WSMessageType = {
  COMMAND_NAME: 'command_name',  // 客户端→服务端
  EVENT_NAME: 'event_name',      // 服务端→客户端
} as const;
```

### 设计原则
- 严格验证，新字段用 `.optional()` 保证兼容性
- 复用现有 Schema，避免重复定义
- 使用语义化的命名

## 命令
`yarn build` - 构建类型定义