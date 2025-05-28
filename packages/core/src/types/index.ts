// 重导出 contracts 中的类型，方便使用
export type {
  ModeDescriptor,
  SlotInfo,
  DecodeRequest,
  DecodeResult,
  FT8Frame
} from '@tx5dr/contracts';

// 导出 core 包特有的接口
export type { ClockSource } from '../clock/ClockSource.js';
export type { IDecodeQueue, AudioBufferProvider } from '../clock/SlotScheduler.js';
export type { SlotClockEvents } from '../clock/SlotClock.js'; 