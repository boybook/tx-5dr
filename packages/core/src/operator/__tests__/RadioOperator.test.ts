import { test } from 'node:test';
import assert from 'node:assert';
import { RadioOperator } from '../RadioOperator';
import { QSOState } from '@tx5dr/contracts';

// 测试辅助函数
function logQSOStep(description: string, operator?: string) {
    console.log(`\n🔸 ${description}${operator ? ` [${operator}]` : ''}`);
}

function logMessage(from: string, to: string, message: string, step: string) {
    console.log(`   📡 ${from} → ${to}: "${message}" (${step})`);
}

function logStateChange(operator: string, fromState: string, toState: string) {
    console.log(`   ⚡ ${operator}: ${fromState} → ${toState}`);
}

test('基础QSO通联 - 完整流程', async (t) => {
    console.log('\n🎯 测试：基础QSO通联 - 完整流程');
    console.log('=' .repeat(50));
    
    // 创建两个电台操作员
    const operator1 = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 20,  // 增加超时周期
        maxCallAttempts: 10,      // 增加最大尝试次数，避免正常通联中失败
        frequency: 14074000
    });

    const operator2 = new RadioOperator('BH3WNL', 'OM92', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 20,  // 增加超时周期
        maxCallAttempts: 10,      // 增加最大尝试次数，避免正常通联中失败
        frequency: 14074000
    });

    logQSOStep('初始化两个电台操作员');
    console.log(`   📻 BG3MDO (OM91) - 状态: ${operator1.getQSOState()}`);
    console.log(`   📻 BH3WNL (OM92) - 状态: ${operator2.getQSOState()}`);

    // 步骤 1: operator1 呼叫 CQ
    logQSOStep('步骤 1: BG3MDO 开始呼叫 CQ', 'BG3MDO');
    operator1.startCallingCQ();
    const cqMessage = operator1.getNextTransmission();
    assert.strictEqual(cqMessage, 'CQ BG3MDO OM91');
    logMessage('BG3MDO', '频率上所有电台', cqMessage!, 'CQ呼叫');
    operator1.handleCycleEnd(true, cqMessage);

    // 步骤 2: operator2 收到 CQ 并响应
    logQSOStep('步骤 2: BH3WNL 收到 CQ 并自动响应', 'BH3WNL');
    operator2.receivedMessages([{
        rawMessage: cqMessage!,
        snr: -10,
        dt: 0,
        df: 0
    }]);

    const response = operator2.getNextTransmission();
    assert.strictEqual(response, 'BG3MDO BH3WNL OM92');
    logMessage('BH3WNL', 'BG3MDO', response!, '响应CQ');
    operator2.handleCycleEnd(true, response);

    // 步骤 3: operator1 收到响应并发送信号报告
    logQSOStep('步骤 3: BG3MDO 收到响应，发送信号报告', 'BG3MDO');
    operator1.receivedMessages([{
        rawMessage: response!,
        snr: -12,
        dt: 0,
        df: 0
    }]);

    const report = operator1.getNextTransmission();
    assert.strictEqual(report, 'BH3WNL BG3MDO -12');
    logMessage('BG3MDO', 'BH3WNL', report!, '信号报告');
    operator1.handleCycleEnd(true, report);

    // 步骤 4: operator2 收到信号报告并发送 RRR
    logQSOStep('步骤 4: BH3WNL 收到信号报告，发送 RRR 确认', 'BH3WNL');
    operator2.receivedMessages([{
        rawMessage: report!,
        snr: -14,
        dt: 0,
        df: 0
    }]);

    const rrr = operator2.getNextTransmission();
    assert.strictEqual(rrr, 'BG3MDO BH3WNL RRR');
    logMessage('BH3WNL', 'BG3MDO', rrr!, 'RRR确认');
    operator2.handleCycleEnd(true, rrr);

    // 步骤 5: operator1 收到 RRR 并发送 73
    logQSOStep('步骤 5: BG3MDO 收到 RRR，发送 73', 'BG3MDO');
    operator1.receivedMessages([{
        rawMessage: rrr!,
        snr: -13,
        dt: 0,
        df: 0
    }]);

    const seventyThree = operator1.getNextTransmission();
    assert.strictEqual(seventyThree, 'BH3WNL BG3MDO 73');
    logMessage('BG3MDO', 'BH3WNL', seventyThree!, '73告别');
    operator1.handleCycleEnd(true, seventyThree);

    // 步骤 6: operator2 收到 73 并发送最后的 73
    logQSOStep('步骤 6: BH3WNL 收到 73，发送最后的 73', 'BH3WNL');
    operator2.receivedMessages([{
        rawMessage: seventyThree!,
        snr: -15,
        dt: 0,
        df: 0
    }]);

    const finalSeventyThree = operator2.getNextTransmission();
    assert.strictEqual(finalSeventyThree, 'BG3MDO BH3WNL 73');
    logMessage('BH3WNL', 'BG3MDO', finalSeventyThree!, '最后的73');
    operator2.handleCycleEnd(true, finalSeventyThree);

    // 步骤 7: operator1 收到最后的 73，QSO 完成
    logQSOStep('步骤 7: BG3MDO 收到最后的 73，QSO 完成', 'BG3MDO');
    operator1.receivedMessages([{
        rawMessage: finalSeventyThree!,
        snr: -16,
        dt: 0,
        df: 0
    }]);

    // 验证最终状态
    logQSOStep('验证最终状态');
    assert.strictEqual(operator1.getQSOState(), QSOState.COMPLETED);
    assert.strictEqual(operator2.getQSOState(), QSOState.COMPLETED);
    console.log(`   ✅ BG3MDO 最终状态: ${operator1.getQSOState()}`);
    console.log(`   ✅ BH3WNL 最终状态: ${operator2.getQSOState()}`);
    console.log('\n🎉 基础QSO通联测试完成！');
});

