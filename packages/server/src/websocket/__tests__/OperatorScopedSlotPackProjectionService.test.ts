import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlotPack } from '@tx5dr/contracts';
import { ConfigManager } from '../../config/config-manager.js';
import { OperatorScopedSlotPackProjectionService } from '../OperatorScopedSlotPackProjectionService.js';

function createSlotPack(message: string): SlotPack {
  return {
    slotId: 'slot-1',
    startMs: 1_710_000_000_000,
    endMs: 1_710_000_015_000,
    frames: [
      {
        snr: -5,
        dt: 0.2,
        freq: 1234,
        message,
        confidence: 1,
      },
    ],
    stats: {
      totalDecodes: 1,
      successfulDecodes: 1,
      totalFramesBeforeDedup: 1,
      totalFramesAfterDedup: 1,
      lastUpdated: 1_710_000_000_100,
    },
    decodeHistory: [],
  };
}

describe('OperatorScopedSlotPackProjectionService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('projects slot pack analysis for the selected operator only', async () => {
    vi.spyOn(ConfigManager.getInstance(), 'getLastSelectedFrequency').mockReturnValue({
      frequency: 14_074_000,
      band: '20m',
      mode: 'FT8',
      description: '20m FT8',
    } as any);

    const analyzeCallsign = vi.fn().mockResolvedValue({
      isNewCallsign: true,
      isNewDxccEntity: true,
      isNewBandDxccEntity: true,
      isConfirmedDxcc: false,
      isNewGrid: true,
      prefix: 'JA',
      state: undefined,
      stateConfidence: undefined,
      dxccId: 339,
      dxccEntity: 'Japan',
      dxccStatus: 'current',
    });

    const service = new OperatorScopedSlotPackProjectionService({
      callsignTracker: {
        getGrid: vi.fn().mockReturnValue('PM95'),
      } as any,
      logManager: {
        getOperatorLogBook: vi.fn().mockResolvedValue({
          provider: {
            analyzeCallsign,
          },
        }),
      } as any,
    });

    const rawSlotPack = createSlotPack('CQ JA1AAA');
    const projected = await service.projectSlotPack(rawSlotPack, 'op-ja');

    expect(analyzeCallsign).toHaveBeenCalledWith('JA1AAA', 'PM95', { band: '20m' });
    expect(projected.frames[0]?.logbookAnalysis).toMatchObject({
      callsign: 'JA1AAA',
      grid: 'PM95',
      isNewDxccEntity: true,
      isNewGrid: true,
      dxccEntity: 'Japan',
    });
    expect(rawSlotPack.frames[0]).not.toHaveProperty('logbookAnalysis');
  });

  it('returns a raw projection without operator analysis when no operator is selected', async () => {
    const analyzeCallsign = vi.fn();
    const service = new OperatorScopedSlotPackProjectionService({
      callsignTracker: {
        getGrid: vi.fn(),
      } as any,
      logManager: {
        getOperatorLogBook: vi.fn().mockResolvedValue({
          provider: {
            analyzeCallsign,
          },
        }),
      } as any,
    });

    const slotPack = createSlotPack('CQ BG5AAA PM01');
    const projected = await service.projectSlotPack(slotPack, null);

    expect(projected.frames[0]).not.toHaveProperty('logbookAnalysis');
    expect(analyzeCallsign).not.toHaveBeenCalled();
  });

  it('projects special event long callsigns parsed from CQ messages', async () => {
    const analyzeCallsign = vi.fn().mockResolvedValue({
      isNewCallsign: true,
      isNewDxccEntity: true,
      isNewBandDxccEntity: true,
      isConfirmedDxcc: false,
      isNewGrid: false,
      prefix: 'SX',
      state: undefined,
      stateConfidence: undefined,
      dxccId: 236,
      dxccEntity: 'Greece',
      dxccStatus: 'current',
    });

    const service = new OperatorScopedSlotPackProjectionService({
      callsignTracker: {
        getGrid: vi.fn().mockReturnValue(undefined),
      } as any,
      logManager: {
        getOperatorLogBook: vi.fn().mockResolvedValue({
          provider: {
            analyzeCallsign,
          },
        }),
      } as any,
    });

    const projected = await service.projectSlotPack(createSlotPack('CQ SX100PAOK'), 'op-special');

    expect(analyzeCallsign).toHaveBeenCalledWith('SX100PAOK', undefined, { band: expect.any(String) });
    expect(projected.frames[0]?.logbookAnalysis).toMatchObject({
      callsign: 'SX100PAOK',
      prefix: 'SX',
      dxccEntity: 'Greece',
      dxccStatus: 'current',
    });
  });
});
