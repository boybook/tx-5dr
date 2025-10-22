import * as fs from 'fs';
import * as path from 'path';
import * as nodeWav from 'node-wav';

/**
 * 音频工具函数集合
 */

// 缓存重采样器实例以提高性能
const resamplerCache = new Map<string, any>();

// 动态导入 libsamplerate-js
let LibSampleRate: any = null;
export async function getLibSampleRate() {
  if (!LibSampleRate) {
    const module = await import('@alexanderolsen/libsamplerate-js');
    LibSampleRate = module.default || module;
  }
  return LibSampleRate;
}

/**
 * 保存音频数据为 WAV 文件
 * @param audioData Float32Array 音频数据
 * @param filename 文件名（不包含扩展名）
 * @param outputDir 输出目录路径
 * @param sampleRate 采样率，默认 12000Hz
 * @returns Promise<string> 返回保存的文件路径
 */
export async function saveAudioToWav(
  audioData: Float32Array,
  filename: string,
  outputDir: string,
  sampleRate: number = 12000
): Promise<string> {
  try {
    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log(`📁 [音频工具] 创建输出目录: ${outputDir}`);
    }
    
    // 生成完整文件路径
    const wavFilename = filename.endsWith('.wav') ? filename : `${filename}.wav`;
    const filepath = path.resolve(outputDir, wavFilename);
    
    console.log(`💾 [音频工具] 准备保存音频文件 (float32): ${filepath}`);
    
    // 确保音频数据在有效范围内 [-1, 1]
    const normalizedAudio = new Float32Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
      const sample = audioData[i] || 0;
      if (isNaN(sample) || !isFinite(sample)) {
        normalizedAudio[i] = 0; // 无效样本用0替换
      } else {
        normalizedAudio[i] = Math.max(-1, Math.min(1, sample));
      }
    }
    
    // 使用 node-wav 库保存为 float32 格式
    const actualSampleRate = sampleRate || 12000;
    
    // node-wav 需要通道数据数组，单声道就是一个数组
    const channelData = [normalizedAudio];
    
    // 编码为 WAV buffer
    const wavBuffer = nodeWav.encode(channelData, {
      sampleRate: actualSampleRate,
      float: true,
      bitDepth: 32
    });
    
    // 写入文件
    fs.writeFileSync(filepath, wavBuffer);
    
    const stats = fs.statSync(filepath);
    console.log(`✅ [音频工具] 保存音频文件成功 (float32): ${wavFilename} (${(stats.size / 1024).toFixed(1)}KB)`);
    
    return filepath;
    
  } catch (error) {
    console.error(`❌ [音频工具] 保存音频文件失败:`, error);
    console.error(`   输出目录: ${outputDir}`);
    console.error(`   目录是否存在: ${fs.existsSync(outputDir)}`);
    
    // 尝试创建一个简单的测试文件来验证目录权限
    try {
      const testFile = path.resolve(outputDir, 'test.txt');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      console.log(`✅ [音频工具] 目录权限正常`);
    } catch (permError) {
      console.error(`❌ [音频工具] 目录权限问题:`, permError);
    }
    
    throw error;
  }
}

/**
 * 生成带时间戳的音频文件名
 * @param slotId 时隙ID
 * @param windowIdx 窗口索引
 * @param prefix 文件名前缀，默认为空
 * @returns 生成的文件名（不包含扩展名）
 */
export function generateAudioFilename(
  slotId: string,
  windowIdx: number,
  prefix: string = ''
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefixPart = prefix ? `${prefix}_` : '';
  return `${prefixPart}${slotId}_window${windowIdx}_${timestamp}`;
}

/**
 * 音频音量标准化
 * 将音频数据的振幅标准化，使最大振幅达到 ±1
 * @param samples 输入音频样本
 * @param targetPeak 目标峰值，默认 0.95（留一点余量避免削波）
 * @param minGain 最小增益，避免过度放大噪声，默认 0.1
 * @param maxGain 最大增益，避免过度放大，默认 10.0
 * @returns 标准化后的音频数据
 */
