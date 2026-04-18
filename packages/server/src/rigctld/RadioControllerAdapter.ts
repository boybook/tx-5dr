/**
 * Adapter bridging the @tx5dr/rigctld-server `RadioController` interface onto
 * tx-5dr's `PhysicalRadioManager` + `IRadioConnection`.
 *
 * Design rules:
 *   - Every write funnels through the manager's critical path (applyOperatingState
 *     for frequency/mode, setPTT for PTT, RadioPowerController for powerstat) so
 *     rigctld clients can never bypass the serialization / lifecycle guarantees
 *     documented in packages/server/CLAUDE.md.
 *   - Auxiliary getters (lock, RIT, XIT, tuning step, levels) are routed to the
 *     matching optional method on the active IRadioConnection. When the current
 *     connection doesn't implement a getter, reads fall back to a honest
 *     "feature disabled" default and writes return RIG_ENIMPL rather than
 *     silently discarding the request.
 *   - The adapter re-probes the connection on every call: a profile switch
 *     replaces the IRadioConnection instance, and we want the new connection's
 *     capability set to take effect immediately.
 */

import {
  RigctldProtocolError,
  RigErr,
  type RadioController,
  type RadioModeResult,
  type RigctlLevel,
  type RigctlMode,
  type RigctlVfo,
} from '@tx5dr/rigctld-server';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { IRadioConnection, RadioModeBandwidth } from '../radio/connections/IRadioConnection.js';
import { ConfigManager } from '../config/config-manager.js';
import { RadioPowerController } from '../radio/RadioPowerController.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RigctldAdapter');

const SUPPORTED_RIGCTL_MODES: ReadonlySet<string> = new Set([
  'USB', 'LSB', 'CW', 'CWR', 'AM', 'FM', 'WFM', 'RTTY', 'RTTYR',
  'PKTUSB', 'PKTLSB', 'PKTFM',
]);

/** Translate tx-5dr's free-form mode string to the rigctld vocabulary. */
function toRigctlMode(raw: string): RigctlMode {
  const upper = raw.toUpperCase();
  // tx-5dr already uses the same identifiers, but some older codepaths emit
  // variants like 'USB-D' or 'DATA-U'. Normalise a few common aliases.
  const mapped =
    upper === 'DATA-U' || upper === 'USB-D' ? 'PKTUSB' :
    upper === 'DATA-L' || upper === 'LSB-D' ? 'PKTLSB' :
    upper === 'DIGU' ? 'PKTUSB' :
    upper === 'DIGL' ? 'PKTLSB' :
    upper;
  if (!SUPPORTED_RIGCTL_MODES.has(mapped)) {
    return 'USB';
  }
  return mapped as RigctlMode;
}

function bandwidthToHz(bw: unknown, fallback = 2400): number {
  if (typeof bw === 'number' && Number.isFinite(bw) && bw > 0) return bw;
  return fallback;
}

/**
 * Map rigctl's Hz bandwidth to the tx-5dr connection enum.
 *
 * Rigctl / N1MM / WSJT-X send a numeric passband (e.g. `2400`) together with
 * `M USB 2400`, but different back-ends interpret it very differently:
 *   - Hamlib: takes Hz directly.
 *   - ICOM WLAN: explicitly rejects numeric passbands — the rig picks its own
 *     filter based on the mode preset.
 *
 * A raw Hz value would work for Hamlib but dead-locks ICOM WLAN, so we pick a
 * coarse symbolic bucket that works for both. `0` (rigctl's "unspecified") and
 * any unknown value fall back to `'nochange'`, which preserves the radio's
 * current filter across a pure mode change — the common case for digital-mode
 * loggers, which only care about the mode label.
 */
function hzToBandwidth(hz: number): RadioModeBandwidth {
  if (!Number.isFinite(hz) || hz <= 0) return 'nochange';
  if (hz < 500) return 'narrow';
  if (hz >= 3500) return 'wide';
  return 'normal';
}

