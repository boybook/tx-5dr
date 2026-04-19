import { describe, expect, it, vi } from 'vitest';
import { NtpCalibrationService } from '../NtpCalibrationService.js';

function createClockSource(initialOffsetMs = 0) {
  let calibrationOffsetMs = initialOffsetMs;

  return {
    getCalibrationOffsetMs: vi.fn(() => calibrationOffsetMs),
    setCalibrationOffsetMs: vi.fn((offsetMs: number) => {
      calibrationOffsetMs = offsetMs;
    }),
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
    const service = new NtpCalibrationService(clockSource as any);

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
