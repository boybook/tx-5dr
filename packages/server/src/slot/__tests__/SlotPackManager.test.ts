import { describe, expect, it, vi } from 'vitest';
import type { DecodeResult, SlotPack } from '@tx5dr/contracts';
import { SlotPackManager } from '../SlotPackManager.js';

function buildDecodeResult(
  slotStartMs: number,
  frames: Array<{ message: string; snr: number; dt?: number; confidence?: number; freq?: number }>,
  overrides: Partial<DecodeResult> = {},
): DecodeResult {
  return {
    slotId: `slot-${slotStartMs}`,
    timestamp: slotStartMs + 14_000,
    windowIdx: 0,
    processingTimeMs: 42,
    frames: frames.map((f) => ({
      message: f.message,
      snr: f.snr,
      dt: f.dt ?? 0,
      freq: f.freq ?? 1500,
      confidence: f.confidence ?? 0.9,
    })),
    ...overrides,
  } as unknown as DecodeResult;
}

describe('SlotPackManager event routing', () => {
  // 2026-04-19 BG5DRB 事故修复（方案 A）：晚到解码重决策必须与 TX echo 写入事件分离，
  // 否则 addTransmissionFrame 会把当前 TX 槽的 slotPack 当成「上一 RX 槽的晚到解码」
  // 喂给 standard-qso，污染 QSO 上下文。
  it('processDecodeResult emits both slotPackUpdated and slotPackDecodeUpdated', () => {
    const manager = new SlotPackManager();
    manager.setPersistenceEnabled(false);

    const slotPackUpdatedSpy = vi.fn();
    const slotPackDecodeUpdatedSpy = vi.fn();
    manager.on('slotPackUpdated', slotPackUpdatedSpy as (pack: SlotPack) => void);
    manager.on('slotPackDecodeUpdated', slotPackDecodeUpdatedSpy as (pack: SlotPack) => void);

    manager.processDecodeResult(buildDecodeResult(45_000, [{ message: 'CQ BG5DRB PM00', snr: -5 }]));

    expect(slotPackUpdatedSpy).toHaveBeenCalledTimes(1);
    expect(slotPackDecodeUpdatedSpy).toHaveBeenCalledTimes(1);
    const emittedPack = slotPackDecodeUpdatedSpy.mock.calls[0]?.[0] as SlotPack;
    expect(emittedPack.frames.some((f) => f.message === 'CQ BG5DRB PM00')).toBe(true);
  });

  it('addTransmissionFrame only emits slotPackUpdated (NOT slotPackDecodeUpdated)', () => {
    const manager = new SlotPackManager();
    manager.setPersistenceEnabled(false);

    const slotPackUpdatedSpy = vi.fn();
    const slotPackDecodeUpdatedSpy = vi.fn();
    manager.on('slotPackUpdated', slotPackUpdatedSpy as (pack: SlotPack) => void);
    manager.on('slotPackDecodeUpdated', slotPackDecodeUpdatedSpy as (pack: SlotPack) => void);

    manager.addTransmissionFrame(
      'slot-60000',
      'operator-1',
      'R40CHA BG5DRB 73',
      14_074_000,
      60_100,
    );

    // 前端/PSKReporter 等仍需知道 TX echo 被写入 → slotPackUpdated 照常触发
    expect(slotPackUpdatedSpy).toHaveBeenCalledTimes(1);
    // 但 slotPackDecodeUpdated 只在 RX 解码写入时触发；TX echo 不应该走这条路径
    expect(slotPackDecodeUpdatedSpy).not.toHaveBeenCalled();
  });

  it('replaces a transmission frame for the same operator and slot when requested', () => {
    const manager = new SlotPackManager();
    manager.setPersistenceEnabled(false);

    manager.addTransmissionFrame('slot-60000', 'op-1', 'CQ BG5BNW PM00', 2550, 60_000);
    manager.addTransmissionFrame('slot-60000', 'op-1', 'R9WXK BG5BNW PM00', 2550, 60_000, true);

    const slotPack = manager.getSlotPack('slot-60000');
    expect(slotPack?.frames.filter(frame => frame.snr === -999)).toEqual([
      expect.objectContaining({
        operatorId: 'op-1',
        message: 'R9WXK BG5BNW PM00',
      }),
    ]);
    expect(slotPack?.stats.updateSeq).toBe(2);
  });

  it('keeps transmission frames from different operators in the same slot', () => {
    const manager = new SlotPackManager();
    manager.setPersistenceEnabled(false);

    manager.addTransmissionFrame('slot-60000', 'op-1', 'R9WXK BG5BNW PM00', 2550, 60_000);
    manager.addTransmissionFrame('slot-60000', 'op-2', 'R8KBM BG5DRB PM00', 2450, 60_000, true);

    const txFrames = manager.getSlotPack('slot-60000')?.frames.filter(frame => frame.snr === -999) ?? [];
    expect(txFrames).toHaveLength(2);
    expect(txFrames.map(frame => frame.operatorId).sort()).toEqual(['op-1', 'op-2']);
  });

  it('emits immutable snapshots with increasing updateSeq values', () => {
    const manager = new SlotPackManager();
    manager.setPersistenceEnabled(false);
    const emitted: SlotPack[] = [];
    manager.on('slotPackUpdated', (slotPack) => emitted.push(slotPack));

    manager.processDecodeResult(buildDecodeResult(45_000, [{ message: 'CQ BG5DRB PM00', snr: -5 }]));
    manager.addTransmissionFrame('slot-45000', 'op-1', 'BG5DRB BG2DIH 73', 569, 45_000);

    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.stats.updateSeq).toBe(1);
    expect(emitted[1]?.stats.updateSeq).toBe(2);
    expect(emitted[0]?.frames.map(frame => frame.message)).toEqual(['CQ BG5DRB PM00']);
    expect(emitted[1]?.frames.map(frame => frame.message)).toContain('BG5DRB BG2DIH 73');
    expect(emitted[0]?.frames).not.toBe(emitted[1]?.frames);
    expect(emitted[0]?.stats).not.toBe(emitted[1]?.stats);
  });

  it('keeps raw decoder dt values even when the decode window has an offset', () => {
    const manager = new SlotPackManager();
    manager.setPersistenceEnabled(false);

    manager.processDecodeResult(buildDecodeResult(
      45_000,
      [{ message: 'CQ BG5DRB PM00', snr: -5, dt: 0.3 }],
      { windowIdx: 1, windowOffsetMs: -1500 },
    ));

    const slotPack = manager.getSlotPack('slot-45000');
    expect(slotPack?.frames).toEqual([
      expect.objectContaining({
        message: 'CQ BG5DRB PM00',
        dt: 0.3,
      }),
    ]);
  });

  it('deduplicates using raw dt values instead of offset-corrected dt values', () => {
    const manager = new SlotPackManager();
    manager.setPersistenceEnabled(false);

    manager.processDecodeResult(buildDecodeResult(
      45_000,
      [{ message: 'CQ BG5DRB PM00', snr: -5, dt: 0.8, confidence: 0.9, freq: 1600 }],
      { windowIdx: 0, windowOffsetMs: -1500 },
    ));
    manager.processDecodeResult(buildDecodeResult(
      45_000,
      [{ message: 'CQ BG5DRB PM00', snr: -5, dt: 0.2, confidence: 0.9, freq: 1700 }],
      { windowIdx: 1, windowOffsetMs: -300 },
    ));

    const slotPack = manager.getSlotPack('slot-45000');
    expect(slotPack?.frames).toEqual([
      expect.objectContaining({
        message: 'CQ BG5DRB PM00',
        dt: 0.2,
        freq: 1700,
      }),
    ]);
  });
});