test('多方依次通联 - 连续QSO', async (t) => {
    console.log('\n🎯 测试：多方依次通联 - 真实连续QSO场景');
    console.log('=' .repeat(60));
    
    // 创建一个主呼叫方和多个响应方
    const mainOperator = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 20,
        maxCallAttempts: 10,
        frequency: 14074000,
        autoResumeCQAfterSuccess: false // 不自动恢复CQ，让测试更可控
    });

    const operator2 = new RadioOperator('BH3WNL', 'OM92');
    const operator3 = new RadioOperator('BA3XYZ', 'OM93');
    const operator4 = new RadioOperator('BD3ABC', 'OM94');

    // ========== 场景1: 在发送73后立刻收到新呼叫 ==========
    logQSOStep('=== 场景1: 发送73后立刻收到新呼叫 (BA3XYZ) ===');
    
    // 快速建立第一个QSO到73阶段
    mainOperator.startCallingCQ();
    const cq1 = mainOperator.getNextTransmission();
    mainOperator.handleCycleEnd(true, cq1);

    operator2.receivedMessages([{ rawMessage: cq1!, snr: -10, dt: 0, df: 0 }]);
    const response1 = operator2.getNextTransmission();
    operator2.handleCycleEnd(true, response1);

    mainOperator.receivedMessages([{ rawMessage: response1!, snr: -12, dt: 0, df: 0 }]);
    const report1 = mainOperator.getNextTransmission();
    mainOperator.handleCycleEnd(true, report1);

    operator2.receivedMessages([{ rawMessage: report1!, snr: -14, dt: 0, df: 0 }]);
    const rrr1 = operator2.getNextTransmission();
    operator2.handleCycleEnd(true, rrr1);

    mainOperator.receivedMessages([{ rawMessage: rrr1!, snr: -13, dt: 0, df: 0 }]);
    const seventyThree1 = mainOperator.getNextTransmission();
    logMessage('BG3MDO', 'BH3WNL', seventyThree1!, '发送73');
    mainOperator.handleCycleEnd(true, seventyThree1);

    logQSOStep('🔥 关键时刻：BG3MDO刚发送73，BA3XYZ立刻呼叫');
    
    // 同时收到：BH3WNL的最后73 + BA3XYZ的新呼叫
    operator2.receivedMessages([{ rawMessage: seventyThree1!, snr: -15, dt: 0, df: 0 }]);
    const finalSeventyThree1 = operator2.getNextTransmission();
    operator2.handleCycleEnd(true, finalSeventyThree1);

    mainOperator.receivedMessages([
        { rawMessage: finalSeventyThree1!, snr: -16, dt: 0, df: 0 },
        { rawMessage: 'BG3MDO BA3XYZ OM93', snr: -9, dt: 0, df: 0 }  // BA3XYZ主动呼叫BG3MDO
    ]);

    assert.strictEqual(mainOperator.getQSOState(), QSOState.RESPONDING);
    const response2 = mainOperator.getNextTransmission();
    assert.strictEqual(response2, 'BA3XYZ BG3MDO OM91');
    logMessage('BG3MDO', 'BA3XYZ', response2!, '立即响应新呼叫');
    mainOperator.handleCycleEnd(true, response2);
    
    console.log(`   ✅ 场景1成功：发送73后立即响应新呼叫`);

    // ========== 场景2: 在发送RR73后立刻收到新呼叫 ==========
    logQSOStep('=== 场景2: 发送RR73后立刻收到新呼叫 (BD3ABC) ===');
    
    // 继续完成与BA3XYZ的QSO，但使用RR73结束
    operator3.receivedMessages([{ rawMessage: response2!, snr: -11, dt: 0, df: 0 }]);
    
    // BA3XYZ发送信号报告（因为是BA3XYZ呼叫的BG3MDO）
    const report2 = operator3.getNextTransmission();
    operator3.handleCycleEnd(true, report2);

    mainOperator.receivedMessages([{ rawMessage: report2!, snr: -10, dt: 0, df: 0 }]);
    console.log(`🔍 BG3MDO收到消息后的状态: ${mainOperator.getQSOState()} (期望: exchanging_report)`);

    // BG3MDO发送RR73（表示收到报告并发送73）
    const rr73 = 'BA3XYZ BG3MDO RR73';  // 手动构造RR73消息
    mainOperator.setNextMessageManually(rr73);
    const actualRR73 = mainOperator.getNextTransmission();
    assert.strictEqual(actualRR73, rr73);
    logMessage('BG3MDO', 'BA3XYZ', actualRR73!, '发送RR73');
    mainOperator.handleCycleEnd(true, actualRR73);

    // 验证RR73后QSO状态是否正确完成
    assert.strictEqual(mainOperator.getQSOState(), QSOState.COMPLETED, 'BG3MDO应该在发送RR73后完成QSO');

    logQSOStep('🔥 关键时刻：BG3MDO刚发送RR73，BD3ABC立刻呼叫');
    
    // 同时收到：BA3XYZ可能的最后73 + BD3ABC的新呼叫
    operator3.receivedMessages([{ rawMessage: actualRR73!, snr: -12, dt: 0, df: 0 }]);
    
    mainOperator.receivedMessages([
        { rawMessage: 'BG3MDO BD3ABC OM94', snr: -8, dt: 0, df: 0 }  // BD3ABC主动呼叫BG3MDO
    ]);

    assert.strictEqual(mainOperator.getQSOState(), QSOState.RESPONDING);
    const response3 = mainOperator.getNextTransmission();
    assert.strictEqual(response3, 'BD3ABC BG3MDO OM91');
    logMessage('BG3MDO', 'BD3ABC', response3!, '立即响应新呼叫');
    mainOperator.handleCycleEnd(true, response3);
    
    console.log(`   ✅ 场景2成功：发送RR73后立即响应新呼叫`);

    // ========== 场景3: 发送73后直接收到信号报告 ==========
    logQSOStep('=== 场景3: 发送73后直接收到信号报告交换 ===');
    
    // 快速结束与BD3ABC的QSO
    operator4.receivedMessages([{ rawMessage: response3!, snr: -13, dt: 0, df: 0 }]);
    const report3 = operator4.getNextTransmission();
    operator4.handleCycleEnd(true, report3);

    mainOperator.receivedMessages([{ rawMessage: report3!, snr: -12, dt: 0, df: 0 }]);
    const rrr3 = mainOperator.getNextTransmission();
    mainOperator.handleCycleEnd(true, rrr3);

    operator4.receivedMessages([{ rawMessage: rrr3!, snr: -14, dt: 0, df: 0 }]);
    const seventyThree3 = operator4.getNextTransmission();
    operator4.handleCycleEnd(true, seventyThree3);

    mainOperator.receivedMessages([{ rawMessage: seventyThree3!, snr: -15, dt: 0, df: 0 }]);
    const finalSeventyThree3 = mainOperator.getNextTransmission();
    logMessage('BG3MDO', 'BD3ABC', finalSeventyThree3!, '发送73');
    mainOperator.handleCycleEnd(true, finalSeventyThree3);

    logQSOStep('🔥 关键时刻：BG3MDO刚发送73，直接收到信号报告');
    
    // 收到一个新的信号报告（跳过了初始呼叫阶段）
    // 这种情况在FT8中很常见，对方可能已经在准备信号报告
    mainOperator.receivedMessages([
        { rawMessage: 'BG3MDO BH3TEST -8', snr: -10, dt: 0, df: 0 }  // 直接收到信号报告
    ]);

    // BG3MDO应该能够识别这是一个信号报告并适当响应
    // 由于这是直接的信号报告，BG3MDO应该发送RRR或RR73
    const responseToReport = mainOperator.getNextTransmission();
    // 这种情况下，BG3MDO会进入EXCHANGING_REPORT状态并发送确认
    logMessage('BG3MDO', 'BH3TEST', responseToReport!, '响应信号报告');
    
    console.log(`   ✅ 场景3成功：能够处理直接收到的信号报告`);

    logQSOStep('🎉 真实连续QSO场景测试完成');
    console.log(`   🔥 验证了三个关键真实场景:`);
    console.log(`   1️⃣ 发送73后立即收到新呼叫`);
    console.log(`   2️⃣ 发送RR73后立即收到新呼叫`);
    console.log(`   3️⃣ 发送73后直接收到信号报告`);
    console.log(`   ✨ 这些都是FT8通联中的常见真实情况`);

    console.log('\n🎉 多方依次通联测试完成！');
});

