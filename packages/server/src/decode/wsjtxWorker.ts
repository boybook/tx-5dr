import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';

// 工作线程的解码函数
export default async function decodeAudio(data: {
  slotId: string;
  windowIdx: number;
  audioData: number[]; // 序列化的 Float32Array
  sampleRate: number;
  timestamp: number;
}) {
  const startTime = performance.now();
  
  try {
    console.log(`🔍 [Worker] 开始解码: 时隙=${data.slotId}, 窗口=${data.windowIdx}, 样本数=${data.audioData.length}`);
    
    // 创建 WSJTX 库实例
    const lib = new WSJTXLib();
    
    // 将数组转换回 Float32Array
    const audioFloat32 = new Float32Array(data.audioData);
    
    // 确保采样率是 12kHz（wsjtx-lib 要求）
    let processedAudio = audioFloat32;
    if (data.sampleRate !== 12000) {
        console.log(`🔄 [Worker] 重采样: ${data.sampleRate}Hz != 12000Hz`);
        return;
    }
    
    // 转换为 Int16Array（wsjtx-lib 内部要求）
    const audioInt16 = new Int16Array(processedAudio.length);
    for (let i = 0; i < processedAudio.length; i++) {
      audioInt16[i] = Math.round((processedAudio[i] || 0) * 32767);
    }
    
    // console.log(`📊 [Worker] 音频数据准备完成: ${audioInt16.length} 样本, 持续时间: ${(audioInt16.length / 12000).toFixed(2)}秒`);
    
    // 清空之前的消息队列
    lib.pullMessages();
    
    // 执行 FT8 解码
    const audioFrequency = 0;
    const decodeResult = await lib.decode(WSJTXMode.FT8, audioInt16, audioFrequency);
    
    // console.log(`🎯 [Worker] 解码完成: 成功=${decodeResult.success}`);
    
    // 获取解码的消息
    const messages = lib.pullMessages();
    // console.log(`📨 [Worker] 找到 ${messages.length} 个消息`);
    
    // 转换为我们的格式
    const frames = messages.map(msg => ({
      message: msg.text,
      snr: msg.snr,
      dt: msg.deltaTime,
      freq: msg.deltaFrequency + audioFrequency, // 加上基频
      confidence: 1.0 // wsjtx-lib 没有置信度，默认为 1.0
    }));
    
    const processingTimeMs = performance.now() - startTime;
    
    // console.log(`✅ [Worker] 解码结果: ${frames.length} 个信号, 耗时: ${processingTimeMs.toFixed(2)}ms`);
    
    return {
      slotId: data.slotId,
      frames,
      processingTimeMs
    };
    
  } catch (error) {
    const processingTimeMs = performance.now() - startTime;
    console.error(`❌ [Worker] 解码失败:`, error);
    
    return {
      slotId: data.slotId,
      frames: [],
      processingTimeMs,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}