export class RadioControllerAdapter implements RadioController {
  constructor(private readonly pm: PhysicalRadioManager) {}

  private requireConnected(): void {
    if (!this.pm.isConnected()) {
      throw new RigctldProtocolError(RigErr.EIO, 'radio not connected');
    }
  }

  async getFrequency(): Promise<number> {
    this.requireConnected();
    const hz = await this.pm.getFrequency();
    if (!Number.isFinite(hz) || hz <= 0) {
      throw new RigctldProtocolError(RigErr.EIO, 'frequency unavailable');
    }
    return hz;
  }

  async setFrequency(hz: number): Promise<void> {
    this.requireConnected();
    const result = await this.pm.applyOperatingState({ frequency: Math.round(hz) });
    if (!result.frequencyApplied) {
      throw new RigctldProtocolError(RigErr.EIO, 'frequency write rejected');
    }
  }

  async getMode(): Promise<RadioModeResult> {
    this.requireConnected();
    const info = await this.pm.getMode();
    return {
      mode: toRigctlMode(info.mode),
      bandwidthHz: bandwidthToHz(info.bandwidth),
    };
  }

  async setMode(mode: RigctlMode, bandwidthHz: number): Promise<void> {
    this.requireConnected();
    const bandwidth = hzToBandwidth(bandwidthHz);
    logger.debug('rigctld setMode requested', { mode, bandwidthHz, bandwidth });
    try {
      const result = await this.pm.applyOperatingState({ mode, bandwidth });
      logger.debug('rigctld setMode result', {
        mode,
        modeApplied: result.modeApplied,
        modeError: result.modeError?.message,
      });
      if (!result.modeApplied) {
        const reason = result.modeError?.message ?? 'mode write rejected';
        throw new RigctldProtocolError(RigErr.EIO, reason);
      }
    } catch (e) {
      if (e instanceof RigctldProtocolError) throw e;
      logger.warn('rigctld setMode failed', { mode, error: (e as Error).message });
      throw new RigctldProtocolError(RigErr.EIO, (e as Error).message);
    }
  }

  async getPTT(): Promise<boolean> {
    return this.pm.isPTTActive();
  }

  async setPTT(on: boolean): Promise<void> {
    this.requireConnected();
    this.pm.setPTTActive(on);
    await this.pm.setPTT(on);
  }

  async getLevel(name: RigctlLevel): Promise<number> {
    this.requireConnected();
    const conn = this.pm.getCurrentConnection();
    if (!conn) throw new RigctldProtocolError(RigErr.EIO, 'radio not connected');
    try {
      switch (name) {
        case 'RFPOWER':
          if (!conn.getRFPower) throw new RigctldProtocolError(RigErr.ENIMPL);
          return await conn.getRFPower();
        case 'AF':
          if (!conn.getAFGain) throw new RigctldProtocolError(RigErr.ENIMPL);
          return await conn.getAFGain();
        case 'SQL':
          if (!conn.getSQL) throw new RigctldProtocolError(RigErr.ENIMPL);
          return await conn.getSQL();
        case 'STRENGTH':
          // S-meter read-only numeric — not wired through yet. Return ENIMPL.
          throw new RigctldProtocolError(RigErr.ENIMPL);
      }
    } catch (e) {
      if (e instanceof RigctldProtocolError) throw e;
      logger.debug('rigctld getLevel failed', { name, error: (e as Error).message });
      throw new RigctldProtocolError(RigErr.EIO, (e as Error).message);
    }
  }