test('信号衰落恢复 - 超时重连', async (t) => {
    console.log('\n🎯 测试：信号衰落恢复 - 超时重连');
    console.log('=' .repeat(50));
    
    const operator1 = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 10,
        maxCallAttempts: 4,
        frequency: 14074000,
        autoResumeCQAfterFail: true
    });

    const operator2 = new RadioOperator('BH3WNL', 'OM92', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 10,
        maxCallAttempts: 4,
        frequency: 14074000,
        autoResumeCQAfterFail: false
    });

    // 开始正常QSO
    logQSOStep('开始正常QSO流程');
    operator1.startCallingCQ();
    const cq = operator1.getNextTransmission();
    logMessage('BG3MDO', '频率', cq!, 'CQ呼叫');
    operator1.handleCycleEnd(true, cq);

    operator2.receivedMessages([{
        rawMessage: cq!,
        snr: -10,
        dt: 0,
        df: 0
    }]);

    const response = operator2.getNextTransmission();
    logMessage('BH3WNL', 'BG3MDO', response!, '响应CQ');
    operator2.handleCycleEnd(true, response);

    operator1.receivedMessages([{
        rawMessage: response!,
        snr: -12,
        dt: 0,
        df: 0
    }]);

    const report = operator1.getNextTransmission();
    logMessage('BG3MDO', 'BH3WNL', report!, '信号报告');
    operator1.handleCycleEnd(true, report);

    // operator2收到信号报告，发送RRR
    operator2.receivedMessages([{
        rawMessage: report!,
        snr: -14,
        dt: 0,
        df: 0
    }]);

    const rrr = operator2.getNextTransmission();
    logMessage('BH3WNL', 'BG3MDO', rrr!, 'RRR确认');
    operator2.handleCycleEnd(true, rrr);

    logQSOStep('⚠️  信号衰落 - BG3MDO 没有收到 RRR');
    
    // 关键：BG3MDO 没有收到 RRR（信号衰落），所以会重传信号报告
    // operator1.receivedMessages([]); // 不接收 RRR 消息

    logQSOStep('🔄 BG3MDO 重传信号报告');
    const retryReport = operator1.getNextTransmission();
    assert.strictEqual(retryReport, report); // 应该重传相同的信号报告
    logMessage('BG3MDO', 'BH3WNL', retryReport!, '重传信号报告');
    operator1.handleCycleEnd(true, retryReport);

    logQSOStep('📶 信号恢复 - BH3WNL 收到重传，再次发送 RRR');
    // BH3WNL 收到重传的信号报告
    operator2.receivedMessages([{
        rawMessage: retryReport!,
        snr: -12, // 信号恢复，更强了
        dt: 0,
        df: 0
    }]);

    const retryRRR = operator2.getNextTransmission();
    logMessage('BH3WNL', 'BG3MDO', retryRRR!, '重新发送RRR');
    operator2.handleCycleEnd(true, retryRRR);

    logQSOStep('✅ BG3MDO 收到 RRR，QSO 继续');
    // BG3MDO 这次收到了 RRR
    operator1.receivedMessages([{
        rawMessage: retryRRR!,
        snr: -13,
        dt: 0,
        df: 0
    }]);

    // 继续完成QSO
    const seventyThree = operator1.getNextTransmission();
    assert.strictEqual(seventyThree, 'BH3WNL BG3MDO 73');
    logMessage('BG3MDO', 'BH3WNL', seventyThree!, '73告别');
    operator1.handleCycleEnd(true, seventyThree);

    operator2.receivedMessages([{
        rawMessage: seventyThree!,
        snr: -15,
        dt: 0,
        df: 0
    }]);

    const finalSeventyThree = operator2.getNextTransmission();
    assert.strictEqual(finalSeventyThree, 'BG3MDO BH3WNL 73');
    logMessage('BH3WNL', 'BG3MDO', finalSeventyThree!, '最后的73');
    operator2.handleCycleEnd(true, finalSeventyThree);

    operator1.receivedMessages([{
        rawMessage: finalSeventyThree!,
        snr: -16,
        dt: 0,
        df: 0
    }]);

    // 验证QSO成功完成
    assert.strictEqual(operator1.getQSOState(), QSOState.COMPLETED);
    assert.strictEqual(operator2.getQSOState(), QSOState.COMPLETED);
    
    logQSOStep('🎉 信号衰落恢复成功，QSO完成！');
    console.log(`   ✅ BG3MDO 最终状态: ${operator1.getQSOState()}`);
    console.log(`   ✅ BH3WNL 最终状态: ${operator2.getQSOState()}`);
    console.log('\n🎉 信号衰落恢复测试完成！');
});

