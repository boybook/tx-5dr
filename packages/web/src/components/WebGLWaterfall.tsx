import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../utils/logger';

const logger = createLogger('WebGLWaterfall');

export interface AutoRangeConfig {
  updateInterval: number;      // 更新频率（帧数），默认10
  minPercentile: number;        // 最小值百分位数（0-100），默认15
  maxPercentile: number;        // 最大值百分位数（0-100），默认99
  rangeExpansionFactor: number; // 范围扩展因子，默认4.0
}

export interface RxFrequency {
  callsign: string;
  frequency: number;
}

export interface TxFrequency {
  operatorId: string;
  frequency: number;
  callsign?: string;
}

export interface BasebandInteractionRange {
  min: number;
  max: number;
}

export interface InteractionFrequencyRange {
  min: number;
  max: number;
}

export interface TxBandOverlay {
  id: string;
  label: string;
  lineFrequency: number;
  rangeStartFrequency: number;
  rangeEndFrequency: number;
  draggable?: boolean;
}

interface WebGLWaterfallProps {
  data: number[][];
  frequencies: number[];
  className?: string;
  height?: number;
  minDb?: number;
  maxDb?: number;
  autoRange?: boolean;
  autoRangeConfig?: AutoRangeConfig;
  rxFrequencies?: RxFrequency[];
  txFrequencies?: TxFrequency[];
  txBandOverlays?: TxBandOverlay[];
  frequencyRangeMode?: 'baseband' | 'absolute-center' | 'absolute-fixed';
  referenceFrequencyHz?: number | null;
  basebandInteractionRange?: BasebandInteractionRange;
  interactionFrequencyMode?: 'baseband' | 'absolute';
  interactionFrequencyRange?: InteractionFrequencyRange | null;
  onTxFrequencyChange?: (operatorId: string, frequency: number) => void;
  onTxBandOverlayFrequencyChange?: (id: string, frequency: number) => void;
  onRightClickSetFrequency?: (frequency: number) => void;
  onActualRangeChange?: (range: { min: number; max: number } | null) => void;
  hoverFrequency?: number | null;
  /** 纹理总行数，不足时底部用暗色填充，实现从顶部逐渐填充的效果 */
  totalRows?: number;
  /** 当前是否处于发射状态，用于 TX/RX 自动范围分离 */
  isTransmitting?: boolean;
}