  async setLevel(name: RigctlLevel, value: number): Promise<void> {
    this.requireConnected();
    const conn = this.pm.getCurrentConnection();
    if (!conn) throw new RigctldProtocolError(RigErr.EIO, 'radio not connected');
    const clamped = Math.max(0, Math.min(1, value));
    try {
      switch (name) {
        case 'RFPOWER':
          if (!conn.setRFPower) throw new RigctldProtocolError(RigErr.ENIMPL);
          await conn.setRFPower(clamped);
          return;
        case 'AF':
          if (!conn.setAFGain) throw new RigctldProtocolError(RigErr.ENIMPL);
          await conn.setAFGain(clamped);
          return;
        case 'SQL':
          if (!conn.setSQL) throw new RigctldProtocolError(RigErr.ENIMPL);
          await conn.setSQL(clamped);
          return;
        case 'STRENGTH':
          throw new RigctldProtocolError(RigErr.EINVAL, 'STRENGTH is read-only');
      }
    } catch (e) {
      if (e instanceof RigctldProtocolError) throw e;
      logger.debug('rigctld setLevel failed', { name, error: (e as Error).message });
      throw new RigctldProtocolError(RigErr.EIO, (e as Error).message);
    }
  }

  async getInfo(): Promise<string> {
    const status = this.pm.getConnectionStatus();
    return `tx-5dr rigctld bridge — connection=${status}`;
  }

  /**
   * tx-5dr operates a single VFO abstraction. We report `VFOA` as the current
   * VFO so Hamlib's `rig_open()` handshake can complete — but writes that try
   * to switch to a *different* VFO (B or MEM) must surface as ENIMPL, otherwise
   * loggers would believe they successfully switched VFOs and drift out of
   * sync with what the rig is actually doing.
   */
  async getVFO(): Promise<RigctlVfo> {
    return 'VFOA';
  }

  async setVFO(vfo: RigctlVfo): Promise<void> {
    if (vfo === 'VFOA') return;
    throw new RigctldProtocolError(
      RigErr.ENIMPL,
      `tx-5dr exposes a single VFO; cannot switch to ${vfo}`,
    );
  }

  /**
   * Powerstat read uses the physical connection's `getPowerState()` when
   * available (Hamlib and ICOM WLAN both implement it); otherwise falls back
   * to "powered when connected", which is the truthful observation we can make
   * without a dedicated CAT query.
   */
  async getPowerStat(): Promise<boolean> {
    const conn = this.pm.getCurrentConnection();
    if (conn?.getPowerState) {
      try {
        const state = await conn.getPowerState();
        // Connection-layer values: 'on' | 'operate' treated as powered.
        return state === 'on' || state === 'operate';
      } catch (e) {
        logger.debug('rigctld getPowerStat via connection failed, falling back', {
          error: (e as Error).message,
        });
      }
    }
    return this.pm.isConnected();
  }

  /**
   * Powerstat write routes through RadioPowerController so all the usual
   * Profile-level side-effects (engine wake / teardown, active profile
   * synchronization, broadcast events) are honored. Without that plumbing a
   * direct `connection.setPowerState()` would leave the engine state machine
   * out of step with the physical rig.
   */
  async setPowerStat(on: boolean): Promise<void> {
    const powerController = RadioPowerController.tryGetInstance();
    if (!powerController) {
      throw new RigctldProtocolError(RigErr.EIO, 'power controller not initialized');
    }
    const profile = ConfigManager.getInstance().getActiveProfile();
    if (!profile) {
      throw new RigctldProtocolError(RigErr.EIO, 'no active profile');
    }
    try {
      await powerController.handleRequest({
        profileId: profile.id,
        state: on ? 'on' : 'off',
        autoEngine: true,
      });
    } catch (e) {
      logger.warn('rigctld setPowerStat failed', { on, error: (e as Error).message });
      throw new RigctldProtocolError(RigErr.EIO, (e as Error).message);
    }
  }

  // ─── Optional capabilities (lock / RIT / XIT / tuning-step) ─────────────
  //
  // Each pair routes to the matching optional method on the active connection.
  // The `readOptional` / `writeOptional` helpers centralize the fallback rule:
  //   - read: controller not implemented OR connection method absent → default
  //   - write: either absent → ENIMPL (never silently accepted)