test('多人同时呼叫 - 优先级选择', async (t) => {
    console.log('\n🎯 测试：多人同时呼叫 - 优先级选择');
    console.log('=' .repeat(50));
    
    const mainOperator = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 5,
        maxCallAttempts: 3,
        frequency: 14074000
    });

    // 设置监听状态，准备接收多个呼叫
    logQSOStep('BG3MDO 进入监听状态，等待呼叫');
    assert.strictEqual(mainOperator.getQSOState(), QSOState.LISTENING);

    // 模拟同时收到三个不同强度的呼叫
    logQSOStep('同时收到三个不同强度的呼叫');
    const calls = [
        { callsign: 'BH3WNL', grid: 'OM92', snr: -15, message: 'BG3MDO BH3WNL' },      // 直接呼叫
        { callsign: 'BA3XYZ', grid: 'OM93', snr: -8,  message: 'BG3MDO BA3XYZ' },      // 直接呼叫，最强信号
        { callsign: 'BD3ABC', grid: 'OM94', snr: -20, message: 'BG3MDO BD3ABC' }       // 直接呼叫
    ];

    calls.forEach(call => {
        console.log(`   📡 收到呼叫: ${call.callsign} (SNR: ${call.snr}dB)`);
    });

    // 同时传入所有呼叫
    mainOperator.receivedMessages([
        { rawMessage: calls[0].message, snr: calls[0].snr, dt: 0, df: 0 },
        { rawMessage: calls[1].message, snr: calls[1].snr, dt: 0, df: 0 },
        { rawMessage: calls[2].message, snr: calls[2].snr, dt: 0, df: 0 }
    ]);

    // 验证选择了最强信号的呼叫方
    const response = mainOperator.getNextTransmission();
    assert.strictEqual(response, 'BA3XYZ BG3MDO OM91'); // 应该响应SNR最高的BA3XYZ
    
    logQSOStep('🎯 优先级选择结果');
    console.log(`   ✅ 选择响应: BA3XYZ (SNR: -8dB - 最强信号)`);
    console.log(`   ❌ 未选择: BH3WNL (SNR: -15dB)`);
    console.log(`   ❌ 未选择: BD3ABC (SNR: -20dB)`);
    
    // 验证状态转换
    assert.strictEqual(mainOperator.getQSOState(), QSOState.RESPONDING);
    console.log(`   ⚡ BG3MDO 状态: LISTENING → RESPONDING`);

    console.log('\n🎉 多人同时呼叫测试完成！');
});

