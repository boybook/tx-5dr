import { EventEmitter } from 'eventemitter3';
import Piscina from 'piscina';
import * as path from 'path';
import * as fs from 'fs';
import { 
  type IDecodeQueue, 
  type DecodeRequest, 
  type DecodeResult 
} from '@tx5dr/core';
import { 
  saveAudioToWav, 
  generateAudioFilename, 
  createAudioOutputDir, 
  resampleAudioProfessional,
  normalizeAudioVolume,
  analyzeAudioQualityDetailed
} from '../utils/audioUtils.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DecodeWorkQueueEvents {
  'decodeComplete': (result: DecodeResult) => void;
  'decodeError': (error: Error, request: DecodeRequest) => void;
  'queueEmpty': () => void;
}

/**
 * 使用 wsjtx-lib 进行解码
 */
export class WSJTXDecodeWorkQueue extends EventEmitter<DecodeWorkQueueEvents> implements IDecodeQueue {
  private pool: Piscina;
  private queueSize = 0;
  private maxConcurrency: number;
  
  constructor(maxConcurrency: number = 4) {
    super();
    this.maxConcurrency = maxConcurrency;
    
    // 动态确定 worker 文件路径
    const workerFilename = this.resolveWorkerPath();
    
    // 创建工作池
    this.pool = new Piscina({
      filename: workerFilename,
      maxThreads: maxConcurrency,
      minThreads: 1,
      idleTimeout: 30000, // 30秒空闲超时
    });
    
    console.log(`🔧 [解码队列] 初始化完成，最大并发: ${maxConcurrency}`);
    console.log(`📁 [解码队列] Worker 文件路径: ${workerFilename}`);
  }
  
  /**
   * 解析 worker 文件路径，优先使用编译后的 dist 目录
   */
  private resolveWorkerPath(): string {
    const workerFileName = 'wsjtxWorker.js';
    
    // 候选路径列表（按优先级排序）
    const candidatePaths = [
      // 1. 如果当前在 dist 目录中，直接使用同目录的文件
      path.join(__dirname, workerFileName),
      
      // 2. 如果在源码目录中，查找编译后的 dist 目录
      path.join(path.dirname(path.dirname(__dirname)), 'dist', 'decode', workerFileName),
      
      // 3. 相对于项目根目录的 dist 路径
      path.join(process.cwd(), 'packages', 'server', 'dist', 'decode', workerFileName),
      
      // 4. 相对于当前包根目录的 dist 路径
      path.join(path.dirname(path.dirname(__dirname)), 'dist', 'decode', workerFileName),
    ];
    
    // 尝试找到存在的文件
    for (const candidatePath of candidatePaths) {
      try {
        // 检查文件是否存在
        if (fs.existsSync(candidatePath)) {
          return candidatePath;
        }
      } catch (error) {
        // 继续尝试下一个路径
      }
    }
    
    // 如果都没找到，返回默认路径（可能会出错，但至少有错误信息）
    const defaultPath = path.join(__dirname, workerFileName);
    console.warn(`⚠️  [解码队列] 未找到 worker 文件，使用默认路径: ${defaultPath}`);
    console.warn(`🔍 [解码队列] 尝试过的路径:`, candidatePaths);
    return defaultPath;
  }
  