export function normalizeAudioVolume(
  samples: Float32Array,
  targetPeak: number = 0.95,
  minGain: number = 0.1,
  maxGain: number = 10.0
): Float32Array {
  if (samples.length === 0) {
    return new Float32Array(0);
  }
  
  // 找到当前的峰值
  let currentPeak = 0;
  for (let i = 0; i < samples.length; i++) {
    const absValue = Math.abs(samples[i] || 0);
    if (absValue > currentPeak) {
      currentPeak = absValue;
    }
  }
  
  // 如果音频完全静音，返回原始数据
  if (currentPeak === 0) {
    console.log(`🔇 [音频标准化] 检测到静音，跳过标准化`);
    return new Float32Array(samples);
  }
  
  // 计算需要的增益
  const requiredGain = targetPeak / currentPeak;
  
  // 限制增益范围
  const actualGain = Math.max(minGain, Math.min(maxGain, requiredGain));
  
  console.log(`🔊 [音频标准化] 当前峰值: ${currentPeak.toFixed(4)}, 目标峰值: ${targetPeak}, 计算增益: ${requiredGain.toFixed(2)}, 实际增益: ${actualGain.toFixed(2)}`);
  
  // 如果增益接近1，不需要处理
  if (Math.abs(actualGain - 1.0) < 0.01) {
    console.log(`✅ [音频标准化] 音量已接近目标，无需调整`);
    return new Float32Array(samples);
  }
  
  // 应用增益
  const normalized = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] || 0;
    const amplified = sample * actualGain;
    
    // 软限幅，防止削波
    if (Math.abs(amplified) > 1.0) {
      const sign = amplified >= 0 ? 1 : -1;
      normalized[i] = sign * Math.tanh(Math.abs(amplified)) * 0.98;
    } else {
      normalized[i] = amplified;
    }
  }
  
  // 验证结果
  let finalPeak = 0;
  for (let i = 0; i < normalized.length; i++) {
    const absValue = Math.abs(normalized[i] || 0);
    if (absValue > finalPeak) {
      finalPeak = absValue;
    }
  }
  
  console.log(`✅ [音频标准化] 完成，最终峰值: ${finalPeak.toFixed(4)}`);
  
  return normalized;
}

/**
 * 创建音频输出目录
 * @param baseDir 基础目录
 * @param subDir 子目录名称，默认为 'audio_captures'
 * @returns 创建的目录路径
 */
export function createAudioOutputDir(
  baseDir: string = process.cwd(),
  subDir: string = 'audio_captures'
): string {
  const outputDir = path.resolve(baseDir, subDir);
  
  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log(`📁 [音频工具] 创建音频输出目录: ${outputDir}`);
    } else {
      console.log(`📁 [音频工具] 使用现有音频输出目录: ${outputDir}`);
    }
    return outputDir;
  } catch (error) {
    console.error(`❌ [音频工具] 创建音频输出目录失败:`, error);
    // 如果创建失败，使用临时目录
    const tempDir = path.resolve(process.cwd(), 'temp_audio_captures');
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`📁 [音频工具] 使用临时目录: ${tempDir}`);
    return tempDir;
  }
}

/**
 * 清理旧的音频文件
 * @param outputDir 输出目录
 * @param maxAgeMs 最大文件年龄（毫秒），默认24小时
 * @returns 清理的文件数量
 */
export function cleanupOldAudioFiles(
  outputDir: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000 // 24小时
): number {
  try {
    if (!fs.existsSync(outputDir)) {
      return 0;
    }
    
    const files = fs.readdirSync(outputDir);
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const file of files) {
      if (!file.endsWith('.wav')) continue;
      
      const filepath = path.join(outputDir, file);
      const stats = fs.statSync(filepath);
      const fileAge = now - stats.mtime.getTime();
      
      if (fileAge > maxAgeMs) {
        fs.unlinkSync(filepath);
        cleanedCount++;
        console.log(`🗑️ [音频工具] 清理旧文件: ${file}`);
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`✅ [音频工具] 清理完成，删除了 ${cleanedCount} 个旧文件`);
    }
    
    return cleanedCount;
  } catch (error) {
    console.error(`❌ [音频工具] 清理旧文件失败:`, error);
    return 0;
  }
}