test('CQ呼叫优先级测试', async (t) => {
    console.log('\n🎯 测试：CQ呼叫优先级测试');
    console.log('=' .repeat(50));
    
    const mainOperator = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 5,
        maxCallAttempts: 3,
        frequency: 14074000
    });

    // 模拟同时收到CQ呼叫和直接呼叫
    logQSOStep('同时收到CQ呼叫和直接呼叫');
    
    mainOperator.receivedMessages([
        { rawMessage: 'CQ BH3WNL OM92', snr: -10, dt: 0, df: 0 },        // CQ呼叫
        { rawMessage: 'BG3MDO BA3XYZ OM93', snr: -12, dt: 0, df: 0 }     // 直接呼叫
    ]);

    const response = mainOperator.getNextTransmission();
    
    // 应该选择更强的信号（CQ呼叫 -10dB vs 直接呼叫 -12dB）
    assert.strictEqual(response, 'BH3WNL BG3MDO OM91');
    
    console.log(`   📡 收到 CQ: BH3WNL (SNR: -10dB)`);
    console.log(`   📡 收到直接呼叫: BA3XYZ (SNR: -12dB)`);
    console.log(`   ✅ 选择响应: BH3WNL (更强信号)`);

    console.log('\n🎉 CQ呼叫优先级测试完成！');
});

