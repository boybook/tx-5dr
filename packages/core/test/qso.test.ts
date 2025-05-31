import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'eventemitter3';
import { RadioOperator } from '../src/operator/RadioOperator';
import { MODES, TransmitRequest, type DigitalRadioEngineEvents, type SlotInfo, type SlotPack } from '@tx5dr/contracts';
import { StandardQSOStrategy } from '../src/operator/transmission/strategies/StandardQSOStrategy';

// 创建一个共享的事件发射器，用于模拟所有电台之间的通信

class DummyRadioEngine {

    readonly sharedEventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    readonly startTime = Math.floor(Date.now() / 60000) * 60000;
    slotIndex = 0;
    messagesPool: TransmitRequest[] = [];
    messagesLog: string[] = [];

    constructor() {
        this.sharedEventEmitter.on('requestTransmit', (request) => {
            this.messagesPool.push(request);
        });
    }

    nextCycle() {
        this.slotIndex++;
        const slotInfo = createSlotInfo(`slot${this.slotIndex}`, this.startTime + this.slotIndex * 15000);
        this.sharedEventEmitter.emit('slotStart', slotInfo);
        
        // 打印当前时隙的消息
        this.messagesPool.forEach(request => {
            console.log(`📢 [${this.slotIndex}] ${request.operatorId} -> ${request.transmission}`);
            this.messagesLog.push(request.transmission);
        });

        this.sharedEventEmitter.emit('slotPackUpdated', createSlotPack(slotInfo.id, slotInfo.startMs, this.messagesPool.map(request => request.transmission)));
        this.messagesPool = [];
    }

}

// 创建一个简单的时隙信息生成器
function createSlotInfo(slotId: string, startMs: number): SlotInfo {
    return {
        id: slotId,
        startMs,
        utcSeconds: Math.floor(startMs / 1000),
        phaseMs: 0,
        driftMs: 0,
        cycleNumber: Math.floor(startMs / 15000) % 2, // FT8时隙长度为15秒
        mode: 'FT8'
    };
}

// 创建一个简单的时隙包生成器
function createSlotPack(slotId: string, startMs: number, messages: string[]): SlotPack {
    return {
        slotId,
        startMs,
        endMs: startMs + 15000, // FT8时隙长度为15秒
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

test('QSO通联周期测试', async (t) => {
    await t.test('基础双方通联', async () => {
        console.log('⌛️ 基础双方通联');
        const dummyRadioEngine = new DummyRadioEngine();
        const operator1 = new RadioOperator({
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
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));
        const operator2 = new RadioOperator({
            id: 'BA2XYZ',
            mode: MODES.FT8,
            myCallsign: 'BA2XYZ',
            myGrid: 'PM96',
            frequency: 7074000,
            transmitCycles: [0],
            maxQSOTimeoutCycles: 3,
            maxCallAttempts: 3,
            autoReplyToCQ: true,
            autoResumeCQAfterFail: true,
            autoResumeCQAfterSuccess: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));
        for (let i = 0; i < 6; i++) {
            dummyRadioEngine.nextCycle();
        }
        const expectedMessages: string[] = [
            'CQ BA1ABC PM95',           // TX1: BA1ABC发送CQ
            'BA1ABC BA2XYZ PM96',       // TX2: BA2XYZ回复
            'BA2XYZ BA1ABC -01',        // TX3: BA1ABC确认
            'BA1ABC BA2XYZ R-01',       // TX4: BA2XYZ发送信号报告
            'BA2XYZ BA1ABC RR73',       // TX5: BA1ABC发送73
            'BA1ABC BA2XYZ 73'          // TX6: BA2XYZ确认73
        ];
        assert.deepStrictEqual(dummyRadioEngine.messagesLog, expectedMessages);
        assert.ok(true, 'QSO测试完成');
    });

    await t.test('测试多方依次通联', async () => {
        console.log('⌛️ 测试多方依次通联');
        const dummyRadioEngine = new DummyRadioEngine();
        const me = new RadioOperator({
            id: 'BA1ABC',
            mode: MODES.FT8,
            myCallsign: 'BA1ABC',
            myGrid: 'PM95',
            frequency: 7074000,
            transmitCycles: [1],
            maxQSOTimeoutCycles: 100,
            maxCallAttempts: 100,
            autoReplyToCQ: true,
            autoResumeCQAfterFail: true,
            autoResumeCQAfterSuccess: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));
        const callsigns = ['BA2XYZ', 'BA3XYZ', 'BA4XYZ', 'BA5XYZ', 'BA6XYZ'];
        for (const callsign of callsigns) {
            const operator = new RadioOperator({
                id: callsign,
                mode: MODES.FT8,
                myCallsign: callsign,
                myGrid: 'PM96',
                frequency: 7074000,
                transmitCycles: [0],
                maxQSOTimeoutCycles: 100,
                maxCallAttempts: 100,
                autoReplyToCQ: true,
                autoResumeCQAfterFail: true,
                autoResumeCQAfterSuccess: true
            }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));
            operator.userCommand({
                command: 'update_context',
                args: {
                    targetCallsign: 'BA1ABC',
                    targetGrid: 'PM95',
                }
            })
            operator.userCommand({
                command: 'set_state',
                args: 'TX1'
            })
        }
        for (let i = 0; i < 40; i++) {
            console.log('🔄 第', i + 1, '个时隙');
            dummyRadioEngine.nextCycle();
        }
        assert.ok(true, '多人通联完成');
    });

    await t.test('双方通联（衰落）测试', async () => {
        console.log('⌛️ 双方通联（衰落）测试');
        const dummyRadioEngine = new DummyRadioEngine();
        const operator1 = new RadioOperator({
            id: 'BA1ABC',
            mode: MODES.FT8,
            myCallsign: 'BA1ABC',
            myGrid: 'PM95',
            frequency: 7074000,
            transmitCycles: [1],
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: true,
            autoResumeCQAfterFail: true,
            autoResumeCQAfterSuccess: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));
        const operator2 = new RadioOperator({
            id: 'BA2XYZ',
            mode: MODES.FT8,
            myCallsign: 'BA2XYZ',
            myGrid: 'PM96',
            frequency: 7074000,
            transmitCycles: [0],
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: true,
            autoResumeCQAfterFail: true,
            autoResumeCQAfterSuccess: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));
        for (let i = 0; i < 15; i++) {
            if (i === 3) {
                operator2.stop();
            } else if (i === 10) {
                operator2.start();
            }
            dummyRadioEngine.nextCycle();
        }

        const expectedMessages: string[] = [
            'CQ BA1ABC PM95',
            'BA1ABC BA2XYZ PM96',
            'BA2XYZ BA1ABC -01',
            'BA2XYZ BA1ABC -01',
            'BA2XYZ BA1ABC -01',
            'BA2XYZ BA1ABC -01',
            'BA2XYZ BA1ABC -01',
            'BA1ABC BA2XYZ R-01',
            'BA2XYZ BA1ABC RR73',
            'BA1ABC BA2XYZ 73',
            'CQ BA1ABC PM95'
        ];
        assert.deepStrictEqual(dummyRadioEngine.messagesLog, expectedMessages);
        assert.ok(true, 'QSO测试完成');
    });

}); 