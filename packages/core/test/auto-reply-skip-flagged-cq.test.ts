import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'eventemitter3';
import { RadioOperator } from '../src/operator/RadioOperator';
import { MODES, type DigitalRadioEngineEvents, type SlotInfo, type SlotPack, TransmitRequest } from '@tx5dr/contracts';

class DummyRadioEngine {
  readonly sharedEventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
  readonly startTime = Math.floor(Date.now() / 60000) * 60000;
  slotIndex = 0;
  messagesPool: TransmitRequest[] = [];
  messagesLog: string[] = [];
  lastSlotPack: SlotPack | null = null;

  constructor() {
    this.sharedEventEmitter.on('requestTransmit', (request) => {
      this.messagesPool.push(request);
    });
    this.sharedEventEmitter.on('checkHasWorkedCallsign' as any, (data: {operatorId: string, callsign: string, requestId: string}) => {
      this.sharedEventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false
      });
    });
  }

  async nextCycle() {
    this.slotIndex++;
    const slotInfo = createSlotInfo(`slot${this.slotIndex}`, this.startTime + this.slotIndex * 15000);
    const promises: Promise<void>[] = [];
    this.sharedEventEmitter.listeners('slotStart').forEach((listener: any) => {
      const result = listener(slotInfo, this.lastSlotPack);
      if (result instanceof Promise) promises.push(result);
    });
    await Promise.all(promises);
    this.sharedEventEmitter.emit('encodeStart' as any, slotInfo);
    this.lastSlotPack = createSlotPack(slotInfo.id, slotInfo.startMs, this.messagesPool.map(r => r.transmission));
    this.messagesPool.forEach(r => this.messagesLog.push(r.transmission));
    this.messagesPool = [];
  }
}

function createSlotInfo(slotId: string, startMs: number): SlotInfo {
  return {
    id: slotId,
    startMs,
    utcSeconds: Math.floor(startMs / 1000),
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: Math.floor(startMs / 15000) % 2,
    mode: 'FT8'
  };
}

function createSlotPack(slotId: string, startMs: number, messages: string[]): SlotPack {
  return {
    slotId,
    startMs,
    endMs: startMs + 15000,
    frames: messages.map((message, index) => ({
      message,
      snr: -1,
      dt: 0,
      freq: 1000 + index * 100,
      confidence: 0.9
    })),
    stats: {
      totalDecodes: messages.length,
      successfulDecodes: messages.length,
      totalFramesBeforeDedup: messages.length,
      totalFramesAfterDedup: messages.length,
      lastUpdated: startMs
    },
    decodeHistory: []
  };
}

test('自动回复应跳过带标记的CQ (CQ NA ...)', async () => {
  const dummy = new DummyRadioEngine();

  // 我方电台，开启自动回复CQ
  const me = new RadioOperator({
    id: 'BA1ABC',
    mode: MODES.FT8,
    myCallsign: 'BA1ABC',
    myGrid: 'PM95',
    frequency: 7074000,
    transmitCycles: [1],
    maxQSOTimeoutCycles: 3,
    maxCallAttempts: 3,
    autoReplyToCQ: true,
    autoResumeCQAfterFail: true,
    autoResumeCQAfterSuccess: true
  }, dummy.sharedEventEmitter);

  // 远端电台，强制设置其TX6内容为带标记CQ
  const remote = new RadioOperator({
    id: 'BI1RRE',
    mode: MODES.FT8,
    myCallsign: 'BI1RRE',
    myGrid: 'ON80',
    frequency: 7074000,
    transmitCycles: [0],
    maxQSOTimeoutCycles: 3,
    maxCallAttempts: 3,
    autoReplyToCQ: false,
    autoResumeCQAfterFail: true,
    autoResumeCQAfterSuccess: true
  }, dummy.sharedEventEmitter);

  // 覆盖其发射槽位内容，注入带标记CQ
  remote.userCommand?.({ command: 'set_state', args: 'TX6' } as any);
  remote.userCommand?.({ command: 'set_slot_content', args: { slot: 'TX6', content: 'CQ NA BI1RRE ON80' } } as any);

  me.start();
  remote.start();

  // 跑若干周期，观察 me 是否会向 BI1RRE 发起呼叫
  for (let i = 0; i < 4; i++) {
    await dummy.nextCycle();
  }

  // 断言：消息中不应包含 "BI1RRE BA1ABC" 或 "BA1ABC BI1RRE" 的呼叫/报告（表示未自动回应）
  const joined = dummy.messagesLog.join('\n');
  assert.ok(!/BI1RRE BA1ABC/.test(joined) && !/BA1ABC BI1RRE/.test(joined), '不应自动回复带标记的CQ');
});