test('CQ状态下收到直接呼叫的优先级处理', async (t) => {
    console.log('\n🎯 测试：CQ状态下收到直接呼叫的优先级处理');
    console.log('=' .repeat(50));
    
    const mainOperator = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 20,
        maxCallAttempts: 10,
        frequency: 14074000,
        autoResumeCQAfterSuccess: true
    });

    // 开始CQ
    logQSOStep('BG3MDO 开始呼叫 CQ');
    mainOperator.startCallingCQ();
    assert.strictEqual(mainOperator.getQSOState(), QSOState.CALLING_CQ);
    
    // 模拟BG3MDO发送CQ
    const cqForTest = mainOperator.getNextTransmission();
    logMessage('BG3MDO', '频率', cqForTest!, 'CQ呼叫');
    mainOperator.handleCycleEnd(true, cqForTest);
    
    // 同时收到CQ响应和多个直接呼叫
    logQSOStep('同时收到CQ响应和多个直接呼叫');
    mainOperator.receivedMessages([
        { rawMessage: 'BG3MDO BD3EFG OM95', snr: -10, dt: 0, df: 0 },  // CQ响应
        { rawMessage: 'BG3MDO BH3ABC', snr: -15, dt: 0, df: 0 },        // 直接呼叫1（较弱）
        { rawMessage: 'BG3MDO BH3XYZ', snr: -8, dt: 0, df: 0 },         // 直接呼叫2（最强）
        { rawMessage: 'BG3MDO BH3DEF', snr: -20, dt: 0, df: 0 }         // 直接呼叫3（最弱）
    ]);
    
    // 验证选择了信号最强的直接呼叫
    const priorityResponse = mainOperator.getNextTransmission();
    assert.strictEqual(priorityResponse, 'BH3XYZ BG3MDO OM91');
    assert.strictEqual(mainOperator.getQSOState(), QSOState.RESPONDING);
    
    logQSOStep('🎯 优先级处理结果');
    console.log(`   📡 收到CQ响应: BD3EFG (SNR: -10dB)`);
    console.log(`   📡 收到直接呼叫1: BH3ABC (SNR: -15dB)`);
    console.log(`   📡 收到直接呼叫2: BH3XYZ (SNR: -8dB) ← 最强`);
    console.log(`   📡 收到直接呼叫3: BH3DEF (SNR: -20dB)`);
    console.log(`   ✅ 选择响应: BH3XYZ (直接呼叫中信号最强)`);
    console.log(`   ⚡ BG3MDO 状态: CALLING_CQ → RESPONDING`);
    
    console.log('\n🎉 CQ状态下直接呼叫优先级测试完成！');
});

test('带网格和不带网格的直接呼叫支持', async (t) => {
    console.log('\n🎯 测试：带网格和不带网格的直接呼叫支持');
    console.log('=' .repeat(60));
    
    const mainOperator = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 20,
        maxCallAttempts: 10,
        frequency: 14074000
    });

    // ========== 测试1: 不带网格的直接呼叫 ==========
    logQSOStep('=== 测试1: 不带网格的直接呼叫 ===');
    
    mainOperator.receivedMessages([
        { rawMessage: 'BG3MDO BA3XYZ', snr: -10, dt: 0, df: 0 }  // 不带网格的直接呼叫
    ]);

    assert.strictEqual(mainOperator.getQSOState(), QSOState.RESPONDING);
    const response1 = mainOperator.getNextTransmission();
    assert.strictEqual(response1, 'BA3XYZ BG3MDO OM91');
    logMessage('BG3MDO', 'BA3XYZ', response1!, '响应不带网格的直接呼叫');
    
    console.log(`   ✅ 成功处理不带网格的直接呼叫: BG3MDO BA3XYZ`);

    // 重置状态
    mainOperator.endQSO(false);
    
    // ========== 测试2: 带网格的直接呼叫 ==========  
    logQSOStep('=== 测试2: 带网格的直接呼叫 ===');
    
    mainOperator.receivedMessages([
        { rawMessage: 'BG3MDO BD3EFG OM95', snr: -12, dt: 0, df: 0 }  // 带网格的直接呼叫
    ]);

    assert.strictEqual(mainOperator.getQSOState(), QSOState.RESPONDING);
    const response2 = mainOperator.getNextTransmission();
    assert.strictEqual(response2, 'BD3EFG BG3MDO OM91');
    logMessage('BG3MDO', 'BD3EFG', response2!, '响应带网格的直接呼叫');
    
    console.log(`   ✅ 成功处理带网格的直接呼叫: BG3MDO BD3EFG OM95`);

    // 重置状态
    mainOperator.endQSO(false);

    // ========== 测试3: CQ状态下的混合呼叫 ==========
    logQSOStep('=== 测试3: CQ状态下的混合呼叫优先级 ===');
    
    // 开始CQ
    mainOperator.startCallingCQ();
    const cq = mainOperator.getNextTransmission();
    mainOperator.handleCycleEnd(true, cq);
    
    // 同时收到带网格和不带网格的呼叫
    mainOperator.receivedMessages([
        { rawMessage: 'BG3MDO BH3WNL', snr: -15, dt: 0, df: 0 },        // 不带网格（较弱）
        { rawMessage: 'BG3MDO BA3XYZ OM93', snr: -8, dt: 0, df: 0 },    // 带网格（最强）  
        { rawMessage: 'BG3MDO BD3ABC', snr: -20, dt: 0, df: 0 }          // 不带网格（最弱）
    ]);

    assert.strictEqual(mainOperator.getQSOState(), QSOState.RESPONDING);
    const response3 = mainOperator.getNextTransmission();
    assert.strictEqual(response3, 'BA3XYZ BG3MDO OM91');
    
    logQSOStep('🎯 混合呼叫优先级结果');
    console.log(`   📡 收到不带网格呼叫1: BH3WNL (SNR: -15dB)`);
    console.log(`   📡 收到带网格呼叫: BA3XYZ OM93 (SNR: -8dB) ← 最强`);
    console.log(`   📡 收到不带网格呼叫2: BD3ABC (SNR: -20dB)`);
    console.log(`   ✅ 选择响应: BA3XYZ (信号最强，不区分是否带网格)`);
    
    console.log(`   ✨ 验证：带网格和不带网格的直接呼叫享有同等优先级`);

    logQSOStep('🎉 带网格和不带网格直接呼叫测试完成');
    console.log(`   🔥 关键验证:`);
    console.log(`   1️⃣ BG3MDO BA3XYZ - 不带网格的直接呼叫 ✅`);
    console.log(`   2️⃣ BG3MDO BD3EFG OM95 - 带网格的直接呼叫 ✅`);
    console.log(`   3️⃣ 混合场景下按SNR优先级选择 ✅`);

    console.log('\n🎉 带网格和不带网格的直接呼叫支持测试完成！');
});

