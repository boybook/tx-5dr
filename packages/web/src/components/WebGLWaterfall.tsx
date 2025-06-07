import React, { useRef, useEffect, useCallback, useMemo } from 'react';

interface WebGLWaterfallProps {
  data: number[][];
  frequencies: number[];
  className?: string;
  height?: number;
  minDb?: number;
  maxDb?: number;
  autoRange?: boolean;
}

export const WebGLWaterfall: React.FC<WebGLWaterfallProps> = ({
  data,
  frequencies,
  className = '',
  height = 200,
  minDb = -35,
  maxDb = 10,
  autoRange = true
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

  // 计算数据的实际范围
  const calculateDataRange = useCallback((spectrumData: number[][]) => {
    if (spectrumData.length === 0) return { min: minDb, max: maxDb };
    
    let min = Infinity;
    let max = -Infinity;
    const values: number[] = [];
    
    for (const row of spectrumData) {
      for (const value of row) {
        if (isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
          values.push(value);
        }
      }
    }
    
    // 如果没有有效数据，使用默认范围
    if (!isFinite(min) || !isFinite(max)) {
      return { min: minDb, max: maxDb };
    }
    
    // 计算百分位数和统计信息
    values.sort((a, b) => a - b);
    const p1 = values[Math.floor(values.length * 0.01)];
    const p10 = values[Math.floor(values.length * 0.10)];
    const p15 = values[Math.floor(values.length * 0.15)];
    const p25 = values[Math.floor(values.length * 0.25)];
    const median = values[Math.floor(values.length * 0.5)];
    const p75 = values[Math.floor(values.length * 0.75)];
    const p90 = values[Math.floor(values.length * 0.90)];
    const p99 = values[Math.floor(values.length * 0.99)];
    
    // 使用优化的动态范围策略，提升底噪抑制
    const medianRange = p75 - p25; // 四分位距
    
    // 大幅提高最小值以获得更纯净的底色
    const dynamicMin = Math.max(p15, median - medianRange); // 使用P25，进一步减少范围倍数
    
    // 大幅提高最大值，给强信号留出充足余量
    const dynamicMax = Math.max(p99, median + medianRange * 4.0); // 确保至少达到P99，增加到4倍范围
    
    const result = {
      min: dynamicMin,
      max: dynamicMax
    };
    
    return result;
  }, [minDb, maxDb]);

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
      let r = 0, g = 0, b = 0, a = 255;

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
      const gl = canvas.getContext('webgl') as WebGLRenderingContext || canvas.getContext('experimental-webgl') as WebGLRenderingContext;
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

      // 创建颜色映射纹理
      const colorMapTexture = gl.createTexture();
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

      // 创建位置缓冲区
      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      // 创建纹理坐标缓冲区
      const texCoordBuffer = gl.createBuffer();
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
      // 强制使用UNSIGNED_BYTE纹理格式（这解决了兼容性问题）
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

  // 更新纹理数据
  const updateTexture = useCallback((spectrumData: number[][]) => {
    const gl = glRef.current;
    const texture = textureRef.current;
    const program = programRef.current;
    
    if (!gl || !texture || !program || spectrumData.length === 0) return;

    const width = spectrumData[0].length;
    const height = spectrumData.length;

    // 计算实际数据范围
    let currentMin = minDb;
    let currentMax = maxDb;
    
    if (autoRange) {
      const range = calculateDataRange(spectrumData);
      currentMin = range.min;
      currentMax = range.max;
      setActualRange(range);
      
      // 更新着色器的uniform变量
      gl.useProgram(program);
      const minDbLocation = gl.getUniformLocation(program, 'u_minDb');
      const maxDbLocation = gl.getUniformLocation(program, 'u_maxDb');
      gl.uniform1f(minDbLocation, currentMin);
      gl.uniform1f(maxDbLocation, currentMax);
    }

    // 使用UNSIGNED_BYTE格式（这解决了Float纹理兼容性问题）
    const textureData = new Uint8Array(width * height);
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 将dB值映射到0-255范围
        const normalizedValue = Math.max(0, Math.min(1, (spectrumData[y][x] - currentMin) / (currentMax - currentMin)));
        textureData[y * width + x] = Math.floor(normalizedValue * 255);
      }
    }
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, textureData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }, [minDb, maxDb, autoRange, calculateDataRange]);

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
      
      // 更新顶点数据
      const positions = new Float32Array([
        0, 0,
        canvas.width, 0,
        0, canvas.height,
        canvas.width, canvas.height,
      ]);

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      
      // 重新绑定纹理坐标（确保完整性）
      const texCoords = new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 1,
      ]);
      
      const texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

      const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
      gl.enableVertexAttribArray(texCoordLocation);
      gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);
      
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
      // 使用requestAnimationFrame优化渲染性能
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      
      animationRef.current = requestAnimationFrame(() => {
        updateTexture(data);
        render();
      });
    }
  }, [data, updateTexture, render]);

  // height属性变化时重新调整尺寸
  useEffect(() => {
    const timer = setTimeout(() => {
      handleResize();
    }, 0);
    
    return () => clearTimeout(timer);
  }, [height, handleResize]);

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

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <canvas
        ref={canvasRef}
        className="w-full"
        style={{ height: `${height}px` }}
      />
      {autoRange && actualRange && (
        <div style={{ display: 'none' }} className="absolute top-2 right-2 text-xs text-white bg-black bg-opacity-50 px-2 py-1 rounded">
          范围: {actualRange.min.toFixed(1)} ~ {actualRange.max.toFixed(1)} dB
        </div>
      )}
    </div>
  );
}; 