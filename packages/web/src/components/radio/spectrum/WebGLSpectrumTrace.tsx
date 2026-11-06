import React, { useCallback, useEffect, useRef } from 'react';
import { createLogger } from '../../../utils/logger';
import {
  buildWaterfallRulerTicks,
  type WaterfallViewportInteraction,
} from './WebGLWaterfall';
import {
  IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  type FrequencyAxisTransform,
} from '../../../spectrum/frequencyAxisCalibration';
import type { SpectrumRenderSnapshot, SpectrumStreamController } from '../../../spectrum/SpectrumStreamController';
import type { SpectrumViewportRuntime } from '../../../spectrum/SpectrumViewportRuntime';
import { SpectrumTraceSmoother } from '../../../spectrum/SpectrumTraceSmoother';

const logger = createLogger('WebGLSpectrumTrace');
const TRACE_MAX_DEVICE_PIXEL_RATIO = 1.5;
const TRACE_FRAME_INTERPOLATION_MS = 50;

/**
 * Render-only spectrum trace. In the standalone presentation it is mounted as
 * the header surface of WebGLWaterfall, whose single overlay/interaction layer
 * spans both surfaces; the trace therefore owns no markers or gestures and only
 * follows the shared viewport (committed range plus live previews).
 */
export interface WebGLSpectrumTraceProps {
  controller: SpectrumStreamController;
  className?: string;
  height?: number;
  minDb?: number;
  maxDb?: number;
  frequencyAxisTransform?: FrequencyAxisTransform;
  visualFrequencyOffsetHz?: number;
  /** Only the committed `range` is read; gestures belong to the waterfall. */
  viewportInteraction?: Pick<WaterfallViewportInteraction, 'range'>;
  viewportRuntime?: SpectrumViewportRuntime;
}

function isValidRange(range: { min: number; max: number } | null | undefined): range is { min: number; max: number } {
  return Boolean(
    range
    && Number.isFinite(range.min)
    && Number.isFinite(range.max)
    && range.max > range.min,
  );
}

function getPixelRatio(): number {
  const ratio = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
    ? window.devicePixelRatio
    : 1;
  return Math.max(1, Math.min(TRACE_MAX_DEVICE_PIXEL_RATIO, ratio));
}

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const fragmentSource = `
    precision mediump float;
    uniform vec4 u_color;
    uniform vec2 u_detailAxis;
    uniform float u_fallbackOnly;
    varying float v_frequency;
    void main() {
      if (u_fallbackOnly > 0.5 && v_frequency >= u_detailAxis.x && v_frequency <= u_detailAxis.y) discard;
      gl_FragColor = u_color;
    }
  `;
  const build = (precision: 'highp' | 'mediump') => {
    const vertexSource = `
      precision ${precision} float;
      attribute vec2 a_point;
      attribute float a_previousValue;
      uniform vec2 u_dataAxis;
      uniform vec2 u_viewAxis;
      uniform vec2 u_levelRange;
      uniform float u_smoothing;
      varying float v_frequency;
      void main() {
        float dataSpan = max(u_dataAxis.y - u_dataAxis.x, 1.0);
        float viewSpan = max(u_viewAxis.y - u_viewAxis.x, 1.0);
        float frequency = u_dataAxis.x + a_point.x * dataSpan;
        v_frequency = frequency;
        float x = ((frequency - u_viewAxis.x) / viewSpan) * 2.0 - 1.0;
        float levelSpan = max(u_levelRange.y - u_levelRange.x, 0.0001);
        float value = mix(a_previousValue, a_point.y, u_smoothing);
        float y = clamp((value - u_levelRange.x) / levelSpan, 0.0, 1.0);
        gl_Position = vec4(x, y * 2.0 - 1.0, 0.0, 1.0);
      }
    `;
    const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      return null;
    }
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    return program;
  };

  return build('highp') ?? build('mediump');
}

