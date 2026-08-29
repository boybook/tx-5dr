import { describe, expect, it } from 'vitest';
import {
  assistedQSOQueueLocales,
  assistedQSOQueueQuickSettings,
  assistedQSOQueueSettings,
} from './index.js';

describe('assisted QSO queue plugin metadata', () => {
  it('exposes only settings that affect assisted queue behavior', () => {
    expect(Object.keys(assistedQSOQueueSettings)).toEqual([
      'strategyOverview',
      'replyToWorkedStations',
      'distinguishWorkedStationsByBand',
      'skipTx1',
      'maxQSOTimeoutCycles',
      'maxCallAttempts',
      'parallelStreams',
    ]);
  });

  it('surfaces only high-frequency assisted queue toggles as quick settings', () => {
    expect(assistedQSOQueueQuickSettings.map((entry) => entry.settingKey)).toEqual([
      'replyToWorkedStations',
      'distinguishWorkedStationsByBand',
      'skipTx1',
      'parallelStreams',
    ]);
  });

  it('reuses standard QSO setting translations under its own plugin namespace', () => {
    expect(assistedQSOQueueLocales.zh).toMatchObject({
      pluginName: '辅助队列',
      autoReplyToCQ: '自动回应他人 CQ',
      maxCallAttempts: 'TX1 最多呼叫轮数',
      strategyOverview: '辅助队列说明',
    });
    expect(assistedQSOQueueLocales.en).toMatchObject({
      pluginName: 'Assisted Queue',
      autoReplyToCQ: "Answer others' CQ",
    });
    expect(assistedQSOQueueLocales.ja).toMatchObject({
      pluginName: 'アシストキュー',
      autoReplyToCQ: '他局の CQ に自動応答',
    });
  });
});
