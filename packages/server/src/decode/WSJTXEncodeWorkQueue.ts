import { EventEmitter } from 'eventemitter3';
import Piscina from 'piscina';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface EncodeRequest {
  message: string;
  frequency: number;
  operatorId: string;
  mode?: 'FT8' | 'FT4';
}

export interface EncodeResult {
  operatorId: string;
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
  success: boolean;
  error?: string;
}

export interface EncodeWorkQueueEvents {
  'encodeComplete': (result: EncodeResult) => void;
  'encodeError': (error: Error, request: EncodeRequest) => void;
  'queueEmpty': () => void;
}

/**
 * 使用 wsjtx-lib 进行FT8消息编码
 */
export class WSJTXEncodeWorkQueue extends EventEmitter<EncodeWorkQueueEvents> {
  private pool: Piscina;
  private queueSize = 0;
  private maxConcurrency: number;
  
  constructor(maxConcurrency: number = 2) {
    super();
    this.maxConcurrency = maxConcurrency;
    
    // 创建工作池
    this.pool = new Piscina({
      filename: path.join(__dirname, 'wsjtxEncodeWorker.js'),
      maxThreads: maxConcurrency,
      minThreads: 1,
      idleTimeout: 30000, // 30秒空闲超时
    });
    
    console.log(`🎵 [编码队列] 初始化完成，最大并发: ${maxConcurrency}`);
  }
  
  /**
   * 推送编码请求到队列
   */
  async push(request: EncodeRequest): Promise<void> {
    this.queueSize++;
    
    console.log(`🎵 [编码队列] 收到编码请求:`);
    console.log(`   操作员: ${request.operatorId}`);
    console.log(`   消息: "${request.message}"`);
    console.log(`   频率: ${request.frequency}Hz`);
    console.log(`   模式: ${request.mode || 'FT8'}`);
    console.log(`   队列大小: ${this.queueSize}`);
    
    try {
      // 提交到工作池
      const result = await this.pool.run(request);
      
      this.queueSize--;
      
      // 构建编码结果
      const encodeResult: EncodeResult = {
        operatorId: result.operatorId,
        audioData: new Float32Array(result.audioData), // 转换回 Float32Array
        sampleRate: result.sampleRate,
        duration: result.duration,
        success: result.success,
        error: result.error
      };
      
      if (encodeResult.success) {
        console.log(`🎵 [编码完成] 操作员: ${request.operatorId}, 音频时长: ${encodeResult.duration.toFixed(2)}s, 样本数: ${encodeResult.audioData.length}`);
      } else {
        console.error(`❌ [编码失败] 操作员: ${request.operatorId}, 错误: ${encodeResult.error}`);
      }
      
      this.emit('encodeComplete', encodeResult);
      
      if (this.queueSize === 0) {
        this.emit('queueEmpty');
      }
      
    } catch (error) {
      this.queueSize--;
      console.error(`❌ [编码失败] 操作员: ${request.operatorId}:`, error);
      this.emit('encodeError', error as Error, request);
      
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
    console.log('🗑️ [编码队列] 正在销毁工作池...');
    await this.pool.destroy();
    console.log('✅ [编码队列] 工作池销毁完成');
  }
} 