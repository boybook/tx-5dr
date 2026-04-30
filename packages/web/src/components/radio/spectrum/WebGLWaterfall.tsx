import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../../utils/logger';
import type { SpectrumAxis, SpectrumRenderBatch, SpectrumStreamController } from '../../../spectrum/SpectrumStreamController';
import {
  buildSpectrumThemeColorLut,
  DEFAULT_SPECTRUM_THEME_ID,
  getSafeSpectrumThemeCurve,
  type SpectrumThemeId,
} from './spectrumThemes';

const logger = createLogger('WebGLWaterfall');

export interface AutoRangeConfig {
  updateInterval: number;      // 更新频率（帧数），默认10
  minPercentile: number;        // 最小值百分位数（0-100），默认15
  maxPercentile: number;        // 最大值百分位数（0-100），默认99
  rangeExpansionFactor: number; // 范围扩展因子，默认4.0
}

export interface RxFrequency {
  operatorId: string;
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

export interface PresetMarker {
  id: string;
  frequency: number;
  label: string;
  description?: string | null;
  clickable?: boolean;
}

interface WebGLWaterfallProps {
  controller: SpectrumStreamController;
  className?: string;
  height?: number;
  minDb?: number;
  maxDb?: number;
  autoRange?: boolean;
  autoRangeConfig?: AutoRangeConfig;
  rxFrequencies?: RxFrequency[];
  txFrequencies?: TxFrequency[];
  txBandOverlays?: TxBandOverlay[];
  presetMarkers?: PresetMarker[];
  frequencyRangeMode?: 'baseband' | 'absolute-center' | 'absolute-fixed' | 'absolute-windowed';
  referenceFrequencyHz?: number | null;
  basebandInteractionRange?: BasebandInteractionRange;
  interactionFrequencyMode?: 'baseband' | 'absolute';
  interactionFrequencyRange?: InteractionFrequencyRange | null;
  interactionFrequencyStepHz?: number | null;
  onTxFrequencyChange?: (operatorId: string, frequency: number) => void;
  onTxBandOverlayFrequencyChange?: (id: string, frequency: number) => void;
  onPresetMarkerClick?: (frequency: number) => void;
  onDragFrequencyChange?: (frequency: number) => void;
  onDoubleClickSetFrequency?: (frequency: number) => void;
  onRightClickSetFrequency?: (frequency: number) => void;
  onActualRangeChange?: (range: { min: number; max: number } | null) => void;
  hoverFrequency?: number | null;
  markerAxis?: SpectrumAxis | null;
  markerOnly?: boolean;
  /** 纹理总行数，不足时底部用暗色填充，实现从顶部逐渐填充的效果 */
  totalRows?: number;
  /** 当前是否处于发射状态，用于 TX/RX 自动范围分离 */
  isTransmitting?: boolean;
  /** 瀑布图颜色和强度曲线主题 */
  themeId?: SpectrumThemeId;
}

const FREQUENCY_GESTURE_DRAG_THRESHOLD_PX = 4;

function areAxesEqual(left: SpectrumAxis | null, right: SpectrumAxis | null): boolean {
  return Boolean(
    left
    && right
    && left.minHz === right.minHz
    && left.maxHz === right.maxHz
    && left.binCount === right.binCount
  ) || (left === null && right === null);
}

type MutableRef<T> = { current: T };

export interface WaterfallTextureMemoryRefs {
  textureDataRef: MutableRef<Uint8Array | null>;
  lastDataLengthRef: MutableRef<number>;
  textureHeightRef: MutableRef<number>;
  rowCountRef: MutableRef<number>;
  headRowRef: MutableRef<number>;
}

export function releaseWaterfallTextureMemoryRefs(refs: WaterfallTextureMemoryRefs): void {
  refs.textureDataRef.current = null;
  refs.lastDataLengthRef.current = 0;
  refs.textureHeightRef.current = 1;
  refs.rowCountRef.current = 0;
  refs.headRowRef.current = 0;
}

export const WebGLWaterfall: React.FC<WebGLWaterfallProps> = ({
  controller,
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
  presetMarkers = [],
  frequencyRangeMode = 'baseband',
  referenceFrequencyHz = null,
  basebandInteractionRange = { min: 0, max: 3000 },
  interactionFrequencyMode = 'baseband',
  interactionFrequencyRange = null,
  interactionFrequencyStepHz = null,
  onTxFrequencyChange,
  onTxBandOverlayFrequencyChange,
  onPresetMarkerClick,
  onDragFrequencyChange,
  onDoubleClickSetFrequency,
  onRightClickSetFrequency,
  onActualRangeChange,
  hoverFrequency,
  markerAxis = null,
  markerOnly = false,
  totalRows,
  isTransmitting = false,
  themeId = DEFAULT_SPECTRUM_THEME_ID,
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
  const [viewState, setViewState] = React.useState<{ axis: SpectrumAxis | null; hasData: boolean }>({
    axis: null,
    hasData: false,
  });
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
  const [frequencyGestureDragState, setFrequencyGestureDragState] = React.useState<{
    startX: number;
    startFrequency: number;
    hzPerPixel: number;
    hasExceededThreshold: boolean;
  } | null>(null);
  const [localGestureFrequencyOverride, setLocalGestureFrequencyOverride] = React.useState<number | null>(null);
  const gestureDragDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const gestureCooldownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const latestGestureFrequencyRef = useRef<number | null>(null);

  // RX Popover hover状态
  const [hoveredRxMarkerId, setHoveredRxMarkerId] = React.useState<string | null>(null);
  const [hoveredPresetMarkerId, setHoveredPresetMarkerId] = React.useState<string | null>(null);

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
  const colorMapRef = useRef<Uint8Array>(buildSpectrumThemeColorLut(DEFAULT_SPECTRUM_THEME_ID));
  const themeCurveRef = useRef(getSafeSpectrumThemeCurve(DEFAULT_SPECTRUM_THEME_ID));
  // TX/RX 自动范围分离：多段冻结机制
  // 每个冻结段记录一段历史行的行数和对应的范围
  const frozenSegmentsRef = useRef<Array<{ rowCount: number; range: { min: number; max: number } }>>([]);
  const activeRowCountRef = useRef<number>(0); // 当前状态已累积的行数
  const prevTransmittingRef = useRef<boolean | undefined>(undefined);
  const displayRowsRef = useRef<ArrayLike<number>[]>([]);
  const headRowRef = useRef<number>(0);
  const rowCountRef = useRef<number>(0);
  // 平滑滚动相关
  const headRowLocationRef = useRef<WebGLUniformLocation | null>(null);
  const textureHeightLocationRef = useRef<WebGLUniformLocation | null>(null);
  const scrollRowsLocationRef = useRef<WebGLUniformLocation | null>(null);
  const scrollAnimRef = useRef<number>();
  const lastDataTimeRef = useRef(0);
  const frameIntervalRef = useRef(100);
  const lastAnimatedFrameTokenRef = useRef<string | number | null>(null);
  const currentAxisRef = useRef<SpectrumAxis | null>(null);
  const textureHeightRef = useRef<number>(Math.max(totalRows ?? 0, 1));
  const renderRef = useRef<() => void>(() => {});
  const handleResizeRef = useRef<() => void>(() => {});
  const rebuildTextureRef = useRef<(rows: ArrayLike<number>[], axis: SpectrumAxis | null) => void>(() => {});
  const processRenderBatchRef = useRef<(batch: SpectrumRenderBatch | null) => void>(() => {});
  const axis = viewState.axis ?? markerAxis;

  const resetAutoRangeState = useCallback(() => {
    rangeUpdateCounterRef.current = 0;
    cachedRangeRef.current = null;
    actualRangeRef.current = null;
    frozenSegmentsRef.current = [];
    activeRowCountRef.current = 0;
    setActualRange(null);
    onActualRangeChange?.(null);
  }, [onActualRangeChange]);

  // 优化后的数据范围计算 - 使用采样和缓存
  // 当存在冻结段时，只从活跃行（当前状态）采样
  const calculateDataRange = useCallback((spectrumData: ArrayLike<number>[]) => {
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

  const colorMap = useMemo(() => buildSpectrumThemeColorLut(themeId), [themeId]);
  const themeCurve = useMemo(() => getSafeSpectrumThemeCurve(themeId), [themeId]);
  colorMapRef.current = colorMap;
  themeCurveRef.current = themeCurve;

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
    uniform float u_headRow;
    uniform float u_textureHeight;
    uniform float u_scrollRows;
    uniform float u_themeGamma;
    uniform float u_themeContrast;
    uniform float u_themeBias;

    varying vec2 v_texCoord;

    void main() {
      float textureHeight = max(u_textureHeight, 1.0);
      // Map the vertical edge to the last texel row instead of wrapping back to the top.
      float rowSpan = max(textureHeight - 1.0, 0.0);
      float sourceRow = mod(u_headRow + v_texCoord.y * rowSpan + u_scrollRows, textureHeight);
      float sourceY = (sourceRow + 0.5) / textureHeight;
      float value = texture2D(u_texture, vec2(v_texCoord.x, sourceY)).r;
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
      
      // Apply the selected theme tone curve without touching the source spectrum data.
      normalized = clamp((normalized - 0.5) * max(u_themeContrast, 0.01) + 0.5 + u_themeBias, 0.0, 1.0);
      normalized = pow(normalized, max(u_themeGamma, 0.01));
      
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

  const uploadColorMapTexture = useCallback((
    gl: WebGLRenderingContext,
    texture: WebGLTexture,
    colorMapData: Uint8Array
  ) => {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colorMapData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }, []);

  const applyThemeCurveUniforms = useCallback((
    gl: WebGLRenderingContext,
    program: WebGLProgram,
    curve: { gamma: number; contrast: number; bias: number }
  ) => {
    gl.useProgram(program);
    gl.uniform1f(gl.getUniformLocation(program, 'u_themeGamma'), curve.gamma);
    gl.uniform1f(gl.getUniformLocation(program, 'u_themeContrast'), curve.contrast);
    gl.uniform1f(gl.getUniformLocation(program, 'u_themeBias'), curve.bias);
  }, []);

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
      uploadColorMapTexture(gl, colorMapTexture, colorMapRef.current);
      applyThemeCurveUniforms(gl, program, themeCurveRef.current);

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

      headRowLocationRef.current = gl.getUniformLocation(program, 'u_headRow');
      textureHeightLocationRef.current = gl.getUniformLocation(program, 'u_textureHeight');
      scrollRowsLocationRef.current = gl.getUniformLocation(program, 'u_scrollRows');
      gl.uniform1f(headRowLocationRef.current, 0.0);
      gl.uniform1f(textureHeightLocationRef.current, textureHeightRef.current);
      gl.uniform1f(scrollRowsLocationRef.current, 0.0);

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
  }, [applyThemeCurveUniforms, createProgram, uploadColorMapTexture]);

  // 渲染
  const render = useCallback(() => {
    const gl = glRef.current;
    const canvas = canvasRef.current;
    
    if (!gl || !canvas) return;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, []);

  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  useEffect(() => {
    const gl = glRef.current;
    const program = programRef.current;
    const colorMapTexture = colorMapTextureRef.current;
    if (!gl || !program || !colorMapTexture || gl.isContextLost()) {
      return;
    }

    uploadColorMapTexture(gl, colorMapTexture, colorMap);
    applyThemeCurveUniforms(gl, program, themeCurve);
    render();
  }, [applyThemeCurveUniforms, colorMap, render, themeCurve, uploadColorMapTexture]);

  const updateViewState = useCallback((nextAxis: SpectrumAxis | null, hasData: boolean) => {
    currentAxisRef.current = nextAxis;
    setViewState(current => {
      if (current.hasData === hasData && areAxesEqual(current.axis, nextAxis)) {
        return current;
      }
      return {
        axis: nextAxis,
        hasData,
      };
    });
  }, []);

  const updateActualRangeState = useCallback((range: { min: number; max: number } | null) => {
    if (range === null) {
      if (actualRangeRef.current !== null) {
        actualRangeRef.current = null;
        setActualRange(null);
        onActualRangeChange?.(null);
      }
      return;
    }

    if (
      actualRangeRef.current
      && Math.abs(actualRangeRef.current.min - range.min) <= 0.5
      && Math.abs(actualRangeRef.current.max - range.max) <= 0.5
    ) {
      return;
    }

    actualRangeRef.current = range;
    setActualRange(range);
    onActualRangeChange?.(range);
  }, [onActualRangeChange]);

  const writeNormalizedRow = useCallback((
    target: Uint8Array,
    rowIndex: number,
    row: ArrayLike<number>,
    width: number,
    rangeMin: number,
    rangeScale: number
  ) => {
    const start = rowIndex * width;
    for (let x = 0; x < width; x += 1) {
      const normalizedValue = (row[x] - rangeMin) * rangeScale;
      target[start + x] = Math.max(0, Math.min(255, Math.floor(normalizedValue)));
    }
  }, []);

  const updateTextureMetadata = useCallback((textureHeight: number, headRow: number) => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost()) {
      return;
    }

    textureHeightRef.current = textureHeight;
    headRowRef.current = headRow;
    gl.useProgram(program);
    if (headRowLocationRef.current) {
      gl.uniform1f(headRowLocationRef.current, headRow);
    }
    if (textureHeightLocationRef.current) {
      gl.uniform1f(textureHeightLocationRef.current, textureHeight);
    }
  }, []);

  const buildSegments = useCallback((actualHeight: number, currentMin: number, currentMax: number) => {
    const segments: Array<{ rowCount: number; rangeMin: number; rangeScale: number }> = [];
    const frozen = frozenSegmentsRef.current;
    const activeRows = Math.min(activeRowCountRef.current, actualHeight);
    const activeRange = currentMax - currentMin;

    segments.push({
      rowCount: activeRows,
      rangeMin: currentMin,
      rangeScale: activeRange > 0 ? 255 / activeRange : 1,
    });

    if (autoRange) {
      for (const segment of frozen) {
        const frozenRange = segment.range.max - segment.range.min;
        segments.push({
          rowCount: segment.rowCount,
          rangeMin: segment.range.min,
          rangeScale: frozenRange > 0 ? 255 / frozenRange : 1,
        });
      }
    }

    if (frozen.length > 0) {
      const totalFrozenRows = frozen.reduce((sum, segment) => sum + segment.rowCount, 0);
      if (activeRows + totalFrozenRows > actualHeight) {
        let remaining = actualHeight - activeRows;
        let keepCount = 0;
        for (const segment of frozen) {
          if (remaining <= 0) {
            break;
          }
          remaining -= segment.rowCount;
          keepCount += 1;
        }
        if (keepCount < frozen.length) {
          frozenSegmentsRef.current = frozen.slice(0, keepCount);
        }
      }
    }

    return segments;
  }, [autoRange]);

  const rebuildTexture = useCallback((spectrumData: ArrayLike<number>[], nextAxis: SpectrumAxis | null) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    const width = nextAxis?.binCount ?? spectrumData[0]?.length ?? 0;

    if (!gl || !texture || !program || gl.isContextLost() || width <= 0) {
      return;
    }

    const actualHeight = spectrumData.length;
    const textureHeight = totalRows ? Math.max(actualHeight, totalRows) : Math.max(actualHeight, 1);
    const dataSize = width * textureHeight;

    if (!textureDataRef.current || textureDataRef.current.length !== dataSize) {
      textureDataRef.current = new Uint8Array(dataSize);
    }
    const textureData = textureDataRef.current;
    textureData.fill(0);

    let currentMin = minDb;
    let currentMax = maxDb;

    if (autoRange && actualHeight > 0) {
      const range = calculateDataRange(spectrumData);
      currentMin = range.min;
      currentMax = range.max;
      updateActualRangeState(range);
    } else if (!autoRange) {
      updateActualRangeState(null);
    }

    const segments = buildSegments(actualHeight, currentMin, currentMax);
    const fallbackScale = currentMax > currentMin ? 255 / (currentMax - currentMin) : 1;

    let rowOffset = 0;
    for (const segment of segments) {
      const segmentEnd = Math.min(rowOffset + segment.rowCount, actualHeight);
      for (let y = rowOffset; y < segmentEnd; y += 1) {
        writeNormalizedRow(textureData, y, spectrumData[y], width, segment.rangeMin, segment.rangeScale);
      }
      rowOffset = segmentEnd;
      if (rowOffset >= actualHeight) {
        break;
      }
    }

    for (let y = rowOffset; y < actualHeight; y += 1) {
      writeNormalizedRow(textureData, y, spectrumData[y], width, currentMin, fallbackScale);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, textureHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, textureData);

    if (lastDataLengthRef.current !== dataSize) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      lastDataLengthRef.current = dataSize;
    }

    rowCountRef.current = actualHeight;
    updateTextureMetadata(textureHeight, 0);
  }, [
    autoRange,
    buildSegments,
    calculateDataRange,
    minDb,
    maxDb,
    totalRows,
    updateActualRangeState,
    updateTextureMetadata,
    writeNormalizedRow,
  ]);

