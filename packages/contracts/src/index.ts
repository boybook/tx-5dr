// Schema exports
export * from './schema/hello.schema.js';
export * from './schema/audio.schema.js';
export * from './schema/ft8.schema.js';
export * from './schema/websocket.schema.js';
export * from './schema/mode.schema.js';
export * from './schema/qso.schema.js';
export * from './schema/cycle.schema.js';

// 显式导出slot-info.schema.js以避免与websocket.schema.js的冲突
export { 
  SlotPackSchema,
  FT8FrameSchema,
  DecodeRequestSchema,
  DecodeResultSchema,
  SlotInfoSchema
} from './schema/slot-info.schema.js';

// 导出类型
export type { 
  SlotPack,
  FT8Frame,
  DecodeRequest,
  DecodeResult,
  SlotInfo
} from './schema/slot-info.schema.js';

export type {
  ModeDescriptor
} from './schema/mode.schema.js';

export {
  WSMessageType
} from './schema/websocket.schema.js';

export type {
  OperatorStatus,
  WSGetOperatorsMessage,
  WSOperatorsListMessage,
  WSOperatorStatusUpdateMessage,
  WSSetOperatorContextMessage,
  WSSetOperatorSlotMessage,
  // ... 其他websocket相关类型
} from './schema/websocket.schema.js';

// 导出所有schema中定义的类型
export * from './schema/ft8.schema.js';
export * from './schema/qso.schema.js';
export * from './schema/websocket.schema.js';
export * from './schema/slot-info.schema.js';
export * from './schema/audio.schema.js';
export * from './schema/hello.schema.js';

// 导出周期相关类型
export * from './schema/cycle.schema.js';

// 导出模式相关的类型
export * from './schema/mode.schema.js';

// Audio Schema
export * from './schema/audio.schema.js';

// Cycle Schema
export * from './schema/cycle.schema.js';

// FT8 Schema
export * from './schema/ft8.schema.js';

// Hello Schema
export * from './schema/hello.schema.js';

// Mode Schema
export * from './schema/mode.schema.js';

// Operator Schema
export * from './schema/operator.schema.js';

// QSO Schema  
export * from './schema/qso.schema.js';

// Slot Info Schema
export * from './schema/slot-info.schema.js';

// WebSocket Schema
export * from './schema/websocket.schema.js';

// Logbook Schema
export * from './schema/logbook.schema.js';
