import { describe, expect, it } from 'vitest';
import type { SpectrumLevelDescriptor } from '@tx5dr/contracts';
import { SpectrumTraceSmoother } from './SpectrumTraceSmoother';

const DBFS_LEVEL: SpectrumLevelDescriptor = {
  domain: 'dbfs',
  unit: 'dBFS',
  reference: 'full-scale',
  calibrated: true,
  min: -120,
  max: 0,
};

const RAW_LEVEL: SpectrumLevelDescriptor = {
  domain: 'raw',
  unit: 'Level',
  reference: 'none',
  calibrated: false,
  min: 0,
  max: 255,
};

describe('SpectrumTraceSmoother', () => {
  it('removes an isolated frequency-bin impulse before temporal averaging', () => {
    const smoother = new SpectrumTraceSmoother({ temporalTauMs: 180, frequencyKernelHz: 15 });
    const first = smoother.process(new Float32Array([-80, -80, -80]), {
      frameToken: 1,
      timestamp: 1_000,
      axis: { minHz: 0, maxHz: 12 },
      level: DBFS_LEVEL,
    });
    const second = smoother.process(new Float32Array([-80, -30, -80]), {
      frameToken: 2,
      timestamp: 1_100,
      axis: { minHz: 0, maxHz: 12 },
      level: DBFS_LEVEL,
    });

    expect(first[1]).toBeCloseTo(-80, 4);
    expect(second[1]).toBeCloseTo(-80, 4);
  });

  it('averages dBFS in power space instead of averaging dB values', () => {
    const smoother = new SpectrumTraceSmoother({ temporalTauMs: 100, frequencyKernelHz: 0 });
    smoother.process(new Float32Array([-60]), {
      frameToken: 1,
      timestamp: 1_000,
      axis: { minHz: 0, maxHz: 100 },
      level: DBFS_LEVEL,
    });
    const result = smoother.process(new Float32Array([-40]), {
      frameToken: 2,
      timestamp: 1_100,
      axis: { minHz: 0, maxHz: 100 },
      level: DBFS_LEVEL,
    });

    // The power-domain result is below the arithmetic dB midpoint (-50 dB).
    expect(result[0]).toBeGreaterThan(-45);
    expect(result[0]).toBeLessThan(-35);
    expect(result[0]).not.toBeCloseTo(-50, 2);
  });

  it('uses linear averaging for ICOM raw Level frames', () => {
    const smoother = new SpectrumTraceSmoother({ temporalTauMs: 100, frequencyKernelHz: 0 });
    smoother.process(new Float32Array([40]), {
      frameToken: 1,
      timestamp: 1_000,
      axis: { minHz: 0, maxHz: 100 },
      level: RAW_LEVEL,
    });
    const result = smoother.process(new Float32Array([140]), {
      frameToken: 2,
      timestamp: 1_100,
      axis: { minHz: 0, maxHz: 100 },
      level: RAW_LEVEL,
    });

    expect(result[0]).toBeGreaterThan(40);
    expect(result[0]).toBeLessThan(140);
  });

  it('resets temporal history when the absolute viewport changes', () => {
    const smoother = new SpectrumTraceSmoother({ temporalTauMs: 500, frequencyKernelHz: 0 });
    smoother.process(new Float32Array([-100]), {
      frameToken: 1,
      timestamp: 1_000,
      axis: { minHz: 0, maxHz: 100 },
      level: DBFS_LEVEL,
    });
    const result = smoother.process(new Float32Array([-40]), {
      frameToken: 2,
      timestamp: 1_100,
      axis: { minHz: 1_000, maxHz: 1_100 },
      level: DBFS_LEVEL,
    });

    expect(result[0]).toBeCloseTo(-40, 4);
  });
});
