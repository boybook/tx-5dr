import { describe, expect, it, vi } from 'vitest';
import { VoiceSessionManager } from '../VoiceSessionManager.js';
import { ConfigManager } from '../../config/config-manager.js';
import { RadioErrorCode } from '../../utils/errors/RadioError.js';

function createManager(supportedModes: string[]) {
  const radioManager = {
    getSupportedRadioModeOptions: vi.fn(() => supportedModes),
    setMode: vi.fn().mockResolvedValue(undefined),
    applyRepeaterDuplexConfig: vi.fn().mockResolvedValue(undefined),
    applyToneSquelchConfig: vi.fn().mockResolvedValue(undefined),
    getCurrentRadioSessionContext: vi.fn(() => ({ profileId: 'profile-a', sessionGeneration: 1 })),
    isCurrentRadioSessionContext: vi.fn(() => true),
    setPTT: vi.fn().mockResolvedValue(undefined),
  };
  const audioStreamManager = {
    setVoiceOutputObserver: vi.fn(),
    clearVoicePlaybackQueue: vi.fn(),
    setVoiceTxOutputEnabled: vi.fn(),
  };

  const manager = new VoiceSessionManager({
    radioManager: radioManager as never,
    audioStreamManager: audioStreamManager as never,
  });

  return { manager, radioManager, audioStreamManager };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('VoiceSessionManager radio mode selection', () => {
  it('rolls back the PTT lock and audio path when hardware PTT fails', async () => {
    const { manager, radioManager, audioStreamManager } = createManager(['USB']);
    radioManager.setPTT
      .mockRejectedValueOnce(new Error('PTT command rejected'))
      .mockResolvedValueOnce(undefined);
    const pttChanged = vi.fn();
    manager.on('pttStatusChanged', pttChanged);
    await manager.start();

    await expect(manager.startTransmit('client-a', 'Operator A')).resolves.toEqual({
      success: false,
      reason: 'Failed to activate PTT',
    });

    expect(radioManager.setPTT).toHaveBeenNthCalledWith(1, true);
    expect(radioManager.setPTT).toHaveBeenNthCalledWith(2, false);
    expect(audioStreamManager.setVoiceTxOutputEnabled).not.toHaveBeenCalledWith(true);
    expect(pttChanged).not.toHaveBeenCalledWith(expect.objectContaining({ isTransmitting: true }));
    expect(manager.getPTTLockState().locked).toBe(false);
  });

  it('does not announce transmit after a same-Profile radio reconnect', async () => {
    const pttWrite = createDeferred<void>();
    const { manager, radioManager, audioStreamManager } = createManager(['USB']);
    let sessionCurrent = true;
    radioManager.isCurrentRadioSessionContext.mockImplementation(() => sessionCurrent);
    radioManager.setPTT.mockReturnValueOnce(pttWrite.promise);
    const pttChanged = vi.fn();
    manager.on('pttStatusChanged', pttChanged);
    await manager.start();

    const pending = manager.startTransmit('client-a', 'Operator A');
    await vi.waitFor(() => expect(radioManager.setPTT).toHaveBeenCalledWith(true));
    sessionCurrent = false;
    pttWrite.resolve();

    await expect(pending).resolves.toEqual({
      success: false,
      reason: 'Failed to activate PTT',
    });
    expect(radioManager.setPTT).toHaveBeenCalledTimes(1);
    expect(audioStreamManager.setVoiceTxOutputEnabled).not.toHaveBeenCalledWith(true);
    expect(pttChanged).not.toHaveBeenCalledWith(expect.objectContaining({ isTransmitting: true }));
    expect(manager.getPTTLockState().locked).toBe(false);
  });

  it('rejects WFM when the connected radio does not report support', async () => {
    const { manager, radioManager } = createManager(['USB', 'LSB', 'FM', 'AM']);

    await expect(manager.setRadioMode('WFM')).rejects.toThrow(
      "Radio mode 'WFM' is not supported by the current radio",
    );

    expect(radioManager.setMode).not.toHaveBeenCalled();
  });

  it('sets and broadcasts WFM when the connected radio reports support', async () => {
    const { manager, radioManager } = createManager(['USB', 'LSB', 'FM', 'AM', 'WFM']);
    const changed = vi.fn();
    manager.on('voiceRadioModeChanged', changed);

    await expect(manager.setRadioMode('wfm')).resolves.toBeUndefined();

    expect(radioManager.setMode).toHaveBeenCalledWith('WFM', undefined, { intent: 'voice' });
    expect(radioManager.applyRepeaterDuplexConfig).toHaveBeenCalledWith({ repeaterShift: 'none' });
    expect(radioManager.applyToneSquelchConfig).toHaveBeenCalledWith({ toneMode: 'none' });
    expect(changed).toHaveBeenCalledWith({ radioMode: 'WFM' });
  });

  it('drops a voice mode result when the Profile changes during the hardware write', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { manager, radioManager } = createManager(['USB']);
    radioManager.setMode.mockReturnValue(writeGate);
    const updateLastVoiceFrequency = vi.fn().mockResolvedValue(undefined);
    let tokenCurrent = true;
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      captureActiveProfileToken: vi.fn(() => ({ profileId: 'profile-a', generation: 1 })),
      isActiveProfileTokenCurrent: vi.fn(() => tokenCurrent),
      getProfileOperatingState: vi.fn(() => ({
        lastVoiceFrequency: { frequency: 14_270_000, band: '20m', radioMode: 'USB' },
      })),
      updateLastVoiceFrequency,
    } as unknown as ConfigManager);
    const changed = vi.fn();
    manager.on('voiceRadioModeChanged', changed);

    const pending = manager.setRadioMode('USB');
    tokenCurrent = false;
    releaseWrite();
    await pending;

    expect(radioManager.applyRepeaterDuplexConfig).not.toHaveBeenCalled();
    expect(radioManager.applyToneSquelchConfig).not.toHaveBeenCalled();
    expect(updateLastVoiceFrequency).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('stops follow-up hardware writes when the Profile changes during duplex cleanup', async () => {
    let releaseDuplexWrite!: () => void;
    const duplexWriteGate = new Promise<void>((resolve) => {
      releaseDuplexWrite = resolve;
    });
    const { manager, radioManager } = createManager(['USB']);
    radioManager.applyRepeaterDuplexConfig.mockReturnValue(duplexWriteGate);
    const updateLastVoiceFrequency = vi.fn().mockResolvedValue(undefined);
    let tokenCurrent = true;
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      captureActiveProfileToken: vi.fn(() => ({ profileId: 'profile-a', generation: 1 })),
      isActiveProfileTokenCurrent: vi.fn(() => tokenCurrent),
      getProfileOperatingState: vi.fn(() => ({
        lastVoiceFrequency: { frequency: 14_270_000, band: '20m', radioMode: 'USB' },
      })),
      updateLastVoiceFrequency,
    } as unknown as ConfigManager);
    const changed = vi.fn();
    manager.on('voiceRadioModeChanged', changed);

    const pending = manager.setRadioMode('USB');
    await vi.waitFor(() => {
      expect(radioManager.applyRepeaterDuplexConfig).toHaveBeenCalledWith({ repeaterShift: 'none' });
    });
    tokenCurrent = false;
    releaseDuplexWrite();
    await pending;

    expect(radioManager.applyToneSquelchConfig).not.toHaveBeenCalled();
    expect(updateLastVoiceFrequency).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('rejects stale aux results after a same-Profile radio reconnect', async () => {
    let releaseDuplexWrite!: () => void;
    const duplexWriteGate = new Promise<void>((resolve) => {
      releaseDuplexWrite = resolve;
    });
    const { manager, radioManager } = createManager(['USB']);
    radioManager.applyRepeaterDuplexConfig.mockReturnValue(duplexWriteGate);
    const updateLastVoiceFrequency = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      captureActiveProfileToken: vi.fn(() => ({ profileId: 'profile-a', generation: 1 })),
      isActiveProfileTokenCurrent: vi.fn(() => true),
      getProfileOperatingState: vi.fn(() => ({
        lastVoiceFrequency: { frequency: 14_270_000, band: '20m', radioMode: 'USB' },
      })),
      updateLastVoiceFrequency,
    } as unknown as ConfigManager);
    const changed = vi.fn();
    manager.on('voiceRadioModeChanged', changed);

    const pending = manager.setRadioMode('USB');
    await vi.waitFor(() => {
      expect(radioManager.applyRepeaterDuplexConfig).toHaveBeenCalledTimes(1);
    });
    radioManager.isCurrentRadioSessionContext.mockReturnValue(false);
    releaseDuplexWrite();

    await expect(pending).rejects.toMatchObject({
      code: RadioErrorCode.OPERATION_CANCELLED,
      message: 'radio session changed during voice radio mode operation',
    });
    expect(radioManager.applyToneSquelchConfig).not.toHaveBeenCalled();
    expect(updateLastVoiceFrequency).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