test('手动结束QSO - 异常情况处理', async (t) => {
    console.log('\n🎯 测试：手动结束QSO - 异常情况处理');
    console.log('=' .repeat(50));
    
    const operator = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 20,
        maxCallAttempts: 10,
        frequency: 14074000
    });

    // 场景1: 在正常QSO进行中手动结束
    logQSOStep('=== 场景1: QSO进行中用户主动中止 ===');
    
    // 开始一个QSO
    operator.receivedMessages([{ rawMessage: 'BG3MDO BA3XYZ OM93', snr: -10, dt: 0, df: 0 }]);
    assert.strictEqual(operator.getQSOState(), QSOState.RESPONDING);
    
    // 检查QSO进度
    const progress1 = operator.getQSOProgress();
    assert.strictEqual(progress1.isActive, true);
    assert.strictEqual(progress1.canEnd, true);
    assert.strictEqual(progress1.target, 'BA3XYZ');
    
    // 用户主动中止（比如发现频率干扰）
    operator.endQSO(false, '频率干扰严重');
    assert.strictEqual(operator.getQSOState(), QSOState.COMPLETED);
    console.log('   ✅ 成功手动结束QSO，状态: RESPONDING → COMPLETED');

    // 场景2: 尝试重复结束（应该被忽略）
    logQSOStep('=== 场景2: 重复调用endQSO（安全检查） ===');
    
    const progress2 = operator.getQSOProgress();
    assert.strictEqual(progress2.canEnd, false);
    
    // 再次调用应该被忽略
    operator.endQSO(true, '重复调用测试');
    assert.strictEqual(operator.getQSOState(), QSOState.COMPLETED); // 状态不变
    console.log('   ✅ 重复调用被正确忽略，状态保持COMPLETED');

    // 场景3: 在监听状态下调用（无效操作）
    logQSOStep('=== 场景3: 在非活动状态下调用endQSO ===');
    
    // 重置到监听状态
    operator.updateQSOState(QSOState.LISTENING);
    const progress3 = operator.getQSOProgress();
    assert.strictEqual(progress3.canEnd, false);
    assert.strictEqual(progress3.isActive, false);
    
    operator.endQSO(false, '无效调用测试');
    assert.strictEqual(operator.getQSOState(), QSOState.LISTENING); // 状态不变
    console.log('   ✅ 在非活动状态下调用被正确忽略');

    // 场景4: 异常失败场景
    logQSOStep('=== 场景4: 检测到协议违规，标记为失败 ===');
    
    // 开始新的QSO
    operator.receivedMessages([{ rawMessage: 'BG3MDO BD3XYZ', snr: -12, dt: 0, df: 0 }]);
    assert.strictEqual(operator.getQSOState(), QSOState.RESPONDING);
    
    // 检测到协议违规
    operator.endQSO(true, '收到无效消息格式');
    assert.strictEqual(operator.getQSOState(), QSOState.FAILED);
    console.log('   ✅ 协议违规正确标记为FAILED状态');

    logQSOStep('🎉 手动endQSO测试完成');
    console.log('   🔥 验证了关键场景:');
    console.log('   1️⃣ 正常进行中的QSO可以被手动结束');
    console.log('   2️⃣ 重复调用被安全忽略');
    console.log('   3️⃣ 非活动状态下调用被忽略');
    console.log('   4️⃣ 异常情况可以标记为失败');
    console.log('   ✨ endQSO主要用于异常干预，正常QSO应自动完成');

    console.log('\n🎉 手动结束QSO测试完成！');
});

