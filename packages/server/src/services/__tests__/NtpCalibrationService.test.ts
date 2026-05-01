import { describe, expect, it, vi } from 'vitest';
import { MODES } from '@tx5dr/contracts';
import { NtpCalibrationService } from '../NtpCalibrationService.js';

function createClockSource(initialOffsetMs = 0) {
  let calibrationOffsetMs = initialOffsetMs;

  return {
    getCalibrationOffsetMs: vi.fn(() => calibrationOffsetMs),
    setCalibrationOffsetMs: vi.fn((offsetMs: number) => {
      calibrationOffsetMs = offsetMs;
    }),
    now: vi.fn(() => Date.now() + calibrationOffsetMs),
  };
}

describe('NtpCalibrationService', () => {
  it('inherits the current clock offset and broadcasts manual changes', () => {
    const clockSource = createClockSource(37.5);
    const service = new NtpCalibrationService(clockSource as any);
    const statusChanged = vi.fn();

    service.on('statusChanged', statusChanged);

    expect(service.getStatus()).toMatchObject({
      appliedOffsetMs: 37.5,
      syncState: 'never',
      indicatorState: 'never',
      autoApplyOffset: false,
    });

    service.setAppliedOffset(-12.5);

    expect(clockSource.setCalibrationOffsetMs).toHaveBeenCalledWith(-12.5);
    expect(service.getStatus()).toMatchObject({
      appliedOffsetMs: -12.5,
      syncState: 'never',
      indicatorState: 'never',
    });
    expect(statusChanged).toHaveBeenLastCalledWith({
      appliedOffsetMs: -12.5,
      indicatorState: 'never',
    });
  });

  it('stores NTP measurements without auto-applying them', async () => {
    const clockSource = createClockSource();
    // 显式传入 server 列表，避免对默认 NTP 服务器列表（可能随业务调整）的隐式依赖
    const service = new NtpCalibrationService(clockSource as any, ['pool.ntp.org']);

    vi.spyOn(service as any, 'queryNtpServer').mockResolvedValue(120);

    await service.triggerMeasurement();

    expect(clockSource.setCalibrationOffsetMs).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      measuredOffsetMs: 120,
      appliedOffsetMs: 0,
      syncState: 'synced',
      indicatorState: 'alert',
      serverUsed: 'pool.ntp.org',
      errorMessage: null,
    });
  });

  it('auto-applies successful measurements when enabled and timing is safe', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    try {
      const clockSource = createClockSource();
      const service = new NtpCalibrationService(clockSource as any, ['pool.ntp.org'], {
        autoApplyOffset: true,
        getCurrentMode: () => MODES.FT8,
        isDigitalClockRunning: () => true,
      });

      vi.spyOn(service as any, 'queryNtpServer').mockResolvedValue(120);

      const measurement = service.triggerMeasurement();
      await vi.advanceTimersByTimeAsync(750);
      await measurement;

      expect(clockSource.setCalibrationOffsetMs).toHaveBeenCalledWith(120);
      expect(service.getStatus()).toMatchObject({
        measuredOffsetMs: 120,
        appliedOffsetMs: 120,
        syncState: 'synced',
        indicatorState: 'ok',
        autoApplyOffset: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-applies the latest synced measurement when the switch is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    try {
      const clockSource = createClockSource();
      const service = new NtpCalibrationService(clockSource as any, ['pool.ntp.org'], {
        getCurrentMode: () => MODES.FT8,
        isDigitalClockRunning: () => true,
      });

      vi.spyOn(service as any, 'queryNtpServer').mockResolvedValue(120);

      const measurement = service.triggerMeasurement();
      await vi.advanceTimersByTimeAsync(750);
      await measurement;

      expect(clockSource.setCalibrationOffsetMs).not.toHaveBeenCalled();

      service.setAutoApplyOffset(true);

      expect(clockSource.setCalibrationOffsetMs).toHaveBeenCalledWith(120);
      expect(service.getStatus()).toMatchObject({
        measuredOffsetMs: 120,
        appliedOffsetMs: 120,
        autoApplyOffset: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('delays auto-apply near protected digital timing events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      const clockSource = createClockSource();
      const service = new NtpCalibrationService(clockSource as any, ['pool.ntp.org'], {
        autoApplyOffset: true,
        getCurrentMode: () => MODES.FT8,
        isDigitalClockRunning: () => true,
      });

      vi.spyOn(service as any, 'queryNtpServer').mockResolvedValue(120);

      const measurement = service.triggerMeasurement();
      await vi.advanceTimersByTimeAsync(750);
      await measurement;

      expect(clockSource.setCalibrationOffsetMs).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(clockSource.setCalibrationOffsetMs).toHaveBeenCalledWith(120);
      expect(service.getStatus()).toMatchObject({
        appliedOffsetMs: 120,
        autoApplyOffset: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('delays auto-apply when the post-apply phase would land near a protected event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    try {
      const clockSource = createClockSource();
      const service = new NtpCalibrationService(clockSource as any, ['pool.ntp.org'], {
        autoApplyOffset: true,
        getCurrentMode: () => MODES.FT8,
        isDigitalClockRunning: () => true,
      });

      vi.spyOn(service as any, 'queryNtpServer').mockResolvedValue(-1500);

      const measurement = service.triggerMeasurement();
      await vi.advanceTimersByTimeAsync(750);
      await measurement;

      expect(clockSource.setCalibrationOffsetMs).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(clockSource.setCalibrationOffsetMs).toHaveBeenCalledWith(-1500);
      expect(service.getStatus().appliedOffsetMs).toBe(-1500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps only the newest pending auto-apply measurement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      const clockSource = createClockSource();
      const service = new NtpCalibrationService(clockSource as any, ['pool.ntp.org'], {
        autoApplyOffset: true,
        getCurrentMode: () => MODES.FT8,
        isDigitalClockRunning: () => true,
      });
      const querySpy = vi.spyOn(service as any, 'queryNtpServer')
        .mockResolvedValueOnce(-1500)
        .mockResolvedValueOnce(-1500)
        .mockResolvedValueOnce(-1500)
        .mockResolvedValueOnce(-1500)
        .mockResolvedValue(300);

      const firstMeasurement = service.triggerMeasurement();
      await vi.advanceTimersByTimeAsync(750);
      await firstMeasurement;
      expect(clockSource.setCalibrationOffsetMs).not.toHaveBeenCalled();

      const secondMeasurement = service.triggerMeasurement();
      await vi.advanceTimersByTimeAsync(750);
      await secondMeasurement;
      await vi.advanceTimersByTimeAsync(1000);

      expect(querySpy).toHaveBeenCalled();
      expect(clockSource.setCalibrationOffsetMs).not.toHaveBeenCalledWith(-1500);
      expect(clockSource.setCalibrationOffsetMs).toHaveBeenLastCalledWith(300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks later measurement failures as stale after at least one successful sync', async () => {
    const service = new NtpCalibrationService(createClockSource() as any);

    vi.spyOn(service as any, 'queryNtpServer').mockResolvedValueOnce(20)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(20)
      .mockRejectedValue(new Error('offline'));

    await service.triggerMeasurement();
    await service.triggerMeasurement();

    expect(service.getStatus()).toMatchObject({
      measuredOffsetMs: 20,
      syncState: 'stale',
      indicatorState: 'stale',
      errorMessage: 'offline',
    });
  });

  it('uses the updated server order for later measurements', async () => {
    const service = new NtpCalibrationService(createClockSource() as any, ['first.example', 'second.example']);
    const querySpy = vi.spyOn(service as any, 'queryNtpServer')
      .mockResolvedValue(10);

    await service.triggerMeasurement();
    expect(querySpy).toHaveBeenNthCalledWith(1, 'first.example');

    querySpy.mockClear();
    service.setServers(['second.example', 'first.example']);

    await service.triggerMeasurement();
    expect(querySpy).toHaveBeenNthCalledWith(1, 'second.example');
  });

  it('deduplicates concurrent measurements through a shared in-flight promise', async () => {
    const service = new NtpCalibrationService(createClockSource() as any, ['first.example']);
    let resolveRun: (() => void) | null = null;
    const runSpy = vi.spyOn(service as any, 'runMeasurement').mockImplementation(() => (
      new Promise<void>((resolve) => {
        resolveRun = resolve;
      })
    ));

    const pendingA = service.triggerMeasurement();
    const pendingB = service.triggerMeasurement();

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(resolveRun).not.toBeNull();
    resolveRun!();
    await Promise.all([pendingA, pendingB]);
  });
});