export const WebGLSpectrumTrace: React.FC<WebGLSpectrumTraceProps> = ({
  controller,
  className = '',
  height = 140,
  minDb = -35,
  maxDb = 10,
  frequencyAxisTransform = IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  visualFrequencyOffsetHz = 0,
  viewportInteraction,
  viewportRuntime,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const bufferRef = useRef<WebGLBuffer | null>(null);
  const previousBufferRef = useRef<WebGLBuffer | null>(null);
  const fillBufferRef = useRef<WebGLBuffer | null>(null);
  const fillPreviousBufferRef = useRef<WebGLBuffer | null>(null);
  const supplementBufferRef = useRef<WebGLBuffer | null>(null);
  const supplementPreviousBufferRef = useRef<WebGLBuffer | null>(null);
  const pointDataRef = useRef<Float32Array | null>(null);
  const previousPointDataRef = useRef<Float32Array | null>(null);
  const fillDataRef = useRef<Float32Array | null>(null);
  const fillPreviousDataRef = useRef<Float32Array | null>(null);
  const supplementPointDataRef = useRef<Float32Array | null>(null);
  const supplementPreviousDataRef = useRef<Float32Array | null>(null);
  const frameTokenRef = useRef<number | null>(null);
  const supplementFrameTokenRef = useRef<number | null>(null);
  const supplementLengthRef = useRef(0);
  const pointLengthRef = useRef(0);
  const traceValuesRef = useRef<Float32Array | null>(null);
  const traceFrameTokenRef = useRef<number | null>(null);
  const traceAxisSignatureRef = useRef<string | null>(null);
  const traceSmootherRef = useRef(new SpectrumTraceSmoother());
  const positionLocationRef = useRef<number>(-1);
  const previousValueLocationRef = useRef<number>(-1);
  const dataAxisLocationRef = useRef<WebGLUniformLocation | null>(null);
  const viewAxisLocationRef = useRef<WebGLUniformLocation | null>(null);
  const levelRangeLocationRef = useRef<WebGLUniformLocation | null>(null);
  const colorLocationRef = useRef<WebGLUniformLocation | null>(null);
  const smoothingLocationRef = useRef<WebGLUniformLocation | null>(null);
  const detailAxisLocationRef = useRef<WebGLUniformLocation | null>(null);
  const fallbackOnlyLocationRef = useRef<WebGLUniformLocation | null>(null);
  const rafRef = useRef<number | null>(null);
  const dirtyRef = useRef(true);
  const heightRef = useRef(height);
  const minDbRef = useRef(minDb);
  const maxDbRef = useRef(maxDb);
  const viewportInteractionRef = useRef(viewportInteraction);
  const frequencyAxisTransformRef = useRef(frequencyAxisTransform);
  const visualOffsetRef = useRef(visualFrequencyOffsetHz);
  const rulerRef = useRef<HTMLDivElement>(null);
  const rulerPoolRef = useRef<Array<{ root: HTMLDivElement; line: HTMLDivElement; label: HTMLDivElement; lineClass: string; labelText: string }>>([]);
  const rulerSignatureRef = useRef<string | null>(null);
  const viewAxisRef = useRef<{ min: number; max: number } | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const smoothingStartRef = useRef<number | null>(null);

  heightRef.current = height;
  minDbRef.current = minDb;
  maxDbRef.current = maxDb;
  viewportInteractionRef.current = viewportInteraction;
  frequencyAxisTransformRef.current = frequencyAxisTransform;
  visualOffsetRef.current = visualFrequencyOffsetHz;

  const getSnapshot = useCallback((): SpectrumRenderSnapshot => (
    controller.getLatestRenderSnapshot()
  ), [controller]);

  const getCurrentAxis = useCallback(() => {
    if (isValidRange(viewAxisRef.current)) return viewAxisRef.current;
    const range = viewportInteractionRef.current?.range;
    if (isValidRange(range)) return range;
    const axis = getSnapshot().axis;
    return axis ? { min: axis.minHz, max: axis.maxHz } : null;
  }, [getSnapshot]);

  const updateRuler = useCallback((axis: { min: number; max: number }, widthPx: number) => {
    const layer = rulerRef.current;
    if (!layer || widthPx <= 0 || !isValidRange(axis)) return;
    const signature = `${axis.min}:${axis.max}:${Math.round(widthPx)}`;
    if (rulerSignatureRef.current === signature) return;
    rulerSignatureRef.current = signature;
    const ticks = buildWaterfallRulerTicks(
      axis.min,
      axis.max,
      widthPx,
      visualOffsetRef.current,
      frequencyAxisTransformRef.current,
    );
    const pool = rulerPoolRef.current;
    for (let index = 0; index < ticks.length; index += 1) {
      let entry = pool[index];
      if (!entry) {
        const root = document.createElement('div');
        root.className = 'absolute top-0 -translate-x-1/2';
        const line = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'absolute left-1/2 top-1.5 -translate-x-1/2 select-none whitespace-nowrap text-[10px] font-medium leading-none tabular-nums tracking-wide text-white/55';
        root.appendChild(line);
        root.appendChild(label);
        layer.appendChild(root);
        entry = { root, line, label, lineClass: '', labelText: '' };
        pool[index] = entry;
      }
      const tick = ticks[index]!;
      entry.root.style.display = '';
      entry.root.style.left = `${tick.positionPercent}%`;
      const lineClass = tick.kind === 'major'
        ? 'mx-auto h-4 w-px bg-white/35'
        : tick.kind === 'medium'
          ? 'mx-auto h-3 w-px bg-white/25'
          : 'mx-auto h-2 w-px bg-white/18';
      if (entry.lineClass !== lineClass) {
        entry.line.className = lineClass;
        entry.lineClass = lineClass;
      }
      const labelText = tick.label ?? '';
      if (entry.labelText !== labelText) {
        entry.label.textContent = labelText;
        entry.labelText = labelText;
      }
    }
    for (let index = ticks.length; index < pool.length; index += 1) pool[index]!.root.style.display = 'none';
  }, []);

  const scheduleRender = useCallback(() => {
    dirtyRef.current = true;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      renderRef.current();
    });
  }, []);

  const ensurePointData = useCallback((current: Float32Array | null, values: Float32Array): Float32Array => {
    return current && current.length === values.length * 2
      ? current
      : new Float32Array(values.length * 2);
  }, []);

  const ensureValueData = useCallback((current: Float32Array | null, values: Float32Array): Float32Array => {
    return current && current.length === values.length
      ? current
      : new Float32Array(values.length);
  }, []);

  const ensureFillData = useCallback((current: Float32Array | null, values: Float32Array): Float32Array => {
    return current && current.length === values.length * 4
      ? current
      : new Float32Array(values.length * 4);
  }, []);

  const ensureFillPreviousData = useCallback((current: Float32Array | null, values: Float32Array): Float32Array => {
    return current && current.length === values.length * 2
      ? current
      : new Float32Array(values.length * 2);
  }, []);

  const draw = useCallback(() => {
    const gl = glRef.current;
    const canvas = canvasRef.current;
    const program = programRef.current;
    if (!gl || !canvas || !program || gl.isContextLost()) return;

    const container = containerRef.current;
    if (container) {
      const ratio = getPixelRatio();
      const width = Math.max(1, Math.round(container.clientWidth * ratio));
      const nextHeight = Math.max(1, Math.round(heightRef.current * ratio));
      if (canvas.width !== width || canvas.height !== nextHeight) {
        canvas.width = width;
        canvas.height = nextHeight;
        gl.viewport(0, 0, width, nextHeight);
      }
    }

    const snapshot = getSnapshot();
    if (!snapshot.axis || !snapshot.values || snapshot.values.length === 0) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    const traceAxisSignature = `${snapshot.kind}:${snapshot.axis.minHz}:${snapshot.axis.maxHz}:${snapshot.values.length}:${snapshot.level?.domain ?? 'db'}:${snapshot.level?.unit ?? 'dB'}`;
    if (snapshot.frameToken !== traceFrameTokenRef.current || traceAxisSignatureRef.current !== traceAxisSignature) {
      traceValuesRef.current = traceSmootherRef.current.process(snapshot.values, {
        frameToken: snapshot.frameToken,
        timestamp: snapshot.timestamp,
        axis: { minHz: snapshot.axis.minHz, maxHz: snapshot.axis.maxHz },
        level: snapshot.level,
      });
      traceFrameTokenRef.current = snapshot.frameToken;
      traceAxisSignatureRef.current = traceAxisSignature;
      // A viewport change can reuse the same frame token but produces a new
      // projected row; force the corresponding GPU buffer refresh.
      frameTokenRef.current = null;
    }
    const traceValues = traceValuesRef.current ?? snapshot.values;

    if (!isValidRange(viewportInteractionRef.current?.range)) {
      viewAxisRef.current = { min: snapshot.axis.minHz, max: snapshot.axis.maxHz };
    }
    const viewAxis = getCurrentAxis() ?? { min: snapshot.axis.minHz, max: snapshot.axis.maxHz };
    const pointData = ensurePointData(pointDataRef.current, traceValues);
    pointDataRef.current = pointData;
    if (snapshot.frameToken !== frameTokenRef.current || pointLengthRef.current !== traceValues.length) {
      const previousValues = ensureValueData(previousPointDataRef.current, traceValues);
      previousPointDataRef.current = previousValues;
      if (pointLengthRef.current === traceValues.length && pointDataRef.current !== null) {
        for (let index = 0; index < traceValues.length; index += 1) {
          previousValues[index] = pointDataRef.current[index * 2 + 1]!;
        }
      } else {
        for (let index = 0; index < traceValues.length; index += 1) {
          previousValues[index] = traceValues[index]!;
        }
      }
      frameTokenRef.current = snapshot.frameToken;
      pointLengthRef.current = traceValues.length;
      for (let index = 0; index < traceValues.length; index += 1) {
        pointData[index * 2] = index / Math.max(traceValues.length - 1, 1);
        pointData[index * 2 + 1] = traceValues[index]!;
      }
      const fillData = ensureFillData(fillDataRef.current, traceValues);
      const fillPreviousData = ensureFillPreviousData(fillPreviousDataRef.current, traceValues);
      fillDataRef.current = fillData;
      fillPreviousDataRef.current = fillPreviousData;
      for (let index = 0; index < traceValues.length; index += 1) {
        const ratio = index / Math.max(traceValues.length - 1, 1);
        fillData[index * 4] = ratio;
        fillData[index * 4 + 1] = traceValues[index]!;
        fillData[index * 4 + 2] = ratio;
        fillData[index * 4 + 3] = minDbRef.current;
        fillPreviousData[index * 2] = previousValues[index]!;
        fillPreviousData[index * 2 + 1] = minDbRef.current;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, bufferRef.current);
      gl.bufferData(gl.ARRAY_BUFFER, pointData, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, previousBufferRef.current);
      gl.bufferData(gl.ARRAY_BUFFER, previousValues, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, fillBufferRef.current);
      gl.bufferData(gl.ARRAY_BUFFER, fillData, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, fillPreviousBufferRef.current);
      gl.bufferData(gl.ARRAY_BUFFER, fillPreviousData, gl.DYNAMIC_DRAW);
      smoothingStartRef.current = performance.now();
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    const positionLocation = positionLocationRef.current;
    const previousValueLocation = previousValueLocationRef.current;
    gl.enableVertexAttribArray(positionLocation);
    gl.enableVertexAttribArray(previousValueLocation);
    const smoothingProgress = smoothingStartRef.current === null
      ? 1
      : Math.min(1, Math.max(0, (performance.now() - smoothingStartRef.current) / TRACE_FRAME_INTERPOLATION_MS));
    if (smoothingLocationRef.current) gl.uniform1f(smoothingLocationRef.current, smoothingProgress);
    if (viewAxisLocationRef.current) gl.uniform2f(viewAxisLocationRef.current, viewAxis.min, viewAxis.max);
    if (levelRangeLocationRef.current) gl.uniform2f(levelRangeLocationRef.current, minDbRef.current, maxDbRef.current);
    if (detailAxisLocationRef.current) gl.uniform2f(detailAxisLocationRef.current, snapshot.axis.minHz, snapshot.axis.maxHz);
    if (fallbackOnlyLocationRef.current) gl.uniform1f(fallbackOnlyLocationRef.current, 0);
    const drawFill = (buffer: WebGLBuffer | null, previousBuffer: WebGLBuffer | null, count: number, axis: { minHz: number; maxHz: number }, color: [number, number, number, number]) => {
      if (!buffer || !previousBuffer || count < 2) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer);
      gl.vertexAttribPointer(previousValueLocation, 1, gl.FLOAT, false, 0, 0);
      if (dataAxisLocationRef.current) gl.uniform2f(dataAxisLocationRef.current, axis.minHz, axis.maxHz);
      if (colorLocationRef.current) gl.uniform4f(colorLocationRef.current, color[0], color[1], color[2], color[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, count * 2);
    };

    const previewPhase = viewportRuntime?.getPhase();
    const previewRange = viewportRuntime?.getPreviewRange();
    const needsWideFallback = Boolean(
      previewRange
      && (previewPhase === 'preview' || previewPhase === 'commit-hold')
      && (previewRange.min < snapshot.axis.minHz || previewRange.max > snapshot.axis.maxHz),
    );
    if (needsWideFallback && snapshot.supplementAxis && snapshot.supplementValues && snapshot.supplementValues.length > 1) {
      const supplementValues = snapshot.supplementValues;
      const supplementData = ensurePointData(supplementPointDataRef.current, supplementValues);
      const supplementPreviousData = ensureValueData(supplementPreviousDataRef.current, supplementValues);
      supplementPointDataRef.current = supplementData;
      supplementPreviousDataRef.current = supplementPreviousData;
      if (snapshot.frameToken !== supplementFrameTokenRef.current || supplementLengthRef.current !== supplementValues.length) {
        supplementFrameTokenRef.current = snapshot.frameToken;
        supplementLengthRef.current = supplementValues.length;
        for (let index = 0; index < supplementValues.length; index += 1) {
          supplementData[index * 2] = index / Math.max(supplementValues.length - 1, 1);
          supplementData[index * 2 + 1] = supplementValues[index]!;
          supplementPreviousData[index] = supplementValues[index]!;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, supplementBufferRef.current);
        gl.bufferData(gl.ARRAY_BUFFER, supplementData, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, supplementPreviousBufferRef.current);
        gl.bufferData(gl.ARRAY_BUFFER, supplementPreviousData, gl.DYNAMIC_DRAW);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, supplementBufferRef.current);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, supplementPreviousBufferRef.current);
      gl.vertexAttribPointer(previousValueLocation, 1, gl.FLOAT, false, 0, 0);
      if (smoothingLocationRef.current) gl.uniform1f(smoothingLocationRef.current, 1);
      if (fallbackOnlyLocationRef.current) gl.uniform1f(fallbackOnlyLocationRef.current, 1);
      if (dataAxisLocationRef.current) gl.uniform2f(dataAxisLocationRef.current, snapshot.supplementAxis.minHz, snapshot.supplementAxis.maxHz);
      if (colorLocationRef.current) gl.uniform4f(colorLocationRef.current, 0.25, 0.55, 0.95, 0.78);
      gl.drawArrays(gl.LINE_STRIP, 0, supplementValues.length);
      if (smoothingLocationRef.current) gl.uniform1f(smoothingLocationRef.current, smoothingProgress);
    }

    // Draw a single detail trace. The controller has already projected any
    // out-of-window samples through the supplement; keeping that fallback in
    // the same row avoids a second, visually confusing line in trace mode.
    drawFill(fillBufferRef.current, fillPreviousBufferRef.current, traceValues.length, snapshot.axis, [0.25, 0.85, 0.95, 0.2]);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferRef.current);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, previousBufferRef.current);
    gl.vertexAttribPointer(previousValueLocation, 1, gl.FLOAT, false, 0, 0);
    if (dataAxisLocationRef.current) gl.uniform2f(dataAxisLocationRef.current, snapshot.axis.minHz, snapshot.axis.maxHz);
    if (fallbackOnlyLocationRef.current) gl.uniform1f(fallbackOnlyLocationRef.current, 0);
    if (colorLocationRef.current) gl.uniform4f(colorLocationRef.current, 0.25, 0.85, 0.95, 0.95);
    gl.drawArrays(gl.LINE_STRIP, 0, traceValues.length);

    if (smoothingProgress < 1) scheduleRender();

    updateRuler(viewAxis, container?.clientWidth ?? 0);
  }, [ensurePointData, ensureValueData, getCurrentAxis, getSnapshot, scheduleRender, updateRuler]);
  renderRef.current = draw;

  useEffect(() => {
    if (!viewportInteraction?.range) return;
    viewAxisRef.current = { ...viewportInteraction.range };
    scheduleRender();
  }, [scheduleRender, viewportInteraction?.range?.max, viewportInteraction?.range?.min]);

  useEffect(() => {
    const unsubscribe = controller.subscribeFrameTick(() => scheduleRender());
    scheduleRender();
    return unsubscribe;
  }, [controller, scheduleRender]);

  useEffect(() => {
    // The fill geometry stores the level floor so it remains a true area
    // under the curve when the user changes the shared display range.
    frameTokenRef.current = null;
    scheduleRender();
  }, [maxDb, minDb, scheduleRender]);

  useEffect(() => {
    if (!viewportRuntime) return;
    const syncExternalPreview = () => {
      const preview = viewportRuntime.getPreviewRange();
      if (preview && preview.max > preview.min) {
        viewAxisRef.current = { ...preview };
      }
      scheduleRender();
    };
    const unsubscribe = viewportRuntime.subscribe(syncExternalPreview);
    syncExternalPreview();
    return unsubscribe;
  }, [scheduleRender, viewportRuntime]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const gl = canvas.getContext('webgl', {
      antialias: true,
      alpha: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as WebGLRenderingContext | null;
    if (!gl) {
      logger.warn('WebGL trace context is unavailable');
      return;
    }
    const program = createProgram(gl);
    const buffer = gl.createBuffer();
    const previousBuffer = gl.createBuffer();
    const fillBuffer = gl.createBuffer();
    const fillPreviousBuffer = gl.createBuffer();
    const supplementBuffer = gl.createBuffer();
    const supplementPreviousBuffer = gl.createBuffer();
    if (!program || !buffer || !previousBuffer || !fillBuffer || !fillPreviousBuffer || !supplementBuffer || !supplementPreviousBuffer) {
      logger.warn('Failed to initialize WebGL trace resources');
      return;
    }
    glRef.current = gl;
    programRef.current = program;
    bufferRef.current = buffer;
    previousBufferRef.current = previousBuffer;
    fillBufferRef.current = fillBuffer;
    fillPreviousBufferRef.current = fillPreviousBuffer;
    supplementBufferRef.current = supplementBuffer;
    supplementPreviousBufferRef.current = supplementPreviousBuffer;
    positionLocationRef.current = gl.getAttribLocation(program, 'a_point');
    previousValueLocationRef.current = gl.getAttribLocation(program, 'a_previousValue');
    dataAxisLocationRef.current = gl.getUniformLocation(program, 'u_dataAxis');
    viewAxisLocationRef.current = gl.getUniformLocation(program, 'u_viewAxis');
    levelRangeLocationRef.current = gl.getUniformLocation(program, 'u_levelRange');
    colorLocationRef.current = gl.getUniformLocation(program, 'u_color');
    smoothingLocationRef.current = gl.getUniformLocation(program, 'u_smoothing');
    detailAxisLocationRef.current = gl.getUniformLocation(program, 'u_detailAxis');
    fallbackOnlyLocationRef.current = gl.getUniformLocation(program, 'u_fallbackOnly');
    frameTokenRef.current = null;
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      logger.warn('WebGL trace context lost');
    };
    const handleContextRestored = () => {
      const restoredProgram = createProgram(gl);
      if (!restoredProgram) {
        logger.warn('Failed to restore WebGL trace program');
        return;
      }
      const previousProgram = programRef.current;
      if (previousProgram) gl.deleteProgram(previousProgram);
      const restoredBuffer = gl.createBuffer();
      const restoredPreviousBuffer = gl.createBuffer();
      const restoredFillBuffer = gl.createBuffer();
      const restoredFillPreviousBuffer = gl.createBuffer();
      const restoredSupplementBuffer = gl.createBuffer();
      const restoredSupplementPreviousBuffer = gl.createBuffer();
      if (!restoredBuffer || !restoredPreviousBuffer || !restoredFillBuffer || !restoredFillPreviousBuffer || !restoredSupplementBuffer || !restoredSupplementPreviousBuffer) {
        gl.deleteProgram(restoredProgram);
        logger.warn('Failed to restore WebGL trace buffers');
        return;
      }
      programRef.current = restoredProgram;
      bufferRef.current = restoredBuffer;
      previousBufferRef.current = restoredPreviousBuffer;
      fillBufferRef.current = restoredFillBuffer;
      fillPreviousBufferRef.current = restoredFillPreviousBuffer;
      supplementBufferRef.current = restoredSupplementBuffer;
      supplementPreviousBufferRef.current = restoredSupplementPreviousBuffer;
      positionLocationRef.current = gl.getAttribLocation(restoredProgram, 'a_point');
      previousValueLocationRef.current = gl.getAttribLocation(restoredProgram, 'a_previousValue');
      dataAxisLocationRef.current = gl.getUniformLocation(restoredProgram, 'u_dataAxis');
      viewAxisLocationRef.current = gl.getUniformLocation(restoredProgram, 'u_viewAxis');
      levelRangeLocationRef.current = gl.getUniformLocation(restoredProgram, 'u_levelRange');
      colorLocationRef.current = gl.getUniformLocation(restoredProgram, 'u_color');
      smoothingLocationRef.current = gl.getUniformLocation(restoredProgram, 'u_smoothing');
      detailAxisLocationRef.current = gl.getUniformLocation(restoredProgram, 'u_detailAxis');
      fallbackOnlyLocationRef.current = gl.getUniformLocation(restoredProgram, 'u_fallbackOnly');
      frameTokenRef.current = null;
      pointLengthRef.current = 0;
      supplementFrameTokenRef.current = null;
      supplementLengthRef.current = 0;
      scheduleRender();
      logger.info('WebGL trace context restored');
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => scheduleRender())
      : null;
    resizeObserver?.observe(container);
    scheduleRender();
    return () => {
      resizeObserver?.disconnect();
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      gl.deleteBuffer(buffer);
      gl.deleteBuffer(previousBuffer);
      gl.deleteBuffer(fillBuffer);
      gl.deleteBuffer(fillPreviousBuffer);
      gl.deleteProgram(program);
      glRef.current = null;
      programRef.current = null;
      bufferRef.current = null;
      previousBufferRef.current = null;
      fillBufferRef.current = null;
      fillPreviousBufferRef.current = null;
      supplementBufferRef.current = null;
      supplementPreviousBufferRef.current = null;
      pointLengthRef.current = 0;
      positionLocationRef.current = -1;
      previousValueLocationRef.current = -1;
      dataAxisLocationRef.current = null;
      viewAxisLocationRef.current = null;
      levelRangeLocationRef.current = null;
      colorLocationRef.current = null;
      smoothingLocationRef.current = null;
      detailAxisLocationRef.current = null;
      fallbackOnlyLocationRef.current = null;
    };
  }, [scheduleRender]);

  return (
    <div
      ref={containerRef}
      className={`pointer-events-none relative ${className}`}
      style={{ height: `${height}px` }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="absolute inset-x-0 top-1/4 h-px bg-white/10" />
        <div className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
        <div className="absolute inset-x-0 top-3/4 h-px bg-white/10" />
        <div className="absolute left-1 top-1 select-none text-[9px] tabular-nums text-white/45">{maxDb}</div>
        <div className="absolute bottom-1 left-1 select-none text-[9px] tabular-nums text-white/45">{minDb}</div>
        <div className="absolute inset-x-0 bottom-0 h-px bg-white/20" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent" />
      </div>
      <div ref={rulerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6" />
    </div>
  );
};
