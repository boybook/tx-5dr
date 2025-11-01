import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@heroui/react';

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
  onTxFrequencyChange?: (operatorId: string, frequency: number) => void;
  onActualRangeChange?: (range: { min: number; max: number }) => void;
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
  onTxFrequencyChange,
  onActualRangeChange,
}) => {
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

  // RX Popover hover状态
  const [hoveredRxCallsign, setHoveredRxCallsign] = React.useState<string | null>(null);

  // 性能优化：缓存相关引用
  const positionBufferRef = useRef<WebGLBuffer | null>(null);
  const texCoordBufferRef = useRef<WebGLBuffer | null>(null);
  const colorMapTextureRef = useRef<WebGLTexture | null>(null);
  const lastDataLengthRef = useRef<number>(0);
  const rangeUpdateCounterRef = useRef<number>(0);
  const cachedRangeRef = useRef<{min: number, max: number} | null>(null);
  const textureDataRef = useRef<Uint8Array | null>(null);

  // 优化后的数据范围计算 - 使用采样和缓存
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
    
    // 采样策略：对于大数据集，只采样部分数据
    const sampleRate = spectrumData.length > 50 ? 2 : 1;
    const maxSamples = 5000; // 最多采样5000个点
    let sampleCount = 0;
    
    for (let i = 0; i < spectrumData.length && sampleCount < maxSamples; i += sampleRate) {
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
    
    varying vec2 v_texCoord;
    
    void main() {
      float value = texture2D(u_texture, v_texCoord).r;
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
      console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
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
      console.error('Program linking error:', gl.getProgramInfoLog(program));
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
        setError('WebGL不被支持');
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
      gl.uniform1f(minDbLocation, minDb);

      const maxDbLocation = gl.getUniformLocation(program, 'u_maxDb');
      gl.uniform1f(maxDbLocation, maxDb);

      const useFloatTextureLocation = gl.getUniformLocation(program, 'u_useFloatTexture');
      gl.uniform1i(useFloatTextureLocation, 0);

      // 设置纹理单元
      const textureLocation = gl.getUniformLocation(program, 'u_texture');
      gl.uniform1i(textureLocation, 0);

      const colorMapLocation = gl.getUniformLocation(program, 'u_colorMap');
      gl.uniform1i(colorMapLocation, 1);

      // 激活纹理单元
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, colorMapTexture);

      return true;
    } catch (error) {
      setWebglSupported(false);
      setError(`WebGL初始化失败: ${error instanceof Error ? error.message : '未知错误'}`);
      return false;
    }
  }, [createProgram, colorMap, minDb, maxDb]);

  // 优化后的纹理更新
  const updateTexture = useCallback((spectrumData: number[][]) => {
    const updateInternal = () => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    
    if (!gl || !texture || !program || spectrumData.length === 0) return;

    const width = spectrumData[0].length;
    const height = spectrumData.length;
    const dataSize = width * height;

    // 重用或创建纹理数据数组
    if (!textureDataRef.current || textureDataRef.current.length !== dataSize) {
      textureDataRef.current = new Uint8Array(dataSize);
    }
    const textureData = textureDataRef.current;

    // 计算实际数据范围
    let currentMin = minDb;
    let currentMax = maxDb;

    if (autoRange) {
      const range = calculateDataRange(spectrumData);
      currentMin = range.min;
      currentMax = range.max;

      // 只在范围变化显著时更新状态和通知父组件
      if (!actualRange ||
          Math.abs(actualRange.min - currentMin) > 0.5 ||
          Math.abs(actualRange.max - currentMax) > 0.5) {
        setActualRange(range);

        // 通知父组件范围已更新
        if (onActualRangeChange) {
          onActualRangeChange(range);
        }
      }
    }

    // 优化的数据转换循环
    const range = currentMax - currentMin;
    const scale = range > 0 ? 255 / range : 1;
    
    let index = 0;
    for (let y = 0; y < height; y++) {
      const row = spectrumData[y];
      for (let x = 0; x < width; x++) {
        const normalizedValue = (row[x] - currentMin) * scale;
        textureData[index++] = Math.max(0, Math.min(255, Math.floor(normalizedValue)));
      }
    }
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, textureData);
    
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
  }, [minDb, maxDb, autoRange, calculateDataRange, actualRange]);

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
    
    // 使用容器的宽度和传入的height
    const canvasWidth = containerRect.width;
    const canvasHeight = height;
    
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
    
    if (gl && program) {
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
  }, [render, height]);

  // 初始化
  useEffect(() => {
    if (initWebGL()) {
      handleResize();
    }

    const resizeObserver = new ResizeObserver((entries) => {
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
      resizeObserver.disconnect();
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [initWebGL, handleResize]);

  // 数据更新时重新渲染
  useEffect(() => {
    if (data.length > 0) {
      // 取消之前的动画帧
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      
      // 使用requestAnimationFrame批量处理更新
      animationRef.current = requestAnimationFrame(() => {
        updateTexture(data);
        render();
      });
    }
    
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [data, updateTexture, render]);

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
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ height: `${height}px` }}>
        <div className="text-red-400 text-center">
          <div>WebGL瀑布图渲染失败</div>
          {error && <div className="text-sm mt-2">{error}</div>}
        </div>
      </div>
    );
  }

  const FREQ_POSITION_OFFSET = 15;

  // 计算频率到位置的百分比
  const getFrequencyPosition = useCallback((frequency: number) => {
    if (!frequencies || frequencies.length === 0) return 0;
    const minFreq = frequencies[0];
    const maxFreq = frequencies[frequencies.length - 1];
    return ((frequency + FREQ_POSITION_OFFSET - minFreq) / (maxFreq - minFreq)) * 100;
  }, [frequencies]);

  // 从鼠标位置计算频率
  const getFrequencyFromMousePosition = useCallback((clientX: number) => {
    const container = containerRef.current;
    if (!container || !frequencies || frequencies.length === 0) return 0;

    const containerRect = container.getBoundingClientRect();
    const relativeX = clientX - containerRect.left;
    const percentage = Math.max(0, Math.min(1, relativeX / containerRect.width));

    const minFreq = frequencies[0];
    const maxFreq = frequencies[frequencies.length - 1];
    const frequency = minFreq + percentage * (maxFreq - minFreq) - FREQ_POSITION_OFFSET;

    // 限制在有效范围内并四舍五入
    return Math.round(Math.max(minFreq, Math.min(maxFreq, frequency)));
  }, [frequencies]);

  // 拖动处理函数
  const handleMouseDown = useCallback((operatorId: string) => {
    setDraggingOperatorId(operatorId);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingOperatorId || !onTxFrequencyChange) return;

    const newFrequency = getFrequencyFromMousePosition(e.clientX);
    onTxFrequencyChange(draggingOperatorId, newFrequency);
  }, [draggingOperatorId, onTxFrequencyChange, getFrequencyFromMousePosition]);

  const handleMouseUp = useCallback(() => {
    setDraggingOperatorId(null);
  }, []);

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

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <canvas
        ref={canvasRef}
        className="w-full"
        style={{ height: `${height}px` }}
      />

      {/* 频率标记层 */}
      <div className="absolute inset-0 pointer-events-none">
        {/* TX标记 - 红色 */}
        {txFrequencies.map(({ operatorId, frequency }) => {
          const position = getFrequencyPosition(frequency);
          const isDragging = draggingOperatorId === operatorId;
          return (
            <div
              key={`tx-${operatorId}`}
              className={`absolute top-0 h-full pointer-events-auto transition-opacity ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
              style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
              onMouseDown={() => handleMouseDown(operatorId)}
            >
              <div className={`w-0.5 h-full ${isDragging ? 'bg-red-500' : 'bg-red-500/50'}`} />
              <div
                className="absolute bottom-1 left-1/2 -translate-x-1/2 px-1 text-xs font-semibold bg-black/60 rounded text-red-500 select-none"
              >
                TX
              </div>
            </div>
          );
        })}

        {/* RX标记 - 绿色，带Popover (hover触发) */}
        {rxFrequencies.map(({ callsign, frequency }) => {
          const position = getFrequencyPosition(frequency);
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
      </div>

      {autoRange && actualRange && (
        <div style={{ display: 'none' }} className="absolute top-2 right-2 text-xs text-white bg-black bg-opacity-50 px-2 py-1 rounded">
          范围: {actualRange.min.toFixed(1)} ~ {actualRange.max.toFixed(1)} dB
        </div>
      )}
    </div>
  );
}; 