  useEffect(() => {
    rebuildTextureRef.current = rebuildTexture;
  }, [rebuildTexture]);

  const releaseTextureStorage = useCallback((shouldRender = true) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    releaseWaterfallTextureMemoryRefs({
      textureDataRef,
      lastDataLengthRef,
      textureHeightRef,
      rowCountRef,
      headRowRef,
    });

    if (!gl || !texture || gl.isContextLost()) {
      return;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1));

    if (program && scrollRowsLocationRef.current) {
      gl.useProgram(program);
      gl.uniform1f(scrollRowsLocationRef.current, 0);
    }
    if (program && headRowLocationRef.current) {
      gl.useProgram(program);
      gl.uniform1f(headRowLocationRef.current, 0);
    }
    if (program && textureHeightLocationRef.current) {
      gl.useProgram(program);
      gl.uniform1f(textureHeightLocationRef.current, 1);
    }
    if (shouldRender) {
      render();
    }
  }, [render]);

  const appendRowsToTexture = useCallback((rowsToAppend: ArrayLike<number>[], nextAxis: SpectrumAxis | null) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    const width = nextAxis?.binCount ?? rowsToAppend[rowsToAppend.length - 1]?.length ?? 0;

    if (!gl || !texture || !program || gl.isContextLost() || width <= 0 || rowsToAppend.length === 0) {
      return;
    }

    const spectrumData = displayRowsRef.current;
    const actualHeight = spectrumData.length;
    const previousTextureHeight = textureHeightRef.current;
    const textureHeight = totalRows ? Math.max(actualHeight, totalRows) : Math.max(actualHeight, 1);
    const dataSize = width * textureHeight;

    if (!textureDataRef.current || textureDataRef.current.length !== dataSize) {
      textureDataRef.current = new Uint8Array(dataSize);
    }
    const textureData = textureDataRef.current;

    let txModeChanged = false;
    if (autoRange && isTransmitting !== prevTransmittingRef.current && prevTransmittingRef.current !== undefined) {
      if (cachedRangeRef.current && activeRowCountRef.current > 0) {
        frozenSegmentsRef.current.unshift({
          rowCount: activeRowCountRef.current,
          range: { ...cachedRangeRef.current },
        });
      }
      cachedRangeRef.current = null;
      rangeUpdateCounterRef.current = 0;
      activeRowCountRef.current = 0;
      txModeChanged = true;
    }
    prevTransmittingRef.current = isTransmitting;
    activeRowCountRef.current = Math.min(actualHeight, activeRowCountRef.current + rowsToAppend.length);

    let currentMin = minDb;
    let currentMax = maxDb;
    let rangeChanged = false;

    if (autoRange) {
      const range = calculateDataRange(spectrumData);
      currentMin = range.min;
      currentMax = range.max;
      rangeChanged = !actualRangeRef.current
        || Math.abs(actualRangeRef.current.min - currentMin) > 0.5
        || Math.abs(actualRangeRef.current.max - currentMax) > 0.5;
      updateActualRangeState(range);
    } else {
      updateActualRangeState(null);
    }

    if (txModeChanged || rangeChanged || previousTextureHeight !== textureHeight || rowCountRef.current === 0) {
      rebuildTexture(spectrumData, nextAxis);
      return;
    }

    const rangeScale = currentMax > currentMin ? 255 / (currentMax - currentMin) : 1;
    let headRow = headRowRef.current;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    for (const row of rowsToAppend) {
      headRow = (headRow - 1 + textureHeight) % textureHeight;
      writeNormalizedRow(textureData, headRow, row, width, currentMin, rangeScale);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        headRow,
        width,
        1,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        textureData.subarray(headRow * width, (headRow + 1) * width)
      );
    }

    rowCountRef.current = Math.min(textureHeight, rowCountRef.current + rowsToAppend.length);
    updateTextureMetadata(textureHeight, headRow);
  }, [
    autoRange,
    calculateDataRange,
    isTransmitting,
    minDb,
    maxDb,
    rebuildTexture,
    totalRows,
    updateActualRangeState,
    updateTextureMetadata,
    writeNormalizedRow,
  ]);

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

  useEffect(() => {
    handleResizeRef.current = handleResize;
  }, [handleResize]);

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
        handleResizeRef.current();
        // 恢复后重新上传已有的纹理数据，避免显示黑屏
        if (displayRowsRef.current.length > 0) {
          rebuildTextureRef.current(displayRowsRef.current, currentAxisRef.current);
          renderRef.current();
        }
      }
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    if (initWebGL()) {
      handleResizeRef.current();
    }

    const resizeObserver = new ResizeObserver((_entries) => {
      // 防抖处理，避免频繁调用
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      animationRef.current = requestAnimationFrame(() => {
        handleResizeRef.current();
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
        releaseTextureStorage(false);
        if (programRef.current) { gl.deleteProgram(programRef.current); programRef.current = null; }
        if (textureRef.current) { gl.deleteTexture(textureRef.current); textureRef.current = null; }
        if (colorMapTextureRef.current) { gl.deleteTexture(colorMapTextureRef.current); colorMapTextureRef.current = null; }
        if (positionBufferRef.current) { gl.deleteBuffer(positionBufferRef.current); positionBufferRef.current = null; }
        if (texCoordBufferRef.current) { gl.deleteBuffer(texCoordBufferRef.current); texCoordBufferRef.current = null; }
        try {
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch (error) {
          logger.debug('WEBGL_lose_context cleanup failed', error);
        }
        glRef.current = null;
      }
    };
  }, [initWebGL, releaseTextureStorage]);

  const processRenderBatch = useCallback((batch: SpectrumRenderBatch | null) => {
    if (!batch) {
      return;
    }

    if (scrollAnimRef.current) {
      cancelAnimationFrame(scrollAnimRef.current);
    }

    if (batch.mode === 'reset' || batch.rows.length === 0 || !batch.axis) {
      displayRowsRef.current = [];
      rowCountRef.current = 0;
      headRowRef.current = 0;
      lastAnimatedFrameTokenRef.current = null;
      lastDataTimeRef.current = 0;
      updateViewState(null, false);
      resetAutoRangeState();
      releaseTextureStorage();
      return;
    }

    const nextAxis = batch.axis;
    const maxRows = totalRows ?? batch.rows.length;

    if (batch.mode === 'replace') {
      displayRowsRef.current = batch.rows.slice(0, maxRows);
      rowCountRef.current = displayRowsRef.current.length;
      headRowRef.current = 0;
      lastAnimatedFrameTokenRef.current = batch.frameToken;
      rebuildTexture(displayRowsRef.current, nextAxis);
      updateViewState(nextAxis, true);

      const gl = glRef.current;
      const program = programRef.current;
      if (gl && program && !gl.isContextLost() && scrollRowsLocationRef.current) {
        gl.useProgram(program);
        gl.uniform1f(scrollRowsLocationRef.current, 0);
      }
      render();
      return;
    }

    for (let index = 0; index < batch.rows.length; index += 1) {
      displayRowsRef.current.unshift(batch.rows[index]);
    }
    if (displayRowsRef.current.length > maxRows) {
      displayRowsRef.current.length = maxRows;
    }

    appendRowsToTexture(batch.rows, nextAxis);
    updateViewState(nextAxis, true);

    const shouldAnimateScroll = batch.frameToken !== null && batch.frameToken !== lastAnimatedFrameTokenRef.current;
    lastAnimatedFrameTokenRef.current = batch.frameToken;

    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program || gl.isContextLost() || !scrollRowsLocationRef.current) {
      return;
    }

    if (!shouldAnimateScroll) {
      gl.useProgram(program);
      gl.uniform1f(scrollRowsLocationRef.current, 0);
      render();
      return;
    }

    const now = performance.now();
    if (lastDataTimeRef.current > 0) {
      const interval = Math.min(now - lastDataTimeRef.current, 500);
      frameIntervalRef.current = frameIntervalRef.current * 0.7 + interval * 0.3;
    }
    lastDataTimeRef.current = now;

    const startRows = Math.min(batch.rows.length, Math.max(rowCountRef.current, 1));
    const animDuration = batch.hasBacklog
      ? Math.max(45, Math.min(140, frameIntervalRef.current * Math.max(0.45, batch.rows.length * 0.3)))
      : Math.max(50, Math.min(180, frameIntervalRef.current * Math.max(0.9, batch.rows.length * 0.45)));
    const animStartTime = now;

    gl.useProgram(program);
    gl.uniform1f(scrollRowsLocationRef.current, startRows);
    render();

    const animate = () => {
      const elapsed = performance.now() - animStartTime;
      const progress = Math.min(1, elapsed / animDuration);
      const eased = 1 - (1 - progress) * (1 - progress);
      const offset = startRows * (1 - eased);

      const currentGl = glRef.current;
      const currentProgram = programRef.current;
      if (currentGl && currentProgram && !currentGl.isContextLost() && scrollRowsLocationRef.current) {
        currentGl.useProgram(currentProgram);
        currentGl.uniform1f(scrollRowsLocationRef.current, offset);
        render();
      }

      if (progress < 1) {
        scrollAnimRef.current = requestAnimationFrame(animate);
      }
    };

    scrollAnimRef.current = requestAnimationFrame(animate);
  }, [
    appendRowsToTexture,
    releaseTextureStorage,
    rebuildTexture,
    render,
    resetAutoRangeState,
    totalRows,
    updateViewState,
  ]);

  useEffect(() => {
    processRenderBatchRef.current = processRenderBatch;
  }, [processRenderBatch]);

  useEffect(() => {
    processRenderBatchRef.current(controller.primeRenderBatch());

    const handleFrameTick = () => {
      processRenderBatchRef.current(controller.consumeRenderBatch());
    };

    return controller.subscribeFrameTick(handleFrameTick);
  }, [controller]);

  useEffect(() => {
    if (!viewState.hasData) {
      resetAutoRangeState();
    }
  }, [viewState.hasData, resetAutoRangeState]);

  useEffect(() => {
    if (hoveredRxMarkerId === null) {
      return;
    }
    if (!rxFrequencies.some(({ operatorId }) => operatorId === hoveredRxMarkerId)) {
      setHoveredRxMarkerId(null);
    }
  }, [hoveredRxMarkerId, rxFrequencies]);

  useEffect(() => {
    resetAutoRangeState();
  }, [
    autoRange,
    axis?.binCount,
    axis?.minHz,
    axis?.maxHz,
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

  // 参数变化只重建纹理/重绘，不重建 WebGL context
  useEffect(() => {
    const gl = glRef.current;
    const program = programRef.current;
    if (!gl || !program) return;

    gl.useProgram(program);
    const minDbLocation = gl.getUniformLocation(program, 'u_minDb');
    const maxDbLocation = gl.getUniformLocation(program, 'u_maxDb');
    gl.uniform1f(minDbLocation, minDb);
    gl.uniform1f(maxDbLocation, maxDb);

    if (displayRowsRef.current.length > 0 && currentAxisRef.current) {
      rebuildTexture(displayRowsRef.current, currentAxisRef.current);
    }
    render();
  }, [minDb, maxDb, rebuildTexture, render]);

  useEffect(() => {
    if (!displayRowsRef.current.length || !currentAxisRef.current) {
      return;
    }
    rebuildTexture(displayRowsRef.current, currentAxisRef.current);
    render();
  }, [
    autoRange,
    autoRangeConfig.updateInterval,
    autoRangeConfig.minPercentile,
    autoRangeConfig.maxPercentile,
    autoRangeConfig.rangeExpansionFactor,
    rebuildTexture,
    render,
  ]);


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
  const isAbsoluteWindowedMode = frequencyRangeMode === 'absolute-windowed';
  const minFrequency = axis?.minHz ?? 0;
  const maxFrequency = axis?.maxHz ?? 0;
  const hasAxis = Boolean(axis && axis.binCount > 0 && maxFrequency > minFrequency);

  const snapFrequency = useCallback((frequency: number) => {
    const stepHz = typeof interactionFrequencyStepHz === 'number' && Number.isFinite(interactionFrequencyStepHz) && interactionFrequencyStepHz > 0
      ? interactionFrequencyStepHz
      : 1;
    return Math.round(frequency / stepHz) * stepHz;
  }, [interactionFrequencyStepHz]);

  const clampBasebandFrequency = useCallback((frequency: number) => {
    return snapFrequency(Math.max(basebandInteractionRange.min, Math.min(basebandInteractionRange.max, frequency)));
  }, [basebandInteractionRange.max, basebandInteractionRange.min, snapFrequency]);

  const clampInteractionFrequency = useCallback((frequency: number) => {
    if (!interactionFrequencyRange) {
      return snapFrequency(frequency);
    }
    return snapFrequency(Math.max(interactionFrequencyRange.min, Math.min(interactionFrequencyRange.max, frequency)));
  }, [interactionFrequencyRange, snapFrequency]);

  const getDisplayFrequency = useCallback((basebandFrequency: number) => {
    if (!hasAxis) return null;
    if (isAbsoluteWindowedMode) {
      return basebandFrequency;
    }
    if (isAbsoluteDisplayMode) {
      const referenceFrequency = referenceFrequencyHz ?? null;
      if (referenceFrequency === null) {
        return null;
      }
      return referenceFrequency + basebandFrequency;
    }
    return basebandFrequency;
  }, [hasAxis, isAbsoluteDisplayMode, isAbsoluteWindowedMode, referenceFrequencyHz]);

  // 计算频率到位置的百分比
  const getFrequencyPosition = useCallback((displayFrequency: number) => {
    if (!hasAxis) return 0;
    return ((displayFrequency + FREQ_POSITION_OFFSET - minFrequency) / (maxFrequency - minFrequency)) * 100;
  }, [hasAxis, maxFrequency, minFrequency]);

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
    if (!container || !hasAxis) return 0;

    const containerRect = container.getBoundingClientRect();
    const relativeX = clientX - containerRect.left;
    const percentage = Math.max(0, Math.min(1, relativeX / containerRect.width));

    const displayFrequency = minFrequency + percentage * (maxFrequency - minFrequency) - FREQ_POSITION_OFFSET;
    const basebandFrequency = isAbsoluteDisplayMode
      ? displayFrequency - (referenceFrequencyHz ?? minFrequency)
      : displayFrequency;

    return clampBasebandFrequency(basebandFrequency);
  }, [clampBasebandFrequency, hasAxis, isAbsoluteDisplayMode, maxFrequency, minFrequency, referenceFrequencyHz]);

  const getInteractionFrequencyFromMousePosition = useCallback((clientX: number) => {
    const container = containerRef.current;
    if (!container || !hasAxis) return 0;

    const containerRect = container.getBoundingClientRect();
    const relativeX = clientX - containerRect.left;
    const percentage = Math.max(0, Math.min(1, relativeX / containerRect.width));
    const displayFrequency = minFrequency + percentage * (maxFrequency - minFrequency) - FREQ_POSITION_OFFSET;

    if (interactionFrequencyMode === 'absolute') {
      return clampInteractionFrequency(displayFrequency);
    }

    return getFrequencyFromMousePosition(clientX);
  }, [clampInteractionFrequency, getFrequencyFromMousePosition, hasAxis, interactionFrequencyMode, maxFrequency, minFrequency]);

  const handleGenericFrequencyDragMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!onDragFrequencyChange || event.button !== 0 || !hasAxis) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-waterfall-marker-interactive="true"]')) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (gestureCooldownTimerRef.current) {
      clearTimeout(gestureCooldownTimerRef.current);
      gestureCooldownTimerRef.current = null;
    }

    const rect = container.getBoundingClientRect();
    const hzPerPixel = rect.width > 0
      ? (maxFrequency - minFrequency) / rect.width
      : 0;
    const startFrequency = getInteractionFrequencyFromMousePosition(event.clientX);

    latestGestureFrequencyRef.current = startFrequency;
    setLocalGestureFrequencyOverride(startFrequency);
    setFrequencyGestureDragState({
      startX: event.clientX,
      startFrequency,
      hzPerPixel,
      hasExceededThreshold: false,
    });
  }, [getInteractionFrequencyFromMousePosition, hasAxis, maxFrequency, minFrequency, onDragFrequencyChange]);

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

  useEffect(() => {
    if (!frequencyGestureDragState || !onDragFrequencyChange) {
      return;
    }

    const handleGestureMouseMove = (event: MouseEvent) => {
      const dragDistance = event.clientX - frequencyGestureDragState.startX;
      const hasExceededThreshold = frequencyGestureDragState.hasExceededThreshold
        || Math.abs(dragDistance) >= FREQUENCY_GESTURE_DRAG_THRESHOLD_PX;

      if (!hasExceededThreshold) {
        return;
      }

      const nextFrequency = interactionFrequencyMode === 'absolute'
        ? clampInteractionFrequency(frequencyGestureDragState.startFrequency + dragDistance * frequencyGestureDragState.hzPerPixel)
        : clampBasebandFrequency(frequencyGestureDragState.startFrequency + dragDistance * frequencyGestureDragState.hzPerPixel);

      if (!frequencyGestureDragState.hasExceededThreshold) {
        setFrequencyGestureDragState(current => (
          current
            ? {
                ...current,
                hasExceededThreshold: true,
              }
            : current
        ));
      }

      setLocalGestureFrequencyOverride(nextFrequency);
      latestGestureFrequencyRef.current = nextFrequency;

      if (gestureDragDebounceRef.current) {
        clearTimeout(gestureDragDebounceRef.current);
      }

      gestureDragDebounceRef.current = setTimeout(() => {
        const latestFrequency = latestGestureFrequencyRef.current;
        if (typeof latestFrequency === 'number') {
          onDragFrequencyChange(latestFrequency);
        }
      }, 120);
    };

    const handleGestureMouseUp = () => {
      if (gestureDragDebounceRef.current) {
        clearTimeout(gestureDragDebounceRef.current);
        gestureDragDebounceRef.current = null;
      }

      const latestFrequency = latestGestureFrequencyRef.current;
      if (frequencyGestureDragState.hasExceededThreshold && typeof latestFrequency === 'number') {
        onDragFrequencyChange(latestFrequency);
      }

      setFrequencyGestureDragState(null);
      if (frequencyGestureDragState.hasExceededThreshold) {
        gestureCooldownTimerRef.current = setTimeout(() => {
          setLocalGestureFrequencyOverride(null);
          latestGestureFrequencyRef.current = null;
          gestureCooldownTimerRef.current = null;
        }, 500);
      } else {
        setLocalGestureFrequencyOverride(null);
        latestGestureFrequencyRef.current = null;
      }
    };

    document.addEventListener('mousemove', handleGestureMouseMove);
    document.addEventListener('mouseup', handleGestureMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleGestureMouseMove);
      document.removeEventListener('mouseup', handleGestureMouseUp);
    };
  }, [
    clampBasebandFrequency,
    clampInteractionFrequency,
    frequencyGestureDragState,
    interactionFrequencyMode,
    onDragFrequencyChange,
  ]);

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      style={{ height: `${height}px` }}
      onMouseDown={onDragFrequencyChange ? handleGenericFrequencyDragMouseDown : undefined}
      onDoubleClick={(e) => {
        if (!onDoubleClickSetFrequency) {
          return;
        }
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-waterfall-marker-interactive="true"]')) {
          return;
        }
        onDoubleClickSetFrequency(getInteractionFrequencyFromMousePosition(e.clientX));
      }}
      onContextMenu={(e) => {
        if (onRightClickSetFrequency) {
          e.preventDefault();
          const frequency = getInteractionFrequencyFromMousePosition(e.clientX);
          onRightClickSetFrequency(frequency);
        }
      }}
    >
      {!markerOnly && (
        <canvas
          ref={canvasRef}
          className="w-full"
          style={{ height: `${height}px` }}
        />
      )}

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
                data-waterfall-marker-interactive="true"
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

        {presetMarkers.map((marker) => {
          const position = getFrequencyPosition(marker.frequency);
          if (!Number.isFinite(position) || position < 0 || position > 100) {
            return null;
          }

          const isInteractive = Boolean(marker.clickable && onPresetMarkerClick);
          const isHovered = hoveredPresetMarkerId === marker.id;
          const markerElement = (
            <div
              key={`preset-${marker.id}`}
              className={`absolute top-0 h-full pointer-events-auto transition-opacity ${
                isInteractive ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
              }`}
              style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
              data-waterfall-marker-interactive="true"
              onClick={isInteractive ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onPresetMarkerClick?.(marker.frequency);
              } : undefined}
              onMouseEnter={() => setHoveredPresetMarkerId(marker.id)}
              onMouseLeave={() => setHoveredPresetMarkerId(null)}
            >
              <div className="w-0.5 h-full bg-amber-400/55" />
              <div
                className={`absolute bottom-1 left-1/2 -translate-x-1/2 max-w-[5rem] truncate px-1 text-xs font-semibold bg-black/60 rounded text-amber-300 select-none transition-opacity ${
                  isHovered ? 'opacity-100' : 'opacity-0'
                }`}
              >
                {marker.label}
              </div>
            </div>
          );

          if (!marker.description) {
            return markerElement;
          }

          return (
            <Popover
              key={`preset-${marker.id}`}
              placement="bottom"
              isOpen={isHovered}
              onOpenChange={(open) => {
                if (!open) setHoveredPresetMarkerId(null);
              }}
            >
              <PopoverTrigger>
                {markerElement}
              </PopoverTrigger>
              <PopoverContent
                onMouseEnter={() => setHoveredPresetMarkerId(marker.id)}
                onMouseLeave={() => setHoveredPresetMarkerId(null)}
              >
                <div className="px-2 py-1">
                  <div className="text-sm font-semibold">{marker.description}</div>
                  <div className="text-xs text-default-400">
                    {`${(marker.frequency / 1_000_000).toFixed(3)} MHz`}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
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
          const isInteractive = Boolean(onTxFrequencyChange);
          const isDragging = draggingOperatorId === operatorId;
          const showPopover = txFrequencies.length > 1;
          const isHovered = hoveredTxOperatorId === operatorId;

          const markerElement = (
            <div
              key={`tx-${operatorId}`}
              className={`absolute top-0 h-full pointer-events-auto transition-opacity ${
                isInteractive ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
              } ${showPopover ? 'hover:opacity-80' : ''}`}
              style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
              data-waterfall-marker-interactive="true"
              onMouseDown={isInteractive ? () => {
                setHoveredTxOperatorId(null);
                handleMouseDown(operatorId);
              } : undefined}
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
        {rxFrequencies.map(({ operatorId, callsign, frequency }) => {
          const position = getMarkerPosition(frequency);
          if (position === null) {
            return null;
          }
          const isOpen = hoveredRxMarkerId === operatorId;
          return (
            <Popover
              key={`rx-${operatorId}`}
              placement="bottom"
              isOpen={isOpen}
              onOpenChange={(open) => {
                if (!open) setHoveredRxMarkerId(null);
              }}
            >
              <PopoverTrigger>
                <div
                  className="absolute top-0 h-full pointer-events-auto cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
                  data-waterfall-marker-interactive="true"
                  onMouseEnter={() => setHoveredRxMarkerId(operatorId)}
                  onMouseLeave={() => setHoveredRxMarkerId(null)}
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
                onMouseEnter={() => setHoveredRxMarkerId(operatorId)}
                onMouseLeave={() => setHoveredRxMarkerId(null)}
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
        {localGestureFrequencyOverride !== null && getFrequencyPosition(localGestureFrequencyOverride) >= 0 && getFrequencyPosition(localGestureFrequencyOverride) <= 100 && (
          <div
            className="absolute top-0 h-full pointer-events-none"
            style={{ left: `${getFrequencyPosition(localGestureFrequencyOverride)}%`, transform: 'translateX(-50%)' }}
          >
            <div className="w-0.5 h-full bg-primary-400/80" />
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
