import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';

// 编码请求数据类型
interface EncodeRequest {
  message: string;
  frequency: number;
  operatorId: string;
  mode?: 'FT8' | 'FT4';
}

// 编码结果类型
interface EncodeResult {
  operatorId: string;
  audioData: number[]; // 序列化的 Float32Array
  sampleRate: number;
  duration: number;
  success: boolean;
  error?: string;
}

// 工作线程的编码函数
export default async function encodeMessage(data: EncodeRequest): Promise<EncodeResult> {
  const startTime = performance.now();
  
  try {
    console.log(`🎵 [EncodeWorker] 开始编码:`);
    console.log(`   操作员: ${data.operatorId}`);
    console.log(`   消息: "${data.message}"`);
    console.log(`   频率: ${data.frequency}Hz`);
    console.log(`   模式: ${data.mode || 'FT8'}`);
    
    // 创建 WSJTX 库实例
    const lib = new WSJTXLib();
    
    // 确定模式
    const mode = data.mode === 'FT4' ? WSJTXMode.FT4 : WSJTXMode.FT8;
    console.log(`🎵 [EncodeWorker] 使用模式: ${mode === WSJTXMode.FT8 ? 'FT8' : 'FT4'}`);
    
    // 调用编码功能
    console.log(`🎵 [EncodeWorker] 调用 lib.encode()...`);
    let audioFloat32: Float32Array;
    let messageSent: string;
    
    try {
      // wsjtx-lib返回 { audioData: Float32Array, messageSent: string }
      const encodeResult = await lib.encode(mode, data.message, data.frequency);
      
      console.log(`🎵 [EncodeWorker] 编码结果:`, {
        audioDataType: encodeResult.audioData?.constructor.name,
        audioDataLength: encodeResult.audioData?.length,
        messageSent: encodeResult.messageSent
      });
      
      audioFloat32 = encodeResult.audioData;
      messageSent = encodeResult.messageSent;
      
      if (!audioFloat32 || audioFloat32.length === 0) {
        throw new Error('编码返回的音频数据为空');
      }
      
      // 立即检查和截断异常长度的音频数据，避免后续处理时栈溢出
      const expectedDuration = mode === WSJTXMode.FT8 ? 12.64 : 6.4;
      const sampleRate = mode === WSJTXMode.FT8 ? 48000 : 48000; // FT8和FT4都使用48kHz
      const actualDuration = audioFloat32.length / sampleRate;
      const maxSamples = Math.floor(expectedDuration * sampleRate * 1.5); // 允许50%的缓冲
      
      if (audioFloat32.length > maxSamples) {
        console.warn(`⚠️ [EncodeWorker] 音频数据过长，立即截断: ${audioFloat32.length} -> ${maxSamples} 样本`);
        audioFloat32 = audioFloat32.slice(0, maxSamples);
      }
      
    } catch (encodeError: any) {
      console.error(`🎵 [EncodeWorker] lib.encode() 调用失败:`, encodeError);
      throw new Error(`编码库调用失败: ${encodeError.message}`);
    }
    
    console.log(`🎵 [EncodeWorker] 原始音频数据:`);
    console.log(`   样本数: ${audioFloat32.length}`);
    console.log(`   时长 (48kHz): ${(audioFloat32.length / 48000).toFixed(2)}s`);
    
    // 计算最小值和最大值，避免使用spread operator
    let minSample = audioFloat32[0];
    let maxSample = audioFloat32[0];
    let maxAmplitude = 0;
    
    for (let i = 0; i < audioFloat32.length; i++) {
      const sample = audioFloat32[i];
      if (sample < minSample) minSample = sample;
      if (sample > maxSample) maxSample = sample;
      
      const absSample = Math.abs(sample);
      if (absSample > maxAmplitude) {
        maxAmplitude = absSample;
      }
    }
    
    console.log(`   样本范围: [${minSample.toFixed(4)}, ${maxSample.toFixed(4)}]`);
    console.log(`   实际发送消息: "${messageSent}"`);
    
    // 验证音频时长是否合理（FT8应该约12.64秒，FT4约6.4秒）
    const expectedDuration = mode === WSJTXMode.FT8 ? 12.64 : 6.4;
    const sampleRate = 48000; // FT8和FT4都使用48kHz
    const actualDuration = audioFloat32.length / sampleRate;
    if (Math.abs(actualDuration - expectedDuration) > 2) {
      console.warn(`⚠️ [EncodeWorker] 音频时长异常: 期望${expectedDuration}s，实际${actualDuration.toFixed(2)}s`);
      
      // 如果时长仍然过长，再次截断
      if (actualDuration > expectedDuration * 2) {
        const expectedSamples = Math.floor(expectedDuration * sampleRate);
        console.log(`🔄 [EncodeWorker] 再次截断音频: ${audioFloat32.length} -> ${expectedSamples} 样本`);
        audioFloat32 = audioFloat32.slice(0, expectedSamples);
      }
    }
    
    const processingTimeMs = performance.now() - startTime;
    const duration = audioFloat32.length / sampleRate; // 48kHz 采样率
    
    console.log(`✅ [EncodeWorker] 编码完成:`);
    console.log(`   样本数: ${audioFloat32.length}`);
    console.log(`   时长: ${duration.toFixed(2)}s`);
    console.log(`   最大振幅: ${maxAmplitude.toFixed(4)}`);
    console.log(`   耗时: ${processingTimeMs.toFixed(2)}ms`);
    
    return {
      operatorId: data.operatorId,
      audioData: Array.from(audioFloat32), // 序列化为普通数组
      sampleRate: 48000,
      duration,
      success: true
    };
    
  } catch (error) {
    const processingTimeMs = performance.now() - startTime;
    console.error(`❌ [EncodeWorker] 编码失败:`, error);
    
    return {
      operatorId: data.operatorId,
      audioData: [],
      sampleRate: 48000,
      duration: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
} 