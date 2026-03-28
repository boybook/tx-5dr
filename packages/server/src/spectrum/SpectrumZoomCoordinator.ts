import { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { SpectrumCoordinator } from './SpectrumCoordinator.js';
import type { SpectrumFrame, SpectrumZoomDirection, SpectrumZoomLevel, SpectrumZoomState } from '@tx5dr/contracts';
import { HamlibConnection } from '../radio/connections/HamlibConnection.js';
import { IcomWlanConnection } from '../radio/connections/IcomWlanConnection.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SpectrumZoomCoordinator');

const ZOOM_CONFIRM_TIMEOUT_MS = 2000;
interface SpectrumZoomCoordinatorEvents {
  stateChanged: (state: SpectrumZoomState) => void;
}

type ZoomCapableConnection = HamlibConnection | IcomWlanConnection;

export class SpectrumZoomCoordinator extends EventEmitter<SpectrumZoomCoordinatorEvents> {
  private currentState: SpectrumZoomState = {
    kind: 'radio-sdr',
    supported: false,
    available: false,
    levels: [],
    currentLevelId: null,
    currentSpanHz: null,
    canZoomIn: false,
    canZoomOut: false,
  };
  private lastRadioFrame: SpectrumFrame | null = null;
  private pendingTargetSpanHz: number | null = null;
  private pendingConnectionType: 'hamlib' | 'icom-wlan' | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly engine: DigitalRadioEngine,
    private readonly spectrumCoordinator: SpectrumCoordinator,
  ) {
    super();

    this.engine.on('radioStatusChanged', () => {
      this.clearPending();
      void this.refresh();
    });
    this.engine.on('profileChanged', () => {
      this.clearPending();
      void this.refresh();
    });
    this.spectrumCoordinator.on('capabilitiesChanged', () => {
      void this.refresh();
    });
    this.spectrumCoordinator.on('frame', (frame) => {
      if (frame.kind !== 'radio-sdr') {
        return;
      }
      this.lastRadioFrame = frame;
      if (this.pendingTargetSpanHz !== null && this.isPendingConfirmed(frame)) {
        this.clearPending();
      }
      void this.refresh();
    });
  }

  getCurrentState(): SpectrumZoomState {
    return this.currentState;
  }

  async refresh(): Promise<SpectrumZoomState> {
    const nextState = await this.buildState();
    if (!this.areStatesEqual(this.currentState, nextState)) {
      this.currentState = nextState;
      this.emit('stateChanged', nextState);
    } else {
      this.currentState = nextState;
    }
    return this.currentState;
  }

  async step(direction: SpectrumZoomDirection): Promise<void> {
    const state = await this.refresh();
    if (!state.supported || !state.available || !state.currentLevelId) {
      return;
    }

    const currentIndex = state.levels.findIndex(level => level.id === state.currentLevelId);
    if (currentIndex < 0) {
      return;
    }

    const nextIndex = direction === 'in' ? currentIndex + 1 : currentIndex - 1;
    const nextLevel = state.levels[nextIndex];
    if (!nextLevel) {
      return;
    }

    const connection = this.getZoomCapableConnection();
    if (!connection?.setSpectrumSpan) {
      return;
    }

    this.pendingTargetSpanHz = nextLevel.spanHz;
    this.pendingConnectionType = connection instanceof HamlibConnection ? 'hamlib' : 'icom-wlan';
    this.resetPendingTimer();

    await this.refresh();

    try {
      await connection.setSpectrumSpan(nextLevel.spanHz);
    } catch (error) {
      logger.warn('Failed to set spectrum zoom level', error);
      this.clearPending();
      await this.refresh();
    }
  }

  private async buildState(): Promise<SpectrumZoomState> {
    const connection = this.getZoomCapableConnection();
    if (!connection) {
      return this.createUnavailableState(false, false);
    }

    const connected = this.engine.getRadioManager().isConnected();
    if (!connected) {
      return this.createUnavailableState(true, false);
    }

    try {
      const levels = await this.getZoomLevels(connection);
      if (levels.length === 0) {
        return this.createUnavailableState(false, false);
      }

      const currentSpanHz = await this.resolveCurrentSpan(connection);
      const currentLevel = this.resolveCurrentLevel(levels, currentSpanHz);
      const currentLevelId = currentLevel?.id ?? null;
      const currentIndex = currentLevel ? levels.findIndex((level: SpectrumZoomLevel) => level.id === currentLevel.id) : -1;
      const canZoomIn = this.pendingTargetSpanHz === null && currentIndex >= 0 && currentIndex < levels.length - 1;
      const canZoomOut = this.pendingTargetSpanHz === null && currentIndex > 0;

      return {
        kind: 'radio-sdr',
        supported: true,
        available: true,
        levels,
        currentLevelId,
        currentSpanHz,
        canZoomIn,
        canZoomOut,
      };
    } catch (error) {
      logger.warn('Failed to refresh spectrum zoom state', error);
      return this.createUnavailableState(true, false);
    }
  }

  private createUnavailableState(supported: boolean, available: boolean): SpectrumZoomState {
    return {
      kind: 'radio-sdr',
      supported,
      available,
      levels: [],
      currentLevelId: null,
      currentSpanHz: null,
      canZoomIn: false,
      canZoomOut: false,
    };
  }

  private getZoomCapableConnection(): ZoomCapableConnection | null {
    const radioManager = this.engine.getRadioManager();
    const activeConnection = radioManager.getActiveConnection();
    if (activeConnection instanceof HamlibConnection && typeof activeConnection.getSpectrumSpans === 'function') {
      return activeConnection;
    }

    const wlanManager = radioManager.getIcomWlanManager();
    if (wlanManager instanceof IcomWlanConnection && typeof wlanManager.getSpectrumSpans === 'function') {
      return wlanManager;
    }

    return null;
  }

  private async getZoomLevels(connection: ZoomCapableConnection): Promise<SpectrumZoomLevel[]> {
    const spans = await connection.getSpectrumSpans?.();
    const uniqueSpans = Array.from(new Set((spans ?? []).filter((span): span is number => Number.isFinite(span) && span > 0)))
      .sort((left, right) => right - left);

    return uniqueSpans.map((spanHz) => ({
      id: String(spanHz),
      label: this.formatSpanLabel(spanHz, connection instanceof IcomWlanConnection),
      spanHz,
    }));
  }

  private async resolveCurrentSpan(connection: ZoomCapableConnection): Promise<number | null> {
    const queriedSpanHz = await connection.getCurrentSpectrumSpan?.();
    if (typeof queriedSpanHz === 'number' && Number.isFinite(queriedSpanHz) && queriedSpanHz > 0) {
      return queriedSpanHz;
    }

    if (!this.lastRadioFrame) {
      return null;
    }

    const frameSpanHz = this.lastRadioFrame.meta.spanHz ?? Math.abs(this.lastRadioFrame.frequencyRange.max - this.lastRadioFrame.frequencyRange.min);
    if (!Number.isFinite(frameSpanHz) || frameSpanHz <= 0) {
      return null;
    }

    if (connection instanceof IcomWlanConnection) {
      return Math.round(frameSpanHz / 2);
    }

    return Math.round(frameSpanHz);
  }

  private resolveCurrentLevel(levels: SpectrumZoomLevel[], currentSpanHz: number | null): SpectrumZoomLevel | null {
    if (!Number.isFinite(currentSpanHz) || currentSpanHz === null || currentSpanHz <= 0) {
      return null;
    }

    const exactMatch = levels.find((level) => level.spanHz === currentSpanHz);
    if (exactMatch) {
      return exactMatch;
    }

    let nearestLevel: SpectrumZoomLevel | null = null;
    let nearestDelta = Number.POSITIVE_INFINITY;

    for (const level of levels) {
      const delta = Math.abs(level.spanHz - currentSpanHz);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearestLevel = level;
      }
    }

    if (!nearestLevel) {
      return null;
    }

    const relativeDelta = nearestDelta / nearestLevel.spanHz;
    return relativeDelta <= 0.2 ? nearestLevel : null;
  }

  private isPendingConfirmed(frame: SpectrumFrame): boolean {
    if (this.pendingTargetSpanHz === null || this.pendingConnectionType === null) {
      return false;
    }

    const frameSpanHz = frame.meta.spanHz ?? Math.abs(frame.frequencyRange.max - frame.frequencyRange.min);
    if (!Number.isFinite(frameSpanHz) || frameSpanHz <= 0) {
      return false;
    }

    if (this.pendingConnectionType === 'icom-wlan') {
      return Math.abs(frameSpanHz - (this.pendingTargetSpanHz * 2)) <= 1;
    }

    return Math.abs(frameSpanHz - this.pendingTargetSpanHz) <= 1;
  }

  private resetPendingTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.clearPending();
      void this.refresh();
    }, ZOOM_CONFIRM_TIMEOUT_MS);
  }

  private clearPending(): void {
    this.pendingTargetSpanHz = null;
    this.pendingConnectionType = null;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private formatSpanLabel(spanHz: number, isIcomCenterSpan: boolean): string {
    const magnitudeHz = isIcomCenterSpan ? spanHz : spanHz;
    if (magnitudeHz >= 1_000_000) {
      const value = magnitudeHz / 1_000_000;
      return `${isIcomCenterSpan ? '±' : ''}${Number.isInteger(value) ? value : value.toFixed(1)} MHz`;
    }
    if (magnitudeHz >= 1_000) {
      const value = magnitudeHz / 1_000;
      return `${isIcomCenterSpan ? '±' : ''}${Number.isInteger(value) ? value : value.toFixed(1)} kHz`;
    }
    return `${isIcomCenterSpan ? '±' : ''}${magnitudeHz} Hz`;
  }

  private areStatesEqual(left: SpectrumZoomState, right: SpectrumZoomState): boolean {
    if (left.supported !== right.supported
      || left.available !== right.available
      || left.currentLevelId !== right.currentLevelId
      || left.currentSpanHz !== right.currentSpanHz
      || left.canZoomIn !== right.canZoomIn
      || left.canZoomOut !== right.canZoomOut
      || left.levels.length !== right.levels.length) {
      return false;
    }

    return left.levels.every((level: SpectrumZoomLevel, index: number) => {
      const other = right.levels[index];
      return other
        && other.id === level.id
        && other.label === level.label
        && other.spanHz === level.spanHz;
    });
  }
}
