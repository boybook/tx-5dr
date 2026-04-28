import type { RealtimeScope } from '@tx5dr/contracts';
import type { BufferedPreviewAudioService } from '../audio/BufferedPreviewAudioService.js';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import { OpenWebRXStationManager } from '../openwebrx/OpenWebRXStationManager.js';
import { createLogger } from '../utils/logger.js';
import { BufferedPreviewRxSource, NativeRadioRxSource, type RealtimeRxAudioSource, type RealtimeRxAudioSourceStats } from './RealtimeRxAudioSource.js';

const logger = createLogger('RealtimeRxAudioRouter');

export class RealtimeRxAudioRouter {
  private readonly nativeRadioSource: NativeRadioRxSource;
  private readonly bufferedSources = new WeakMap<BufferedPreviewAudioService, BufferedPreviewRxSource>();
  private readonly bufferedSourceSet = new Set<BufferedPreviewRxSource>();
  private readonly stationManager = OpenWebRXStationManager.getInstance();
  private lastResolvedByKey = new Map<string, string>();

  constructor(audioStreamManager: AudioStreamManager) {
    this.nativeRadioSource = new NativeRadioRxSource(audioStreamManager);
  }

  resolveSource(scope: RealtimeScope, previewSessionId?: string): RealtimeRxAudioSource | null {
    if (scope === 'radio') {
      this.logSourceResolution('radio', this.nativeRadioSource);
      return this.nativeRadioSource;
    }

    const status = this.stationManager.getListenStatus();
    if (!status?.isListening || !status.previewSessionId || status.previewSessionId !== previewSessionId) {
      this.logSourceResolution(`openwebrx-preview:${previewSessionId ?? 'none'}`, null);
      return null;
    }

    const monitor = this.stationManager.getBufferedPreviewAudioService();
    const source = monitor ? this.getBufferedSource(monitor, 'openwebrx-monitor', `openwebrx:${status.previewSessionId}`) : null;
    this.logSourceResolution(`openwebrx-preview:${previewSessionId ?? 'none'}`, source);
    return source;
  }

  getLatestStats(scope: RealtimeScope, previewSessionId?: string): RealtimeRxAudioSourceStats | null {
    return this.resolveSource(scope, previewSessionId)?.getLatestStats() ?? null;
  }

  dispose(): void {
    this.nativeRadioSource.dispose();
    for (const source of this.bufferedSourceSet) {
      source.dispose();
    }
    this.bufferedSourceSet.clear();
    this.lastResolvedByKey.clear();
  }

  private getBufferedSource(
    monitor: BufferedPreviewAudioService,
    monitorKind: 'openwebrx-monitor',
    idSuffix: string,
  ): BufferedPreviewRxSource {
    const existing = this.bufferedSources.get(monitor);
    if (existing) {
      return existing;
    }

    const source = new BufferedPreviewRxSource(`buffered-preview:${idSuffix}`, monitor, monitorKind);
    this.bufferedSources.set(monitor, source);
    this.bufferedSourceSet.add(source);
    return source;
  }

  private logSourceResolution(key: string, source: RealtimeRxAudioSource | null): void {
    const sourceId = source?.id ?? 'unavailable';
    if (this.lastResolvedByKey.get(key) === sourceId) {
      return;
    }

    this.lastResolvedByKey.set(key, sourceId);
    logger.info('Realtime RX source resolved', {
      key,
      sourceId,
      sourcePath: source?.sourcePath ?? null,
    });
  }
}
