import { describe, expect, it, vi } from 'vitest';
import { VoiceSessionManager } from '../VoiceSessionManager.js';

function createManager(supportedModes: string[]) {
  const radioManager = {
    getSupportedRadioModeOptions: vi.fn(() => supportedModes),
    setMode: vi.fn().mockResolvedValue(undefined),
    applyRepeaterDuplexConfig: vi.fn().mockResolvedValue(undefined),
    applyToneSquelchConfig: vi.fn().mockResolvedValue(undefined),
  };
  const audioStreamManager = {
    setVoiceOutputObserver: vi.fn(),
  };

  const manager = new VoiceSessionManager({
    radioManager: radioManager as never,
    audioStreamManager: audioStreamManager as never,
  });

  return { manager, radioManager };
}

describe('VoiceSessionManager radio mode selection', () => {
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
});