/**
 * 使用 libsamplerate 进行高质量重采样
 * @param samples 输入音频样本
 * @param inputSampleRate 输入采样率
 * @param outputSampleRate 输出采样率
 * @param channels 声道数，默认 1
 * @param quality 重采样质量，默认最高质量
 * @returns 重采样后的音频数据
 */
export async function resampleAudioProfessional(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
  channels: number = 1,
  quality: number = 2 // SRC_SINC_FASTEST - 最快速度，适合实时处理
): Promise<Float32Array> {
  if (inputSampleRate === outputSampleRate) {
    return samples; // 采样率相同，无需重采样
  }

  // 创建缓存键
  const cacheKey = `${inputSampleRate}-${outputSampleRate}-${channels}-${quality}`;

  try {
    const lib = await getLibSampleRate();

    // 尝试从缓存获取重采样器
    let resampler = resamplerCache.get(cacheKey);

    if (!resampler) {
      // 创建新的重采样器
      resampler = await lib.create(channels, inputSampleRate, outputSampleRate, {
        converterType: quality
      });

      // 缓存重采样器（但限制缓存大小）
      if (resamplerCache.size < 10) {
        resamplerCache.set(cacheKey, resampler);
      }

      console.log(`🔄 [音频工具] 创建新的重采样器: ${inputSampleRate}Hz -> ${outputSampleRate}Hz, 质量=${quality}`);
    }

    // 执行重采样
    const resampled = resampler.simple(samples);

    // console.log(`🔄 [音频工具] 重采样完成: ${samples.length} -> ${resampled.length} 样本`);

    return resampled;

  } catch (error) {
    console.error(`❌ [音频工具] 重采样失败:`, error);

    // 如果专业重采样失败，回退到简单重采样
    console.log(`🔄 [音频工具] 回退到简单重采样`);
    return resampleAudioSimple(samples, inputSampleRate, outputSampleRate);
  }
}

/**
 * 简单的重采样函数（回退方案）
 * @param samples 输入音频样本
 * @param inputSampleRate 输入采样率
 * @param outputSampleRate 输出采样率
 * @returns 重采样后的音频数据
 */
function resampleAudioSimple(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  if (inputSampleRate === outputSampleRate) {
    return samples;
  }
  
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(samples.length / ratio);
  const resampled = new Float32Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const index1 = Math.floor(sourceIndex);
    const index2 = Math.min(index1 + 1, samples.length - 1);
    const fraction = sourceIndex - index1;
    
    const sample1 = samples[index1] || 0;
    const sample2 = samples[index2] || 0;
    
    // 线性插值
    const interpolated = sample1 + (sample2 - sample1) * fraction;
    
    // 防止爆音：限制到有效范围
    resampled[i] = Math.max(-1, Math.min(1, interpolated));
  }
  
  return resampled;
}

/**
 * 专门用于 FT8/FT4 的重采样函数（48kHz -> 12kHz）
 * @param samples 输入音频样本（48kHz）
 * @param quality 重采样质量，默认中等质量（平衡性能和质量）
 * @returns 重采样后的音频数据（12kHz）
 */
export async function resampleTo12kHz(
  samples: Float32Array,
  quality: number = 1 // SRC_SINC_MEDIUM_QUALITY
): Promise<Float32Array> {
  return resampleAudioProfessional(samples, 48000, 12000, 1, quality);
}

/**
 * 清理重采样器缓存
 */
export function clearResamplerCache(): void {
  // Soxr 重采样器是 WASM 模块，通过垃圾回收自动清理
  // 这里只需要清空缓存映射
  resamplerCache.clear();
  console.log('🧹 [音频工具] Soxr 重采样器缓存已清理');
}

/**
 * 批量重采样函数，支持多种目标采样率
 * @param samples 输入音频样本
 * @param inputSampleRate 输入采样率
 * @param targetRates 目标采样率数组
 * @returns 重采样结果的映射
 */
export async function batchResample(
  samples: Float32Array,
  inputSampleRate: number,
  targetRates: number[]
): Promise<Map<number, Float32Array>> {
  const results = new Map<number, Float32Array>();
  
  for (const targetRate of targetRates) {
    const resampled = await resampleAudioProfessional(samples, inputSampleRate, targetRate);
    results.set(targetRate, resampled);
  }
  
  return results;
} 