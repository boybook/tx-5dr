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
    lastSlotPack: SlotPack | null = null;

    constructor() {
        this.sharedEventEmitter.on('requestTransmit', (request) => {
            this.messagesPool.push(request);
        });
        // 添加 hasWorkedCallsign 查询的响应处理器
        this.sharedEventEmitter.on('checkHasWorkedCallsign' as any, (data: {operatorId: string, callsign: string, requestId: string}) => {
            // 在测试环境中，假设没有任何电台曾经通联过
            this.sharedEventEmitter.emit('hasWorkedCallsignResponse' as any, {
                requestId: data.requestId,
                hasWorked: false
            });
        });
    }

    async nextCycle() {
        this.slotIndex++;
        const slotInfo = createSlotInfo(`slot${this.slotIndex}`, this.startTime + this.slotIndex * 15000);
        // 首先发射 slotStart 事件，处理上一个时隙的消息并做出决策
        // 需要等待所有异步处理完成
        const promises: Promise<void>[] = [];
        this.sharedEventEmitter.listeners('slotStart').forEach((listener: any) => {
            const result = listener(slotInfo, this.lastSlotPack);
            if (result instanceof Promise) {
                promises.push(result);
            }
        });
        await Promise.all(promises);

        // 然后发射 encodeStart 事件，让 operators 根据最新决策准备发射内容
        this.sharedEventEmitter.emit('encodeStart' as any, slotInfo);
        // 保存当前时隙的消息池
        this.lastSlotPack = createSlotPack(slotInfo.id, slotInfo.startMs, this.messagesPool.map(request => request.transmission));

        // 打印当前时隙的消息
        this.messagesPool.forEach(request => {
            console.log(`📢 [${this.slotIndex}] ${request.operatorId} -> ${request.transmission}`);
            this.messagesLog.push(request.transmission);
        });
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
        // 启动两个 operators
        operator1.start();
        operator2.start();
        for (let i = 0; i < 6; i++) {
            await dummyRadioEngine.nextCycle();
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
            operator.start();
        }
        me.start();
        for (let i = 0; i < 40; i++) {
            console.log('🔄 第', i + 1, '个时隙');
            await dummyRadioEngine.nextCycle();
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
        // 启动两个 operators
        operator1.start();
        operator2.start();
        for (let i = 0; i < 15; i++) {
            if (i === 3) {
                operator2.stop();
            } else if (i === 10) {
                operator2.start();
            }
            await dummyRadioEngine.nextCycle();
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

    await t.test('TX4收到73时同时收到新直接呼叫，应优先回复直接呼叫', async () => {
        console.log('⌛️ TX4收到73时同时收到新直接呼叫');
        const dummyRadioEngine = new DummyRadioEngine();

        // 我（BG5DRB）与JQ2LVH通联
        const me = new RadioOperator({
            id: 'BG5DRB',
            mode: MODES.FT8,
            myCallsign: 'BG5DRB',
            myGrid: 'PL09',
            frequency: 14074000,
            transmitCycles: [0], // 偶数周期发射
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: true,
            autoResumeCQAfterFail: true,
            autoResumeCQAfterSuccess: true,
            replyToWorkedStations: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));

        // JQ2LVH（正在通联的对象）
        const jq2lvh = new RadioOperator({
            id: 'JQ2LVH',
            mode: MODES.FT8,
            myCallsign: 'JQ2LVH',
            myGrid: 'PM95',
            frequency: 14074000,
            transmitCycles: [1], // 奇数周期发射
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: false,
            autoResumeCQAfterFail: false,
            autoResumeCQAfterSuccess: false,
            replyToWorkedStations: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));

        // JA0EPV（新的呼叫者）- 手动控制发射
        const ja0epv = new RadioOperator({
            id: 'JA0EPV',
            mode: MODES.FT8,
            myCallsign: 'JA0EPV',
            myGrid: 'PM84',
            frequency: 14074000,
            transmitCycles: [1], // 奇数周期发射
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: false,
            autoResumeCQAfterFail: false,
            autoResumeCQAfterSuccess: false,
            replyToWorkedStations: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));

        // 设置JQ2LVH呼叫我
        jq2lvh.userCommand({ command: 'update_context', args: { targetCallsign: 'BG5DRB' } });
        jq2lvh.userCommand({ command: 'set_state', args: 'TX1' });

        // 启动我和JQ2LVH
        me.start();
        jq2lvh.start();

        // 周期1: JQ2LVH呼叫我
        await dummyRadioEngine.nextCycle();
        // 周期2: 我回复JQ2LVH信号报告
        await dummyRadioEngine.nextCycle();
        // 周期3: JQ2LVH发送R-XX
        await dummyRadioEngine.nextCycle();
        // 周期4: 我发送RR73
        await dummyRadioEngine.nextCycle();

        // 此时我处于TX4状态，等待JQ2LVH的73

        // 周期5: 关键时刻 - JQ2LVH发送73，同时JA0EPV直接呼叫我
        // 启动JA0EPV并让它呼叫我
        ja0epv.userCommand({ command: 'update_context', args: { targetCallsign: 'BG5DRB' } });
        ja0epv.userCommand({ command: 'set_state', args: 'TX1' });
        ja0epv.start();

        await dummyRadioEngine.nextCycle();

        // 周期6: 我应该回复JA0EPV，而不是发送CQ
        await dummyRadioEngine.nextCycle();

        console.log('📋 消息历史:');
        dummyRadioEngine.messagesLog.forEach((msg, i) => {
            console.log(`  [${i}] ${msg}`);
        });

        // 验证最后一条消息应该是回复JA0EPV
        const lastMessage = dummyRadioEngine.messagesLog[dummyRadioEngine.messagesLog.length - 1];
        assert.ok(lastMessage.includes('JA0EPV') && lastMessage.includes('BG5DRB'),
            `预期回复JA0EPV，但实际发送: ${lastMessage}`);
        assert.ok(!lastMessage.startsWith('CQ'),
            `不应该发送CQ，但实际发送: ${lastMessage}`);

        console.log('✅ TX4优先级测试通过');
    });

    await t.test('TX5发送73后的下一个周期收到新直接呼叫，应优先回复直接呼叫', async () => {
        console.log('⌛️ TX5发送73后的下一个周期收到新直接呼叫');
        const dummyRadioEngine = new DummyRadioEngine();

        // 我（BG5DRB）
        const me = new RadioOperator({
            id: 'BG5DRB',
            mode: MODES.FT8,
            myCallsign: 'BG5DRB',
            myGrid: 'PL09',
            frequency: 14074000,
            transmitCycles: [1], // 奇数周期发射
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: true,
            autoResumeCQAfterFail: true,
            autoResumeCQAfterSuccess: true,
            replyToWorkedStations: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));

        // E6AD（正在通联的对象）
        const e6ad = new RadioOperator({
            id: 'E6AD',
            mode: MODES.FT8,
            myCallsign: 'E6AD',
            myGrid: 'RG58',
            frequency: 14074000,
            transmitCycles: [0], // 偶数周期发射
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: false,
            autoResumeCQAfterFail: false,
            autoResumeCQAfterSuccess: false,
            replyToWorkedStations: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));

        // BD8CBQ（新的呼叫者，在我发送73的下一个周期才开始呼叫）
        const bd8cbq = new RadioOperator({
            id: 'BD8CBQ',
            mode: MODES.FT8,
            myCallsign: 'BD8CBQ',
            myGrid: 'OM20',
            frequency: 14074000,
            transmitCycles: [0], // 偶数周期发射
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: false,
            autoResumeCQAfterFail: false,
            autoResumeCQAfterSuccess: false,
            replyToWorkedStations: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));

        // E6AD呼叫我
        e6ad.userCommand({ command: 'update_context', args: { targetCallsign: 'BG5DRB' } });
        e6ad.userCommand({ command: 'set_state', args: 'TX1' });

        me.start();
        e6ad.start();

        // 完成与E6AD的QSO
        await dummyRadioEngine.nextCycle(); // E6AD呼叫我
        await dummyRadioEngine.nextCycle(); // 我回复
        await dummyRadioEngine.nextCycle(); // E6AD发送R-XX
        await dummyRadioEngine.nextCycle(); // 我发送RR73（TX4）
        await dummyRadioEngine.nextCycle(); // E6AD发送RRR，我转到TX5
        await dummyRadioEngine.nextCycle(); // 我发送73（TX5状态）

        // 现在我刚发送完73，处于TX5→TX6转换阶段
        // 下一个周期BD8CBQ开始呼叫我

        bd8cbq.userCommand({ command: 'update_context', args: { targetCallsign: 'BG5DRB' } });
        bd8cbq.userCommand({ command: 'set_state', args: 'TX1' });
        bd8cbq.start();

        await dummyRadioEngine.nextCycle(); // BD8CBQ呼叫我
        await dummyRadioEngine.nextCycle(); // 我应该回复BD8CBQ

        console.log('📋 消息历史:');
        dummyRadioEngine.messagesLog.forEach((msg, i) => {
            console.log(`  [${i}] ${msg}`);
        });

        // 验证我回复了BD8CBQ
        const myMessages = dummyRadioEngine.messagesLog.filter(msg =>
            msg.includes('BG5DRB') && msg.includes('BD8CBQ')
        );
        assert.ok(myMessages.length > 0,
            `预期回复BD8CBQ，但没有找到相关消息`);

        console.log('✅ TX5→TX6优先级测试通过');
    });

    await t.test('手动双击RR73后，应先发送73而不是立即回到CQ', async () => {
        console.log('⌛️ 手动双击RR73后优先发送73');
        const dummyRadioEngine = new DummyRadioEngine();

        const me = new RadioOperator({
            id: 'BG5DRB',
            mode: MODES.FT8,
            myCallsign: 'BG5DRB',
            myGrid: 'PL09',
            frequency: 14074000,
            transmitCycles: [1],
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: true,
            autoResumeCQAfterFail: true,
            autoResumeCQAfterSuccess: true,
            replyToWorkedStations: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));

        const clickedMessage = {
            message: {
                message: 'BG5DRB BG8TFN RR73',
                snr: -18,
                dt: -0.2,
                freq: 1553,
                confidence: 0.9
            },
            slotInfo: createSlotInfo('clicked-slot', dummyRadioEngine.startTime)
        };

        me.requestCall('BG8TFN', clickedMessage as any);

        const slotInfo = createSlotInfo('slot1', dummyRadioEngine.startTime + 15000);
        const emptyLastSlotPack = createSlotPack('slot0', dummyRadioEngine.startTime, []);
        const promises: Promise<void>[] = [];
        dummyRadioEngine.sharedEventEmitter.listeners('slotStart').forEach((listener: any) => {
            const result = listener(slotInfo, emptyLastSlotPack);
            if (result instanceof Promise) {
                promises.push(result);
            }
        });
        await Promise.all(promises);
        dummyRadioEngine.sharedEventEmitter.emit('encodeStart' as any, slotInfo);

        const queuedMessages = dummyRadioEngine.messagesPool.map(request => request.transmission);
        assert.deepStrictEqual(queuedMessages, ['BG8TFN BG5DRB 73']);

        console.log('✅ 手动RR73优先发送73测试通过');
    });

    await t.test('TX5退出到CQ后收到晚到RR73，应恢复为73重发', async () => {
        console.log('⌛️ TX5退出到CQ后收到晚到RR73');
        const dummyRadioEngine = new DummyRadioEngine();

        const me = new RadioOperator({
            id: 'BG8TFN',
            mode: MODES.FT8,
            myCallsign: 'BG8TFN',
            myGrid: 'PL09',
            frequency: 14074000,
            transmitCycles: [1],
            maxQSOTimeoutCycles: 10,
            maxCallAttempts: 10,
            autoReplyToCQ: true,
            autoResumeCQAfterFail: true,
            autoResumeCQAfterSuccess: true,
            replyToWorkedStations: true
        }, dummyRadioEngine.sharedEventEmitter, (operator) => new StandardQSOStrategy(operator));

        me.start();
        me.userCommand({
            command: 'update_context',
            args: {
                targetCallsign: 'BG5DRB',
                reportSent: -19
            }
        } as any);
        me.userCommand({ command: 'set_state', args: 'TX5' } as any);

        await dummyRadioEngine.nextCycle();
        await dummyRadioEngine.nextCycle();

        assert.strictEqual(me.transmissionStrategy?.handleTransmitSlot(), 'CQ BG8TFN PL09');

        const lateRR73Pack = createSlotPack('late-slot', dummyRadioEngine.startTime + 15000, [
            'BG8TFN BG5DRB RR73'
        ]);

        const changed = await me.reDecideWithUpdatedSlotPack(lateRR73Pack);
        assert.strictEqual(changed, true);
        assert.strictEqual(me.transmissionStrategy?.handleTransmitSlot(), 'BG5DRB BG8TFN 73');

        console.log('✅ 晚到RR73恢复73测试通过');
    });

});