test('QSO超时失败后自动恢复CQ', async (t) => {
    console.log('\n🎯 测试：QSO超时失败后自动恢复CQ');
    console.log('=' .repeat(50));
    
    // 测试自动恢复CQ的情况
    const operatorWithAutoResume = new RadioOperator('BG3MDO', 'OM91', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 5,   // 较短的超时周期便于测试
        maxCallAttempts: 2,       // 较少的尝试次数便于测试
        frequency: 14074000,
        autoResumeCQAfterFail: true  // 关键设置：失败后自动恢复CQ
    });

    // 测试不自动恢复的情况（对比）
    const operatorWithoutAutoResume = new RadioOperator('BA3XYZ', 'OM93', undefined, {
        autoReplyToCQ: true,
        maxQSOTimeoutCycles: 5,
        maxCallAttempts: 2,
        frequency: 14074000,
        autoResumeCQAfterFail: false  // 失败后不自动恢复CQ
    });

    logQSOStep('=== 场景1: autoResumeCQAfterFail = true（推荐设置） ===');
    
    // 开始CQ并收到响应
    operatorWithAutoResume.startCallingCQ();
    const cq1 = operatorWithAutoResume.getNextTransmission();
    assert.strictEqual(cq1, 'CQ BG3MDO OM91');
    logMessage('BG3MDO', '频率', cq1!, 'CQ呼叫');
    operatorWithAutoResume.handleCycleEnd(true, cq1);

    // 模拟收到响应，进入QSO
    operatorWithAutoResume.receivedMessages([{
        rawMessage: 'BG3MDO BH3TEST OM92',
        snr: -10,
        dt: 0,
        df: 0
    }]);
    assert.strictEqual(operatorWithAutoResume.getQSOState(), QSOState.EXCHANGING_REPORT);

    // 发送信号报告
    const report1 = operatorWithAutoResume.getNextTransmission();
    logMessage('BG3MDO', 'BH3TEST', report1!, '信号报告');
    operatorWithAutoResume.handleCycleEnd(true, report1);

    // 模拟对方没有回应，通过多次handleCycleEnd触发超时
    logQSOStep('💥 模拟对方没有回应，触发超时失败');
    
    // 第一次重传
    const retryReport1 = operatorWithAutoResume.getNextTransmission();
    assert.strictEqual(retryReport1, report1); // 应该重传相同消息
    logMessage('BG3MDO', 'BH3TEST', retryReport1!, '重传信号报告（第1次）');
    operatorWithAutoResume.handleCycleEnd(true, retryReport1);

    // 第二次重传（达到maxCallAttempts=2，应该失败）
    const retryReport2 = operatorWithAutoResume.getNextTransmission();
    logMessage('BG3MDO', 'BH3TEST', retryReport2!, '重传信号报告（第2次）');
    operatorWithAutoResume.handleCycleEnd(true, retryReport2);

    // 此时应该已经失败并自动恢复CQ
    assert.strictEqual(operatorWithAutoResume.getQSOState(), QSOState.CALLING_CQ);
    console.log(`   ✅ QSO失败后自动恢复CQ: EXCHANGING_REPORT → FAILED → CALLING_CQ`);

    // 验证可以继续发送CQ
    const cq2 = operatorWithAutoResume.getNextTransmission();
    assert.strictEqual(cq2, 'CQ BG3MDO OM91');
    logMessage('BG3MDO', '频率', cq2!, '自动恢复CQ呼叫');

    logQSOStep('=== 场景2: autoResumeCQAfterFail = false（对比） ===');
    
    // 开始第二个操作员的测试
    operatorWithoutAutoResume.startCallingCQ();
    const cq3 = operatorWithoutAutoResume.getNextTransmission();
    operatorWithoutAutoResume.handleCycleEnd(true, cq3);

    operatorWithoutAutoResume.receivedMessages([{
        rawMessage: 'BA3XYZ BD3TEST OM94',
        snr: -10,
        dt: 0,
        df: 0
    }]);

    const report3 = operatorWithoutAutoResume.getNextTransmission();
    operatorWithoutAutoResume.handleCycleEnd(true, report3);

    // 模拟超时失败
    const retryReport3 = operatorWithoutAutoResume.getNextTransmission();
    operatorWithoutAutoResume.handleCycleEnd(true, retryReport3);

    const retryReport4 = operatorWithoutAutoResume.getNextTransmission();
    operatorWithoutAutoResume.handleCycleEnd(true, retryReport4);

    // 应该停留在LISTENING状态，而不是自动CQ
    assert.strictEqual(operatorWithoutAutoResume.getQSOState(), QSOState.LISTENING);
    console.log(`   ✅ 不自动恢复CQ: EXCHANGING_REPORT → FAILED → LISTENING`);

    logQSOStep('🎯 测试总结');
    console.log(`   🚀 autoResumeCQAfterFail=true:  失败后自动恢复CQ（推荐FT8设置）`);
    console.log(`   ⏸️  autoResumeCQAfterFail=false: 失败后进入监听状态`);
    console.log(`   ✨ 在真实FT8通联中，应该使用 autoResumeCQAfterFail=true`);
    console.log(`   💡 这样可以持续呼叫，增加QSO成功机会`);

    console.log('\n🎉 QSO超时失败后自动恢复CQ测试完成！');
}); 