  async getLockMode(): Promise<boolean> {
    return this.readOptional(
      (c) => c.getLockMode,
      (getter, c) => getter.call(c),
      false,
      'getLockMode',
    );
  }
  async setLockMode(locked: boolean): Promise<void> {
    return this.writeOptional(
      (c) => c.setLockMode,
      (setter, c) => setter.call(c, locked),
      'setLockMode',
    );
  }

  async getRit(): Promise<number> {
    return this.readOptional(
      (c) => c.getRitOffset,
      (getter, c) => getter.call(c),
      0,
      'getRit',
    );
  }
  async setRit(offsetHz: number): Promise<void> {
    return this.writeOptional(
      (c) => c.setRitOffset,
      (setter, c) => setter.call(c, Math.round(offsetHz)),
      'setRit',
    );
  }

  async getXit(): Promise<number> {
    return this.readOptional(
      (c) => c.getXitOffset,
      (getter, c) => getter.call(c),
      0,
      'getXit',
    );
  }
  async setXit(offsetHz: number): Promise<void> {
    return this.writeOptional(
      (c) => c.setXitOffset,
      (setter, c) => setter.call(c, Math.round(offsetHz)),
      'setXit',
    );
  }

  async getTuningStep(): Promise<number> {
    return this.readOptional(
      (c) => c.getTuningStep,
      (getter, c) => getter.call(c),
      0,
      'getTuningStep',
    );
  }
  async setTuningStep(stepHz: number): Promise<void> {
    return this.writeOptional(
      (c) => c.setTuningStep,
      (setter, c) => setter.call(c, Math.round(stepHz)),
      'setTuningStep',
    );
  }

  /**
   * Shared helper for optional *read* methods.
   *
   * If no connection is active OR the connection doesn't expose the getter, we
   * return `fallback` so Hamlib handshake probes don't stall. Errors from the
   * underlying call are demoted to the fallback value and a debug log — a
   * transient meter-level read failure shouldn't poison the whole session.
   */
  private async readOptional<TMethod extends (...args: never[]) => unknown, TValue>(
    pick: (conn: IRadioConnection) => TMethod | undefined,
    invoke: (method: TMethod, conn: IRadioConnection) => Promise<TValue> | TValue,
    fallback: TValue,
    label: string,
  ): Promise<TValue> {
    const conn = this.pm.getCurrentConnection();
    if (!conn) return fallback;
    const method = pick(conn);
    if (!method) return fallback;
    try {
      return await invoke(method, conn);
    } catch (e) {
      logger.debug(`rigctld ${label} failed, returning fallback`, {
        error: (e as Error).message,
      });
      return fallback;
    }
  }

  /**
   * Shared helper for optional *write* methods.
   *
   * Writes are not allowed to be silently dropped: if the active connection
   * can't honor the request, we surface `RIG_ENIMPL` so the logger / operator
   * sees a real error, and an underlying CAT failure propagates as `RIG_EIO`.
   */
  private async writeOptional<TMethod extends (...args: never[]) => unknown>(
    pick: (conn: IRadioConnection) => TMethod | undefined,
    invoke: (method: TMethod, conn: IRadioConnection) => Promise<unknown> | unknown,
    label: string,
  ): Promise<void> {
    this.requireConnected();
    const conn = this.pm.getCurrentConnection();
    if (!conn) throw new RigctldProtocolError(RigErr.EIO, 'radio not connected');
    const method = pick(conn);
    if (!method) {
      throw new RigctldProtocolError(
        RigErr.ENIMPL,
        `${label}: not supported by the current radio connection`,
      );
    }
    try {
      await invoke(method, conn);
    } catch (e) {
      if (e instanceof RigctldProtocolError) throw e;
      logger.warn(`rigctld ${label} failed`, { error: (e as Error).message });
      throw new RigctldProtocolError(RigErr.EIO, (e as Error).message);
    }
  }
}