export const WebGLWaterfall: React.FC<WebGLWaterfallProps> = ({
  data,
  frequencies,
  className = '',
  height = 200,
  minDb = -35,
  maxDb = 10,
  autoRange = true,
  autoRangeConfig = {
    updateInterval: 10,
    minPercentile: 15,
    maxPercentile: 99,
    rangeExpansionFactor: 4.0,
  },
  rxFrequencies = [],
  txFrequencies = [],
  txBandOverlays = [],
  frequencyRangeMode = 'baseband',
  referenceFrequencyHz = null,
  basebandInteractionRange = { min: 0, max: 3000 },
  interactionFrequencyMode = 'baseband',
  interactionFrequencyRange = null,
  onTxFrequencyChange,
  onTxBandOverlayFrequencyChange,
  onRightClickSetFrequency,
  onActualRangeChange,
  hoverFrequency,
  totalRows,
  isTransmitting = false,
}) => {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const textureRef = useRef<WebGLTexture | null>(null);
  const animationRef = useRef<number>();
  const [webglSupported, setWebglSupported] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actualRange, setActualRange] = React.useState<{min: number, max: number} | null>(null);

  // TX拖动状态
  const [draggingOperatorId, setDraggingOperatorId] = React.useState<string | null>(null);
  // 拖动时的本地频率覆盖（乐观更新 + 冷却期保护）
  const [localFrequencyOverride, setLocalFrequencyOverride] =
    React.useState<{ operatorId: string; frequency: number } | null>(null);
  const [cooldownOperatorId, setCooldownOperatorId] = React.useState<string | null>(null);
  const dragDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const latestDragFrequencyRef = useRef<{ operatorId: string; frequency: number } | null>(null);
  const [draggingBandOverlayId, setDraggingBandOverlayId] = React.useState<string | null>(null);
  const [localBandOverlayOverride, setLocalBandOverlayOverride] =
    React.useState<{ id: string; frequency: number } | null>(null);
  const [cooldownBandOverlayId, setCooldownBandOverlayId] = React.useState<string | null>(null);
  const latestBandOverlayFrequencyRef = useRef<{ id: string; frequency: number } | null>(null);

  // RX Popover hover状态
  const [hoveredRxCallsign, setHoveredRxCallsign] = React.useState<string | null>(null);

  // TX Popover hover状态（多操作员时使用）
  const [hoveredTxOperatorId, setHoveredTxOperatorId] = React.useState<string | null>(null);

  // 性能优化：缓存相关引用
  const positionBufferRef = useRef<WebGLBuffer | null>(null);
  const texCoordBufferRef = useRef<WebGLBuffer | null>(null);
  const colorMapTextureRef = useRef<WebGLTexture | null>(null);
  const lastDataLengthRef = useRef<number>(0);
  const rangeUpdateCounterRef = useRef<number>(0);
  const cachedRangeRef = useRef<{min: number, max: number} | null>(null);
  const textureDataRef = useRef<Uint8Array | null>(null);
  const heightRef = useRef(height);
  useEffect(() => { heightRef.current = height; }, [height]);
  const minDbRef = useRef(minDb);
  const maxDbRef = useRef(maxDb);
  useEffect(() => { minDbRef.current = minDb; }, [minDb]);
  useEffect(() => { maxDbRef.current = maxDb; }, [maxDb]);
  const actualRangeRef = useRef<{min: number, max: number} | null>(null);
  // TX/RX 自动范围分离：多段冻结机制
  // 每个冻结段记录一段历史行的行数和对应的范围
  const frozenSegmentsRef = useRef<Array<{ rowCount: number; range: { min: number; max: number } }>>([]);
  const activeRowCountRef = useRef<number>(0); // 当前状态已累积的行数
  const prevTransmittingRef = useRef<boolean | undefined>(undefined);
  const prevDataRef = useRef<number[][] | null>(null); // 用于检测新数据到达
  const dataRef = useRef<number[][]>(data); // 持有最新 data 引用，供上下文恢复时重绘
  // 平滑滚动相关
  const scrollOffsetLocationRef = useRef<WebGLUniformLocation | null>(null);
  const scrollAnimRef = useRef<number>();
  const lastDataTimeRef = useRef(0);
  const frameIntervalRef = useRef(100);

  const resetAutoRangeState = useCallback(() => {
    rangeUpdateCounterRef.current = 0;
    cachedRangeRef.current = null;
    actualRangeRef.current = null;
    frozenSegmentsRef.current = [];
    activeRowCountRef.current = 0;
    prevDataRef.current = null;
    setActualRange(null);
    onActualRangeChange?.(null);
  }, [onActualRangeChange]);

  // 优化后的数据范围计算 - 使用采样和缓存
  // 当存在冻结段时，只从活跃行（当前状态）采样
  const calculateDataRange = useCallback((spectrumData: number[][]) => {
    const calculateInternal = () => {
    if (spectrumData.length === 0) return { min: minDb, max: maxDb };

    // 每N帧更新一次范围，减少计算频率
    rangeUpdateCounterRef.current++;
    if (rangeUpdateCounterRef.current % autoRangeConfig.updateInterval !== 0 && cachedRangeRef.current) {
      return cachedRangeRef.current;
    }

    let min = Infinity;
    let max = -Infinity;
    const values: number[] = [];

    // 确定采样范围：如果存在冻结段且活跃行数足够，只采样活跃行
    const activeRows = activeRowCountRef.current;
    const sampleEndRow = (frozenSegmentsRef.current.length > 0 && activeRows > 0 && activeRows < spectrumData.length)
      ? activeRows
      : spectrumData.length;

    // 采样策略：对于大数据集，只采样部分数据
    const sampleRate = sampleEndRow > 50 ? 2 : 1;
    const maxSamples = 5000; // 最多采样5000个点
    let sampleCount = 0;

    for (let i = 0; i < sampleEndRow && sampleCount < maxSamples; i += sampleRate) {
      const row = spectrumData[i];
      const rowSampleRate = row.length > 100 ? Math.ceil(row.length / 100) : 1;

      for (let j = 0; j < row.length; j += rowSampleRate) {
        const value = row[j];
        if (isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
          values.push(value);
          sampleCount++;
        }
      }
    }

    // 如果没有有效数据，使用默认范围
    if (!isFinite(min) || !isFinite(max)) {
      return { min: minDb, max: maxDb };
    }

    // 快速百分位数计算（使用部分排序）
    values.sort((a, b) => a - b);
    const pMin = values[Math.floor(values.length * (autoRangeConfig.minPercentile / 100))];
    const p25 = values[Math.floor(values.length * 0.25)];
    const median = values[Math.floor(values.length * 0.5)];
    const p75 = values[Math.floor(values.length * 0.75)];
    const pMax = values[Math.floor(values.length * (autoRangeConfig.maxPercentile / 100))];

    // 使用优化的动态范围策略
    const medianRange = p75 - p25;
    const dynamicMin = Math.max(pMin, median - medianRange);
    const dynamicMax = Math.max(pMax, median + medianRange * autoRangeConfig.rangeExpansionFactor);

    const result = {
      min: dynamicMin,
      max: dynamicMax
    };

    // 缓存结果
    cachedRangeRef.current = result;

    return result;
    };

    return calculateInternal();
  }, [minDb, maxDb, autoRangeConfig]);

  // 瀑布图颜色映射 - 经典配色方案
  const colorMap = useMemo(() => {
    const colors = [
      [0, 0x00, 0x00, 0x20],       // 深蓝色
      [0.0833, 0x00, 0x00, 0x30],
      [0.1666, 0x00, 0x00, 0x50],
      [0.25, 0x00, 0x00, 0x91],
      [0.3333, 0x1E, 0x90, 0xFF],  // 蓝色
      [0.4166, 0xFF, 0xFF, 0xFF],  // 白色
      [0.5, 0xFF, 0xFF, 0x00],     // 黄色
      [0.5833, 0xFE, 0x6D, 0x16],
      [0.6666, 0xFF, 0x00, 0x00],  // 红色
      [0.75, 0xC6, 0x00, 0x00],
      [0.8333, 0x9F, 0x00, 0x00],
      [0.9166, 0x75, 0x00, 0x00],
      [1, 0x4A, 0x00, 0x00],       // 深红色
    ];

    // 生成256个颜色的查找表
    const colorLUT = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let r = 0, g = 0, b = 0;
      const a = 255;

      // 在颜色节点之间插值
      for (let j = 0; j < colors.length - 1; j++) {
        const [t1, r1, g1, b1] = colors[j];
        const [t2, r2, g2, b2] = colors[j + 1];
        
        if (t >= t1 && t <= t2) {
          const factor = (t - t1) / (t2 - t1);
          r = r1 + (r2 - r1) * factor;
          g = g1 + (g2 - g1) * factor;
          b = b1 + (b2 - b1) * factor;
          break;
        }
      }

      colorLUT[i * 4] = Math.round(r);
      colorLUT[i * 4 + 1] = Math.round(g);
      colorLUT[i * 4 + 2] = Math.round(b);
      colorLUT[i * 4 + 3] = a;
    }

    return colorLUT;
  }, []);

  // 顶点着色器源码
  const vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    
    uniform vec2 u_resolution;
    
    varying vec2 v_texCoord;
    
    void main() {
      vec2 clipSpace = ((a_position / u_resolution) * 2.0) - 1.0;
      gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
      v_texCoord = a_texCoord;
    }
  `;

  // 片段着色器源码
  const fragmentShaderSource = `
    precision mediump float;

    uniform sampler2D u_texture;
    uniform sampler2D u_colorMap;
    uniform float u_minDb;
    uniform float u_maxDb;
    uniform bool u_useFloatTexture;
    uniform float u_scrollOffset;

    varying vec2 v_texCoord;

    void main() {
      // 偏移 Y 坐标实现平滑滚动，clamp 防止底部环绕
      float scrolledY = clamp(v_texCoord.y + u_scrollOffset, 0.0, 1.0);
      float value = texture2D(u_texture, vec2(v_texCoord.x, scrolledY)).r;
      float normalized;
      
      if (u_useFloatTexture) {
        // 对于Float纹理，直接归一化dB值
        float range = u_maxDb - u_minDb;
        if (range > 0.0) {
          normalized = (value - u_minDb) / range;
        } else {
          normalized = 0.5;
        }
      } else {
        // 对于UNSIGNED_BYTE纹理，值已经归一化了
        normalized = value;
      }
      
      // 确保值在有效范围内
      normalized = clamp(normalized, 0.0, 1.0);
      
      // 应用对比度增强
      // 使用S型曲线来增强中等值的对比度
      normalized = normalized * normalized * (3.0 - 2.0 * normalized);
      
      // 轻微的伽马校正
      normalized = pow(normalized, 0.8);
      
      vec4 color = texture2D(u_colorMap, vec2(normalized, 0.5));
      gl_FragColor = color;
    }
  `;

  // 创建着色器
  const createShader = useCallback((gl: WebGLRenderingContext, type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      logger.error('Shader compilation error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }, []);

  // 创建程序
  const createProgram = useCallback((gl: WebGLRenderingContext) => {
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    if (!vertexShader || !fragmentShader) return null;

    const program = gl.createProgram();
    if (!program) return null;

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      logger.error('Program linking error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }

    return program;
  }, [createShader]);

  // 初始化WebGL
  const initWebGL = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return false;

    try {
      const gl = canvas.getContext('webgl', {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      }) as WebGLRenderingContext || canvas.getContext('experimental-webgl') as WebGLRenderingContext;
      
      if (!gl) {
        setWebglSupported(false);
        setError('NOT_SUPPORTED');
        return false;
      }

      glRef.current = gl;

      // 创建程序
      const program = createProgram(gl);
      if (!program) return false;

      programRef.current = program;
      gl.useProgram(program);

      // 创建并缓存颜色映射纹理
      const colorMapTexture = gl.createTexture();
      colorMapTextureRef.current = colorMapTexture;
      gl.bindTexture(gl.TEXTURE_2D, colorMapTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colorMap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // 创建数据纹理
      const dataTexture = gl.createTexture();
      textureRef.current = dataTexture;

      // 设置顶点数据
      const positions = new Float32Array([
        0, 0,
        canvas.width, 0,
        0, canvas.height,
        canvas.width, canvas.height,
      ]);

      const texCoords = new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 1,
      ]);

      // 创建并缓存位置缓冲区
      const positionBuffer = gl.createBuffer();
      positionBufferRef.current = positionBuffer;
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      // 创建并缓存纹理坐标缓冲区
      const texCoordBuffer = gl.createBuffer();
      texCoordBufferRef.current = texCoordBuffer;
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

      const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
      gl.enableVertexAttribArray(texCoordLocation);
      gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

      // 设置uniform
      const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);

      const minDbLocation = gl.getUniformLocation(program, 'u_minDb');
      gl.uniform1f(minDbLocation, minDbRef.current);

      const maxDbLocation = gl.getUniformLocation(program, 'u_maxDb');
      gl.uniform1f(maxDbLocation, maxDbRef.current);

      const useFloatTextureLocation = gl.getUniformLocation(program, 'u_useFloatTexture');
      gl.uniform1i(useFloatTextureLocation, 0);

      const scrollOffsetLocation = gl.getUniformLocation(program, 'u_scrollOffset');
      scrollOffsetLocationRef.current = scrollOffsetLocation;
      gl.uniform1f(scrollOffsetLocation, 0.0);

      // 设置纹理单元
      const textureLocation = gl.getUniformLocation(program, 'u_texture');
      gl.uniform1i(textureLocation, 0);

      const colorMapLocation = gl.getUniformLocation(program, 'u_colorMap');
      gl.uniform1i(colorMapLocation, 1);

      // 激活纹理单元
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, colorMapTexture);

      return true;
    } catch (err) {
      setWebglSupported(false);
      setError(err instanceof Error ? err.message : 'INIT_FAILED');
      return false;
    }
  }, [createProgram, colorMap]);

  // 优化后的纹理更新
  const updateTexture = useCallback((spectrumData: number[][]) => {
    const updateInternal = () => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;

    if (!gl || !texture || !program || gl.isContextLost() || spectrumData.length === 0) return;

    // 检测是否有新数据行到达（通过比较首行引用）
    const isNewData = prevDataRef.current !== spectrumData;
    prevDataRef.current = spectrumData;

    // TX/RX 状态切换检测：将当前活跃段冻结，开始新的活跃段
    if (autoRange && isTransmitting !== prevTransmittingRef.current && prevTransmittingRef.current !== undefined) {
      if (cachedRangeRef.current && activeRowCountRef.current > 0) {
        // 将当前活跃段推入冻结段列表的头部
        frozenSegmentsRef.current.unshift({
          rowCount: activeRowCountRef.current,
          range: { ...cachedRangeRef.current },
        });
      }
      cachedRangeRef.current = null;
      rangeUpdateCounterRef.current = 0;
      activeRowCountRef.current = 0;
    }
    prevTransmittingRef.current = isTransmitting;

    // 新数据到达时递增活跃行计数
    if (isNewData) {
      activeRowCountRef.current++;
    }

    const width = spectrumData[0].length;
    const actualHeight = spectrumData.length;
    // 纹理总高度：满足 totalRows 时底部填 0（暗色），实现从顶部逐渐填充效果
    const textureHeight = totalRows ? Math.max(actualHeight, totalRows) : actualHeight;
    const dataSize = width * textureHeight;

    // 重用或创建纹理数据数组
    if (!textureDataRef.current || textureDataRef.current.length !== dataSize) {
      textureDataRef.current = new Uint8Array(dataSize);
    }
    const textureData = textureDataRef.current;

    // 计算活跃范围（仅对真实数据行，不含底部填充行）
    let currentMin = minDb;
    let currentMax = maxDb;

    if (autoRange) {
      const range = calculateDataRange(spectrumData);
      currentMin = range.min;
      currentMax = range.max;

      // 只在范围变化显著时更新状态和通知父组件（使用 ref 比较避免循环依赖）
      if (!actualRangeRef.current ||
          Math.abs(actualRangeRef.current.min - currentMin) > 0.5 ||
          Math.abs(actualRangeRef.current.max - currentMax) > 0.5) {
        actualRangeRef.current = range;
        setActualRange(range);

        // 通知父组件范围已更新
        if (onActualRangeChange) {
          onActualRangeChange(range);
        }
      }
    }

    // 构建分段归一化参数列表：[活跃段, 冻结段0, 冻结段1, ...]
    // 每段包含 { rowCount, rangeMin, rangeScale }
    const segments: Array<{ rowCount: number; rangeMin: number; rangeScale: number }> = [];
    const frozen = frozenSegmentsRef.current;

    // 活跃段
    const activeRows = Math.min(activeRowCountRef.current, actualHeight);
    const activeRange = currentMax - currentMin;
    segments.push({
      rowCount: activeRows,
      rangeMin: currentMin,
      rangeScale: activeRange > 0 ? 255 / activeRange : 1,
    });

    // 冻结段
    if (autoRange) {
      for (const seg of frozen) {
        const segRange = seg.range.max - seg.range.min;
        segments.push({
          rowCount: seg.rowCount,
          rangeMin: seg.range.min,
          rangeScale: segRange > 0 ? 255 / segRange : 1,
        });
      }
    }

    // 按段归一化数据行
    let index = 0;
    let rowOffset = 0;
    for (const seg of segments) {
      const segEnd = Math.min(rowOffset + seg.rowCount, actualHeight);
      for (let y = rowOffset; y < segEnd; y++) {
        const row = spectrumData[y];
        for (let x = 0; x < width; x++) {
          const normalizedValue = (row[x] - seg.rangeMin) * seg.rangeScale;
          textureData[index++] = Math.max(0, Math.min(255, Math.floor(normalizedValue)));
        }
      }
      rowOffset = segEnd;
      if (rowOffset >= actualHeight) break;
    }
    // 如果段总行数不足以覆盖所有数据行（理论上不应发生），用活跃范围补齐
    if (rowOffset < actualHeight) {
      const fallbackScale = activeRange > 0 ? 255 / activeRange : 1;
      for (let y = rowOffset; y < actualHeight; y++) {
        const row = spectrumData[y];
        for (let x = 0; x < width; x++) {
          const normalizedValue = (row[x] - currentMin) * fallbackScale;
          textureData[index++] = Math.max(0, Math.min(255, Math.floor(normalizedValue)));
        }
      }
    }
    // 底部填充行置 0（映射到颜色表最暗端）
    if (index < dataSize) {
      textureData.fill(0, index);
    }

    // 清理已完全滚出视图的冻结段
    if (frozen.length > 0) {
      const totalFrozenRows = frozen.reduce((sum, s) => sum + s.rowCount, 0);
      if (activeRows + totalFrozenRows > actualHeight) {
        // 从尾部裁剪超出的冻结段
        let remaining = actualHeight - activeRows;
        let keepCount = 0;
        for (const seg of frozen) {
          if (remaining <= 0) break;
          remaining -= seg.rowCount;
          keepCount++;
        }
        if (keepCount < frozen.length) {
          frozenSegmentsRef.current = frozen.slice(0, keepCount);
        }
      }
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, textureHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, textureData);

    // 只在纹理大小改变时设置参数
    if (lastDataLengthRef.current !== dataSize) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      lastDataLengthRef.current = dataSize;
    }
    };

    updateInternal();
  }, [minDb, maxDb, autoRange, calculateDataRange, isTransmitting]);

  // 渲染
  const render = useCallback(() => {
    const gl = glRef.current;
    const canvas = canvasRef.current;
    
    if (!gl || !canvas) return;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, []);

  // 处理canvas尺寸变化
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // 获取容器的实际尺寸
    const containerRect = container.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;

    // 使用容器的宽度和传入的height（通过 ref 读取，避免 handleResize 随 height 变化重建）
    const canvasWidth = containerRect.width;
    const canvasHeight = heightRef.current;

    // 防止零尺寸导致 WebGL 错误（布局切换时容器可能瞬间为 0）
    if (canvasWidth <= 0 || canvasHeight <= 0) return;
    
    // 只在尺寸真正改变时更新
    if (canvas.width === canvasWidth * pixelRatio && 
        canvas.height === canvasHeight * pixelRatio) {
      return;
    }
    
    canvas.width = canvasWidth * pixelRatio;
    canvas.height = canvasHeight * pixelRatio;
    
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    const gl = glRef.current;
    const program = programRef.current;
    
    if (gl && program && !gl.isContextLost()) {
      gl.useProgram(program);

      // 更新viewport
      gl.viewport(0, 0, canvas.width, canvas.height);
      
      // 更新分辨率uniform
      const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      
      // 重用已有的缓冲区，只更新数据
      const positions = new Float32Array([
        0, 0,
        canvas.width, 0,
        0, canvas.height,
        canvas.width, canvas.height,
      ]);

      if (positionBufferRef.current) {
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBufferRef.current);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        const positionLocation = gl.getAttribLocation(program, 'a_position');
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      }
      
      // 立即重新渲染
      render();
    }
  }, [render]);

  // 初始化（使用 useLayoutEffect 确保 WebGL 在浏览器绘制前完成初始化，避免黑帧闪烁）
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // WebGL context loss 处理
    const handleContextLost = (e: Event) => {
      e.preventDefault();
      logger.warn('WebGL context lost');
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
    };
    const handleContextRestored = () => {
      logger.info('WebGL context restored, reinitializing');
      if (initWebGL()) {
        handleResize();
        // 恢复后重新上传已有的纹理数据，避免显示黑屏
        if (dataRef.current.length > 0) {
          updateTexture(dataRef.current);
          render();
        }
      }
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    if (initWebGL()) {
      handleResize();
    }

    const resizeObserver = new ResizeObserver((_entries) => {
      // 防抖处理，避免频繁调用
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      animationRef.current = requestAnimationFrame(() => {
        handleResize();
      });
    });

    // 监听组件容器的尺寸变化
    const container = containerRef.current;
    if (container) {
      resizeObserver.observe(container);
    }

    return () => {
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      resizeObserver.disconnect();
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (scrollAnimRef.current) {
        cancelAnimationFrame(scrollAnimRef.current);
      }
      // 释放 WebGL 资源，防止泄漏
      const gl = glRef.current;
      if (gl) {
        if (programRef.current) { gl.deleteProgram(programRef.current); programRef.current = null; }
        if (textureRef.current) { gl.deleteTexture(textureRef.current); textureRef.current = null; }
        if (colorMapTextureRef.current) { gl.deleteTexture(colorMapTextureRef.current); colorMapTextureRef.current = null; }
        if (positionBufferRef.current) { gl.deleteBuffer(positionBufferRef.current); positionBufferRef.current = null; }
        if (texCoordBufferRef.current) { gl.deleteBuffer(texCoordBufferRef.current); texCoordBufferRef.current = null; }
      }
    };
  }, [initWebGL, handleResize]);

  // 数据更新时平滑滚动渲染
  useEffect(() => {
    dataRef.current = data;
    if (data.length === 0) return;

    // 取消之前的动画
    if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);

    // 上传纹理（每帧只做一次）
    updateTexture(data);

    // 帧间隔估算（EMA α=0.3，cap 500ms）
    const now = performance.now();
    if (lastDataTimeRef.current > 0) {
      const interval = Math.min(now - lastDataTimeRef.current, 500);
      frameIntervalRef.current = frameIntervalRef.current * 0.7 + interval * 0.3;
    }
    lastDataTimeRef.current = now;

    // 滚动动画参数
    const textureHeight = totalRows || data.length;
    const startOffset = 1.0 / textureHeight;
    const animDuration = Math.max(50, frameIntervalRef.current * 0.9);
    const animStartTime = now;

    // 先渲染一帧带初始偏移的画面（视觉上保持旧位置）
    const gl = glRef.current;
    const program = programRef.current;
    if (gl && program && !gl.isContextLost()) {
      gl.useProgram(program);
      gl.uniform1f(scrollOffsetLocationRef.current, startOffset);
      render();
    }

    // 启动平滑滚动动画
    const animate = () => {
      const elapsed = performance.now() - animStartTime;
      const progress = Math.min(1, elapsed / animDuration);
      // ease-out quadratic: 开始快，结束慢
      const eased = 1 - (1 - progress) * (1 - progress);
      const offset = startOffset * (1 - eased);

      const gl = glRef.current;
      const program = programRef.current;
      if (gl && program && !gl.isContextLost()) {
        gl.useProgram(program);
        gl.uniform1f(scrollOffsetLocationRef.current, offset);
        render();
      }

      if (progress < 1) {
        scrollAnimRef.current = requestAnimationFrame(animate);
      }
    };

    scrollAnimRef.current = requestAnimationFrame(animate);

    return () => {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
    };
  }, [data, updateTexture, render, totalRows]);

  useEffect(() => {
    if (data.length === 0) {
      resetAutoRangeState();
    }
  }, [data.length, resetAutoRangeState]);

  useEffect(() => {
    resetAutoRangeState();
  }, [
    autoRange,
    frequencies.length,
    frequencies[0],
    frequencies[frequencies.length - 1],
    resetAutoRangeState,
  ]);

  useEffect(() => {
    if (!autoRange) return;
    resetAutoRangeState();
  }, [
    autoRange,
    autoRangeConfig.updateInterval,
    autoRangeConfig.minPercentile,
    autoRangeConfig.maxPercentile,
    autoRangeConfig.rangeExpansionFactor,
    resetAutoRangeState,
  ]);

  // height属性变化时重新调整尺寸
  useEffect(() => {
    const timer = setTimeout(() => {
      handleResize();
    }, 0);

    return () => clearTimeout(timer);
  }, [height, handleResize]);

  // 监听 minDb 和 maxDb 变化，更新着色器 uniform（关键修复！）
  useEffect(() => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program) return;

    gl.useProgram(program);
    const minDbLocation = gl.getUniformLocation(program, 'u_minDb');
    const maxDbLocation = gl.getUniformLocation(program, 'u_maxDb');
    gl.uniform1f(minDbLocation, minDb);
    gl.uniform1f(maxDbLocation, maxDb);

    // 立即重新渲染以应用新的范围
    render();
  }, [minDb, maxDb, render]);


  if (!webglSupported || error) {
    const errorMessage = error === 'NOT_SUPPORTED' ? t('webgl.notSupported')
      : error === 'INIT_FAILED' ? t('webgl.initFailed', { message: t('webgl.unknownError') })
      : error ? t('webgl.initFailed', { message: error })
      : null;
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ height: `${height}px` }}>
        <div className="text-red-400 text-center">
          <div>{t('webgl.renderFailed')}</div>
          {errorMessage && <div className="text-sm mt-2">{errorMessage}</div>}
        </div>
      </div>
    );
  }

  const FREQ_POSITION_OFFSET = 15;
  const isAbsoluteDisplayMode = frequencyRangeMode === 'absolute-center' || frequencyRangeMode === 'absolute-fixed';

  const clampBasebandFrequency = useCallback((frequency: number) => {
    return Math.round(Math.max(basebandInteractionRange.min, Math.min(basebandInteractionRange.max, frequency)));
  }, [basebandInteractionRange.max, basebandInteractionRange.min]);

  const clampInteractionFrequency = useCallback((frequency: number) => {
    if (!interactionFrequencyRange) {
      return Math.round(frequency);
    }
    return Math.round(Math.max(interactionFrequencyRange.min, Math.min(interactionFrequencyRange.max, frequency)));
  }, [interactionFrequencyRange]);

  const getDisplayFrequency = useCallback((basebandFrequency: number) => {
    if (!frequencies || frequencies.length === 0) return null;
    if (isAbsoluteDisplayMode) {
      const referenceFrequency = referenceFrequencyHz ?? null;
      if (referenceFrequency === null) {
        return null;
      }
      return referenceFrequency + basebandFrequency;
    }
    return basebandFrequency;
  }, [frequencies, isAbsoluteDisplayMode, referenceFrequencyHz]);

  // 计算频率到位置的百分比
  const getFrequencyPosition = useCallback((displayFrequency: number) => {
    if (!frequencies || frequencies.length === 0) return 0;
    const minFreq = frequencies[0];
    const maxFreq = frequencies[frequencies.length - 1];
    if (maxFreq <= minFreq) return 0;
    return ((displayFrequency + FREQ_POSITION_OFFSET - minFreq) / (maxFreq - minFreq)) * 100;
  }, [frequencies]);

  const getMarkerPosition = useCallback((basebandFrequency: number) => {
    const displayFrequency = getDisplayFrequency(basebandFrequency);
    if (displayFrequency === null) return null;

    const position = getFrequencyPosition(displayFrequency);
    if (!Number.isFinite(position) || position < 0 || position > 100) {
      return null;
    }

    return position;
  }, [getDisplayFrequency, getFrequencyPosition]);

  // 从鼠标位置计算频率
  const getFrequencyFromMousePosition = useCallback((clientX: number) => {
    const container = containerRef.current;
    if (!container || !frequencies || frequencies.length === 0) return 0;

    const containerRect = container.getBoundingClientRect();
    const relativeX = clientX - containerRect.left;
    const percentage = Math.max(0, Math.min(1, relativeX / containerRect.width));

    const minFreq = frequencies[0];
    const maxFreq = frequencies[frequencies.length - 1];
    const displayFrequency = minFreq + percentage * (maxFreq - minFreq) - FREQ_POSITION_OFFSET;
    const basebandFrequency = isAbsoluteDisplayMode
      ? displayFrequency - (referenceFrequencyHz ?? minFreq)
      : displayFrequency;

    return clampBasebandFrequency(basebandFrequency);
  }, [clampBasebandFrequency, frequencies, isAbsoluteDisplayMode, referenceFrequencyHz]);

  const getInteractionFrequencyFromMousePosition = useCallback((clientX: number) => {
    const container = containerRef.current;
    if (!container || !frequencies || frequencies.length === 0) return 0;

    const containerRect = container.getBoundingClientRect();
    const relativeX = clientX - containerRect.left;
    const percentage = Math.max(0, Math.min(1, relativeX / containerRect.width));
    const minFreq = frequencies[0];
    const maxFreq = frequencies[frequencies.length - 1];
    const displayFrequency = minFreq + percentage * (maxFreq - minFreq) - FREQ_POSITION_OFFSET;

    if (interactionFrequencyMode === 'absolute') {
      return clampInteractionFrequency(displayFrequency);
    }

    return getFrequencyFromMousePosition(clientX);
  }, [clampInteractionFrequency, frequencies, getFrequencyFromMousePosition, interactionFrequencyMode]);

  // 拖动处理函数
  const handleMouseDown = useCallback((operatorId: string) => {
    // 如果有正在进行的冷却，先清除
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
    setCooldownOperatorId(null);
    setDraggingOperatorId(operatorId);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingOperatorId || !onTxFrequencyChange) return;

    const newFrequency = getFrequencyFromMousePosition(e.clientX);

    // 乐观更新：立即更新本地位置
    setLocalFrequencyOverride({ operatorId: draggingOperatorId, frequency: newFrequency });
    latestDragFrequencyRef.current = { operatorId: draggingOperatorId, frequency: newFrequency };

    // 200ms 防抖发送到服务端
    if (dragDebounceRef.current) clearTimeout(dragDebounceRef.current);
    dragDebounceRef.current = setTimeout(() => {
      const latest = latestDragFrequencyRef.current;
      if (latest && onTxFrequencyChange) {
        onTxFrequencyChange(latest.operatorId, latest.frequency);
      }
    }, 200);
  }, [draggingOperatorId, onTxFrequencyChange, getFrequencyFromMousePosition]);

  const handleBandOverlayMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingBandOverlayId || !onTxBandOverlayFrequencyChange) return;

    const newFrequency = getInteractionFrequencyFromMousePosition(e.clientX);
    setLocalBandOverlayOverride({ id: draggingBandOverlayId, frequency: newFrequency });
    latestBandOverlayFrequencyRef.current = { id: draggingBandOverlayId, frequency: newFrequency };

    if (dragDebounceRef.current) clearTimeout(dragDebounceRef.current);
    dragDebounceRef.current = setTimeout(() => {
      const latest = latestBandOverlayFrequencyRef.current;
      if (latest && onTxBandOverlayFrequencyChange) {
        onTxBandOverlayFrequencyChange(latest.id, latest.frequency);
      }
    }, 200);
  }, [draggingBandOverlayId, getInteractionFrequencyFromMousePosition, onTxBandOverlayFrequencyChange]);

  const handleMouseUp = useCallback(() => {
    if (!draggingOperatorId) return;

    // 清除防抖，立即 flush 最新值
    if (dragDebounceRef.current) {
      clearTimeout(dragDebounceRef.current);
      dragDebounceRef.current = null;
    }
    const latest = latestDragFrequencyRef.current;
    if (latest && onTxFrequencyChange) {
      onTxFrequencyChange(latest.operatorId, latest.frequency);
    }

    // 进入 500ms 冷却期（保留 localFrequencyOverride 防止闪回）
    const opId = draggingOperatorId;
    setDraggingOperatorId(null);
    setCooldownOperatorId(opId);
    cooldownTimerRef.current = setTimeout(() => {
      setCooldownOperatorId(null);
      setLocalFrequencyOverride(null);
      latestDragFrequencyRef.current = null;
      cooldownTimerRef.current = null;
    }, 500);
  }, [draggingOperatorId, onTxFrequencyChange]);

  const handleBandOverlayMouseUp = useCallback(() => {
    if (!draggingBandOverlayId) return;

    if (dragDebounceRef.current) {
      clearTimeout(dragDebounceRef.current);
      dragDebounceRef.current = null;
    }

    const latest = latestBandOverlayFrequencyRef.current;
    if (latest && onTxBandOverlayFrequencyChange) {
      onTxBandOverlayFrequencyChange(latest.id, latest.frequency);
    }

    const overlayId = draggingBandOverlayId;
    setDraggingBandOverlayId(null);
    setCooldownBandOverlayId(overlayId);
    cooldownTimerRef.current = setTimeout(() => {
      setCooldownBandOverlayId(null);
      setLocalBandOverlayOverride(null);
      latestBandOverlayFrequencyRef.current = null;
      cooldownTimerRef.current = null;
    }, 500);
  }, [draggingBandOverlayId, onTxBandOverlayFrequencyChange]);

  // 监听拖动事件
  useEffect(() => {
    if (draggingOperatorId) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [draggingOperatorId, handleMouseMove, handleMouseUp]);

  useEffect(() => {
    if (draggingBandOverlayId) {
      document.addEventListener('mousemove', handleBandOverlayMouseMove);
      document.addEventListener('mouseup', handleBandOverlayMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleBandOverlayMouseMove);
        document.removeEventListener('mouseup', handleBandOverlayMouseUp);
      };
    }
  }, [draggingBandOverlayId, handleBandOverlayMouseMove, handleBandOverlayMouseUp]);

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      onContextMenu={(e) => {
        if (onRightClickSetFrequency) {
          e.preventDefault();
          const frequency = getInteractionFrequencyFromMousePosition(e.clientX);
          onRightClickSetFrequency(frequency);
        }
      }}
    >
      <canvas
        ref={canvasRef}
        className="w-full"
        style={{ height: `${height}px` }}
      />

      {/* 频率标记层 */}
      <div className="absolute inset-0 pointer-events-none">
        {/* TX标记 - 红色 */}
        {txBandOverlays.map((overlay) => {
          const isOverridden = localBandOverlayOverride?.id === overlay.id
            && (draggingBandOverlayId === overlay.id || cooldownBandOverlayId === overlay.id);
          const lineFrequency = isOverridden ? localBandOverlayOverride!.frequency : overlay.lineFrequency;
          const deltaStart = overlay.rangeStartFrequency - overlay.lineFrequency;
          const deltaEnd = overlay.rangeEndFrequency - overlay.lineFrequency;
          const effectiveStart = lineFrequency + deltaStart;
          const effectiveEnd = lineFrequency + deltaEnd;
          const linePosition = getFrequencyPosition(lineFrequency);
          const startPosition = getFrequencyPosition(Math.min(effectiveStart, effectiveEnd));
          const endPosition = getFrequencyPosition(Math.max(effectiveStart, effectiveEnd));

          if (!Number.isFinite(linePosition) || !Number.isFinite(startPosition) || !Number.isFinite(endPosition)) {
            return null;
          }
          if (endPosition < 0 || startPosition > 100) {
            return null;
          }

          const clippedLeft = Math.max(0, startPosition);
          const clippedRight = Math.min(100, endPosition);
          const width = Math.max(0, clippedRight - clippedLeft);
          const draggable = overlay.draggable && !!onTxBandOverlayFrequencyChange;
          const isDragging = draggingBandOverlayId === overlay.id;

          return (
            <div
              key={`tx-band-${overlay.id}`}
              className="absolute inset-0 h-full pointer-events-none"
            >
              {width > 0 && (
                <div
                  className="absolute top-0 h-full bg-red-500/15"
                  style={{
                    left: `${clippedLeft}%`,
                    width: `${width}%`,
                  }}
                />
              )}
              <div
                className={`absolute top-0 h-full pointer-events-auto transition-opacity ${draggable ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
                style={{ left: `${linePosition}%`, transform: 'translateX(-50%)' }}
                onMouseDown={draggable ? () => {
                  if (cooldownTimerRef.current) {
                    clearTimeout(cooldownTimerRef.current);
                    cooldownTimerRef.current = null;
                  }
                  setCooldownBandOverlayId(null);
                  setDraggingBandOverlayId(overlay.id);
                } : undefined}
              >
                <div className={`w-0.5 h-full ${isDragging ? 'bg-red-500' : 'bg-red-500/50'}`} />
                <div className="absolute bottom-1 left-1/2 -translate-x-1/2 px-1 text-xs font-semibold bg-black/60 rounded text-red-500 select-none">
                  {overlay.label}
                </div>
              </div>
            </div>
          );
        })}

        {txFrequencies.map(({ operatorId, frequency, callsign }) => {
          // 拖动中或冷却期：使用本地覆盖频率
          const isOverridden = localFrequencyOverride?.operatorId === operatorId &&
            (draggingOperatorId === operatorId || cooldownOperatorId === operatorId);
          const displayFrequency = isOverridden ? localFrequencyOverride!.frequency : frequency;
          const position = getMarkerPosition(displayFrequency);
          if (position === null) {
            return null;
          }
          const isDragging = draggingOperatorId === operatorId;
          const showPopover = txFrequencies.length > 1;
          const isHovered = hoveredTxOperatorId === operatorId;

          const markerElement = (
            <div
              key={`tx-${operatorId}`}
              className={`absolute top-0 h-full pointer-events-auto transition-opacity ${isDragging ? 'cursor-grabbing' : 'cursor-grab'} ${showPopover ? 'hover:opacity-80' : ''}`}
              style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
              onMouseDown={() => {
                setHoveredTxOperatorId(null);
                handleMouseDown(operatorId);
              }}
              onMouseEnter={showPopover ? () => setHoveredTxOperatorId(operatorId) : undefined}
              onMouseLeave={showPopover ? () => setHoveredTxOperatorId(null) : undefined}
            >
              <div className={`w-0.5 h-full ${isDragging ? 'bg-red-500' : 'bg-red-500/50'}`} />
              <div
                className="absolute bottom-1 left-1/2 -translate-x-1/2 px-1 text-xs font-semibold bg-black/60 rounded text-red-500 select-none"
              >
                TX
              </div>
            </div>
          );

          if (!showPopover) return markerElement;

          return (
            <Popover
              key={`tx-${operatorId}`}
              placement="bottom"
              isOpen={isHovered && !isDragging}
              onOpenChange={(open) => {
                if (!open) setHoveredTxOperatorId(null);
              }}
            >
              <PopoverTrigger>
                {markerElement}
              </PopoverTrigger>
              <PopoverContent
                onMouseEnter={() => setHoveredTxOperatorId(operatorId)}
                onMouseLeave={() => setHoveredTxOperatorId(null)}
              >
                <div className="px-2 py-1">
                  <div className="text-sm font-semibold">{callsign}</div>
                  <div className="text-xs text-default-400">
                    {frequency} Hz
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          );
        })}

        {/* RX标记 - 绿色，带Popover (hover触发) */}
        {rxFrequencies.map(({ callsign, frequency }) => {
          const position = getMarkerPosition(frequency);
          if (position === null) {
            return null;
          }
          const isOpen = hoveredRxCallsign === callsign;
          return (
            <Popover
              key={`rx-${callsign}`}
              placement="bottom"
              isOpen={isOpen}
              onOpenChange={(open) => {
                if (!open) setHoveredRxCallsign(null);
              }}
            >
              <PopoverTrigger>
                <div
                  className="absolute top-0 h-full pointer-events-auto cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
                  onMouseEnter={() => setHoveredRxCallsign(callsign)}
                  onMouseLeave={() => setHoveredRxCallsign(null)}
                >
                  <div className="w-0.5 h-full bg-green-500/50" />
                  <div
                    className="absolute bottom-1 left-1/2 -translate-x-1/2 px-1 text-xs font-semibold bg-black/60 rounded text-green-500 select-none"
                  >
                    RX
                  </div>
                </div>
              </PopoverTrigger>
              <PopoverContent
                onMouseEnter={() => setHoveredRxCallsign(callsign)}
                onMouseLeave={() => setHoveredRxCallsign(null)}
              >
                <div className="px-2 py-1">
                  <div className="text-sm font-semibold">{callsign}</div>
                  <div className="text-xs text-default-400">
                    {frequency.toFixed(0)} Hz
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          );
        })}

        {/* Hover消息频率线 - 淡白色 */}
        {hoverFrequency !== null && hoverFrequency !== undefined && getMarkerPosition(hoverFrequency) !== null && (
          <div
            className="absolute top-0 h-full pointer-events-none"
            style={{ left: `${getMarkerPosition(hoverFrequency)}%`, transform: 'translateX(-50%)' }}
          >
            <div className="w-0.5 h-full bg-white/30" />
          </div>
        )}
      </div>

      {autoRange && actualRange && (
        <div style={{ display: 'none' }} className="absolute top-2 right-2 text-xs text-white bg-black bg-opacity-50 px-2 py-1 rounded">
          {t('spectrum.currentRange', { min: actualRange.min.toFixed(1), max: actualRange.max.toFixed(1) })}
        </div>
      )}
    </div>
  );
}; 