  /**
   * 推送解码请求到队列
   */
  async push(request: DecodeRequest): Promise<void> {
    this.queueSize++;
    
    /* const pcmSizeKB = (request.pcm.byteLength / 1024).toFixed(1);
    console.log(`📡 [真实解码队列] 收到解码请求:`);
    console.log(`   时隙: ${request.slotId}`);
    console.log(`   窗口: ${request.windowIdx}`);
    console.log(`   PCM大小: ${pcmSizeKB}KB (${request.pcm.byteLength}字节)`);
    console.log(`   原始采样率: ${request.sampleRate}Hz`);
    console.log(`   队列大小: ${this.queueSize}`); */
    
    try {
      // 将 ArrayBuffer 转换为 Float32Array
      const originalAudioData = new Float32Array(request.pcm);
      
      // 步骤1: 重采样到 12kHz（FT8/FT4 标准采样率）
      let resampledAudioData: Float32Array;
      if (request.sampleRate && request.sampleRate !== 12000) {
        // console.log(`🔄 [解码队列] 重采样: ${request.sampleRate}Hz -> 12000Hz`);
        resampledAudioData = await resampleAudioProfessional(
          originalAudioData,
          request.sampleRate,
          12000,
          1, // 单声道
          1  // SRC_SINC_MEDIUM_QUALITY
        );
        // console.log(`🔄 [解码队列] 重采样完成: ${originalAudioData.length} -> ${resampledAudioData.length} 样本`);
      } else {
        resampledAudioData = originalAudioData;
        // console.log(`✅ [解码队列] 无需重采样，已经是12kHz`);
      }
      
      // 步骤2: 音量标准化
      //console.log(`🔊 [解码队列] 开始音量标准化...`);
      //const normalizedAudioData = normalizeAudioVolume(resampledAudioData, 0.95, 0.1, 10.0);
      
      // 步骤3: 音频质量分析
      /* const audioQuality = analyzeAudioQualityDetailed(resampledAudioData, 12000);
      console.log(`📊 [解码队列] 音频质量分析:`);
      console.log(`   时长: ${audioQuality.durationSeconds.toFixed(2)}s`);
      console.log(`   峰值: ${audioQuality.peakLevel.toFixed(4)}`);
      console.log(`   RMS: ${audioQuality.rmsLevel.toFixed(4)}`);
      console.log(`   动态范围: ${audioQuality.dynamicRange.toFixed(4)}`);
      console.log(`   信噪比估计: ${audioQuality.snrEstimate.toFixed(1)}dB`);
      if (audioQuality.clippedSamples > 0) {
        console.log(`   ⚠️ 削波样本: ${audioQuality.clippedSamples}`);
      } */
      
      // （测试）保存处理后的 PCM 数据为 WAV 文件
      // const filename2 = generateAudioFilename(request.slotId, request.windowIdx, 'processed');
      // const outputDir2 = createAudioOutputDir(__dirname + '/../..', 'audio_captures');
      // await saveAudioToWav(normalizedAudioData, filename2, outputDir2, 12000);
      
      // 提交到工作池（使用处理后的数据）
      const result = await this.pool.run({
        slotId: request.slotId,
        windowIdx: request.windowIdx,
        audioData: Array.from(resampledAudioData), // 转换为普通数组以便序列化
        sampleRate: 12000, // 处理后的采样率
        timestamp: request.timestamp
      });
      
      this.queueSize--;
      
      // 构建解码结果
      const decodeResult: DecodeResult = {
        slotId: request.slotId,
        windowIdx: request.windowIdx,
        frames: result.frames || [],
        timestamp: request.timestamp,
        processingTimeMs: result.processingTimeMs || 0,
        windowOffsetMs: request.windowOffsetMs || 0  // 添加窗口偏移信息
      };
      
      console.log(`🔧 [解码完成] 时隙: ${request.slotId}, 窗口: ${request.windowIdx}, 找到 ${decodeResult.frames.length} 个信号, 耗时: ${decodeResult.processingTimeMs}ms`);
      
      // 简化的解码结果显示 - 不显示详细信息，留给 SlotPack 统一处理
      /* if (decodeResult.frames.length > 0) {
        console.log(`   📡 发现 ${decodeResult.frames.length} 个信号 (详情将在时隙包更新时显示)`);
      } */
      
      this.emit('decodeComplete', decodeResult);
      
      if (this.queueSize === 0) {
        this.emit('queueEmpty');
      }
      
    } catch (error) {
      this.queueSize--;
      console.error(`❌ [解码失败] 时隙: ${request.slotId}, 窗口: ${request.windowIdx}:`, error);
      this.emit('decodeError', error as Error, request);
      
      if (this.queueSize === 0) {
        this.emit('queueEmpty');
      }
    }
  }
  
  /**
   * 获取队列大小
   */
  size(): number {
    return this.queueSize;
  }
  
  /**
   * 获取工作池状态
   */
  getStatus() {
    return {
      queueSize: this.queueSize,
      maxConcurrency: this.maxConcurrency,
      activeThreads: this.pool.threads.length,
      utilization: this.pool.utilization
    };
  }
  
  /**
   * 销毁工作池
   */
  async destroy(): Promise<void> {
    console.log('🗑️ [解码队列] 正在销毁工作池...');
    await this.pool.destroy();
    console.log('✅ [解码队列] 工作池销毁完成');
  }
} 