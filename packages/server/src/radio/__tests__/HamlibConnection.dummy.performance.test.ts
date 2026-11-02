import { describe, expect, it } from 'vitest';
import { HamlibConnection } from '../connections/HamlibConnection.js';
import { RadioCapabilityManager } from '../RadioCapabilityManager.js';

describe('native Hamlib Dummy boundary', () => {
  it('round-trips control through the real native adapter and capability owner', async () => {
    const connection = new HamlibConnection();
    const capabilities = new RadioCapabilityManager();
    try {
      await connection.connect({ type: 'serial', serial: { path: process.platform === 'win32' ? 'NUL' : '/dev/null', rigModel: 1 }, pttMethod: 'cat' });
      await connection.applyOperatingState({ frequency: 14074000, mode: 'USB', bandwidth: 3000 });
      expect(await connection.getFrequency()).toBe(14074000);
      expect(await connection.getMode()).toMatchObject({ mode: 'USB', bandwidth: 3000 });
      await connection.setVfo('VFOB'); expect(await connection.getVfo()).toBe('VFOB'); await connection.setVfo('VFOA');
      await connection.setPTT(true); expect(await connection.getPTT()).toBe(true);
      await connection.setPTT(false); expect(await connection.getPTT()).toBe(false);
      await capabilities.onConnected(connection);
      await capabilities.writeCapability('rf_power', 0.25);
      expect(await connection.getRFPower()).toBeCloseTo(0.25);
      await capabilities.writeCapability('af_gain', 0.4);
      expect(await connection.getAFGain()).toBeCloseTo(0.4);
      expect(capabilities.getCapabilityState('rf_power')).toMatchObject({ supported: true, value: 0.25 });
      await expect(capabilities.writeCapability('rf_power', 1.1)).rejects.toThrow('out of range');
      await expect(capabilities.writeCapability('tx_audio_input_source', 'usb')).rejects.toThrow();
      await connection.setPowerState('on'); expect(await connection.getPowerState()).toBe('on');
    } finally { capabilities.onDisconnected(); await connection.disconnect('Dummy regression complete'); }
  }, 30000);
});
