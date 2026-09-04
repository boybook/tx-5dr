import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { createLogger } from '../../../utils/logger';
import {
  classifyWaterfallViewportWheelAxis,
  getWaterfallLocalZoomFactor,
  buildWaterfallRulerTicks,
  calculateSpectrumAxisTransitionDuration,
  getWaterfallSemanticFrequencyAtRatio,
  getWaterfallSemanticFrequencyPositionPercent,
  normalizeWaterfallWheelDeltaX,
  shouldHandleWaterfallHorizontalWheel,
  type FrequencyBandOverlay,
  type FrequencyBandOverlayChange,
  type PresetMarker,
  type RxFrequency,
  type TxBandOverlay,
  type TxFrequency,
  type WaterfallViewportChangePhase,
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
const TRACE_MIN_VIEWPORT_SPAN_HZ = 200;
const TRACE_WHEEL_IDLE_MS = 350;
const TRACE_DRAG_THRESHOLD_PX = 4;
const TRACE_FRAME_INTERPOLATION_MS = 50;

export interface WebGLSpectrumTraceProps {
  controller: SpectrumStreamController;
  className?: string;
  height?: number;
  minDb?: number;
  maxDb?: number;
  frequencyRangeMode?: 'baseband' | 'absolute-center' | 'absolute-fixed' | 'absolute-windowed';
  referenceFrequencyHz?: number | null;
  frequencyAxisTransform?: FrequencyAxisTransform;
  visualFrequencyOffsetHz?: number;
  basebandInteractionRange?: { min: number; max: number };
  interactionFrequencyMode?: 'baseband' | 'absolute';
  interactionFrequencyRange?: { min: number; max: number } | null;
  viewportInteraction?: WaterfallViewportInteraction;
  viewportRuntime?: SpectrumViewportRuntime;
  rxFrequencies?: RxFrequency[];
  txFrequencies?: TxFrequency[];
  txBandOverlays?: TxBandOverlay[];
  frequencyBandOverlays?: FrequencyBandOverlay[];
  presetMarkers?: PresetMarker[];
  onTxFrequencyChange?: (operatorId: string, frequency: number) => void;
  onTxBandOverlayFrequencyChange?: (id: string, frequency: number) => void;
  onFrequencyBandOverlayPreviewChange?: (id: string, change: FrequencyBandOverlayChange) => void;
  onFrequencyBandOverlayCommit?: (id: string, change: FrequencyBandOverlayChange) => void;
  onPresetMarkerClick?: (frequency: number) => void;
  onDoubleClickSetFrequency?: (frequency: number) => void;
  onRightClickSetFrequency?: (frequency: number) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startFrequency: number;
  startWidth: number;
  startCenter?: number;
  kind: 'tx' | 'tx-band' | 'frequency-band';
  id: string;
  target?: 'center' | 'start' | 'end';
  exceededThreshold?: boolean;
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
  frequencyRangeMode = 'absolute-center',
  referenceFrequencyHz = null,
  frequencyAxisTransform = IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  visualFrequencyOffsetHz = 0,
  basebandInteractionRange = { min: 0, max: 3000 },
  interactionFrequencyMode = 'baseband',
  interactionFrequencyRange = null,
  viewportInteraction,
  viewportRuntime,
  rxFrequencies = [],
  txFrequencies = [],
  txBandOverlays = [],
  frequencyBandOverlays = [],
  presetMarkers = [],
  onTxFrequencyChange,
  onTxBandOverlayFrequencyChange,
  onFrequencyBandOverlayPreviewChange,
  onFrequencyBandOverlayCommit,
  onPresetMarkerClick,
  onDoubleClickSetFrequency,
  onRightClickSetFrequency,
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
  const interactionFrequencyModeRef = useRef(interactionFrequencyMode);
  const frequencyRangeModeRef = useRef(frequencyRangeMode);
  const referenceFrequencyRef = useRef(referenceFrequencyHz);
  const visualOffsetRef = useRef(visualFrequencyOffsetHz);
  const interactionRangeRef = useRef(interactionFrequencyRange);
  const basebandRangeRef = useRef(basebandInteractionRange);
  const overlayRefs = useRef(new Map<string, HTMLDivElement>());
  const overlayAxisTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const rulerPoolRef = useRef<Array<{ root: HTMLDivElement; line: HTMLDivElement; label: HTMLDivElement; lineClass: string; labelText: string }>>([]);
  const rulerSignatureRef = useRef<string | null>(null);
  const viewAxisRef = useRef<{ min: number; max: number } | null>(null);
  const viewportGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startRange: { min: number; max: number };
    lastRange: { min: number; max: number };
  } | null>(null);
  const pendingViewportRef = useRef<{ range: { min: number; max: number }; source: 'pan' | 'zoom' } | null>(null);
  const viewportWheelLockRef = useRef<{ axis: 'horizontal' | 'vertical'; expiresAt: number } | null>(null);
  const viewportWheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayDragRef = useRef<DragState | null>(null);
  const overlayLatestFrequencyRef = useRef<{ id: string; frequency: number } | null>(null);
  const overlayLatestBandChangeRef = useRef<{ id: string } & FrequencyBandOverlayChange | null>(null);
  const overlayCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayOverrideRef = useRef(new Map<string, number>());
  const renderRef = useRef<() => void>(() => {});
  const smoothingStartRef = useRef<number | null>(null);

  heightRef.current = height;
  minDbRef.current = minDb;
  maxDbRef.current = maxDb;
  viewportInteractionRef.current = viewportInteraction;
  frequencyAxisTransformRef.current = frequencyAxisTransform;
  interactionFrequencyModeRef.current = interactionFrequencyMode;
  frequencyRangeModeRef.current = frequencyRangeMode;
  referenceFrequencyRef.current = referenceFrequencyHz;
  visualOffsetRef.current = visualFrequencyOffsetHz;
  interactionRangeRef.current = interactionFrequencyRange;
  basebandRangeRef.current = basebandInteractionRange;

  const getSnapshot = useCallback((): SpectrumRenderSnapshot => (
    controller.getLatestRenderSnapshot()
  ), [controller]);

  const getCurrentAxis = useCallback(() => {
    if (isValidRange(viewAxisRef.current)) return viewAxisRef.current;
    const range = viewportInteractionRef.current?.range;
    if (isValidRange(range)) return range;
    return getSnapshot().axis;
  }, [getSnapshot]);

  const getDisplayFrequency = useCallback((frequency: number): number | null => {
    if (!Number.isFinite(frequency)) return null;
    if (frequencyRangeModeRef.current === 'absolute-windowed') return frequency;
    if (frequencyRangeModeRef.current !== 'baseband') {
      const reference = referenceFrequencyRef.current;
      return typeof reference === 'number' && Number.isFinite(reference) ? reference + frequency : null;
    }
    return frequency;
  }, []);

  const getPosition = useCallback((frequency: number, axis: { min: number; max: number } | null = getCurrentAxis()): number | null => {
    if (!axis || !isValidRange(axis)) return null;
    const displayFrequency = interactionFrequencyModeRef.current === 'absolute'
      ? frequency
      : getDisplayFrequency(frequency);
    if (displayFrequency === null) return null;
    return getWaterfallSemanticFrequencyPositionPercent(
      displayFrequency,
      axis.min,
      axis.max,
      frequencyAxisTransformRef.current,
      visualOffsetRef.current,
    );
  }, [getCurrentAxis, getDisplayFrequency]);

  const getAbsolutePosition = useCallback((frequency: number, axis: { min: number; max: number } | null = getCurrentAxis()): number | null => {
    if (!axis || !isValidRange(axis) || !Number.isFinite(frequency)) return null;
    return getWaterfallSemanticFrequencyPositionPercent(
      frequency,
      axis.min,
      axis.max,
      frequencyAxisTransformRef.current,
      visualOffsetRef.current,
    );
  }, [getCurrentAxis]);

  const updateOverlayPositions = useCallback((axis: { min: number; max: number } | null = getCurrentAxis()) => {
    if (!axis || !isValidRange(axis)) return;
    const setPosition = (key: string, frequency: number) => {
      const element = overlayRefs.current.get(key);
      const position = getPosition(frequency, axis);
      if (element && position !== null && Number.isFinite(position)) {
        element.style.left = `${position}%`;
      }
    };

    for (const overlay of txBandOverlays) {
      const lineFrequency = overlayOverrideRef.current.get(`tx-band:${overlay.id}`) ?? overlay.lineFrequency;
      const txBandLine = overlayRefs.current.get(`tx-band:${overlay.id}`);
      const txBandPosition = getAbsolutePosition(lineFrequency, axis);
      if (txBandLine && txBandPosition !== null && Number.isFinite(txBandPosition)) txBandLine.style.left = `${txBandPosition}%`;
      const band = overlayRefs.current.get(`tx-band:${overlay.id}:band`);
      if (band) {
        const start = lineFrequency + (overlay.rangeStartFrequency - overlay.lineFrequency);
        const end = lineFrequency + (overlay.rangeEndFrequency - overlay.lineFrequency);
        const startPosition = getAbsolutePosition(start, axis);
        const endPosition = getAbsolutePosition(end, axis);
        if (startPosition !== null && endPosition !== null) {
          const left = Math.max(0, Math.min(100, Math.min(startPosition, endPosition)));
          const right = Math.max(0, Math.min(100, Math.max(startPosition, endPosition)));
          band.style.left = `${left}%`;
          band.style.width = `${Math.max(0, right - left)}%`;
        }
      }
    }
    for (const overlay of frequencyBandOverlays) {
      const center = overlayOverrideRef.current.get(`frequency-band:${overlay.id}`) ?? overlay.centerFrequency;
      setPosition(`frequency-band:${overlay.id}`, center);
      const band = overlayRefs.current.get(`frequency-band:${overlay.id}:band`);
      if (band) {
        const startPosition = getPosition(overlay.rangeStartFrequency + (center - overlay.centerFrequency), axis);
        const endPosition = getPosition(overlay.rangeEndFrequency + (center - overlay.centerFrequency), axis);
        if (startPosition !== null && endPosition !== null) {
          const left = Math.max(0, Math.min(100, Math.min(startPosition, endPosition)));
          const right = Math.max(0, Math.min(100, Math.max(startPosition, endPosition)));
          band.style.left = `${left}%`;
          band.style.width = `${Math.max(0, right - left)}%`;
        }
      }
    }
    for (const marker of txFrequencies) {
      setPosition(`tx:${marker.operatorId}`, overlayOverrideRef.current.get(`tx:${marker.operatorId}`) ?? marker.frequency);
    }
    for (const marker of rxFrequencies) setPosition(`rx:${marker.operatorId}`, marker.frequency);
    for (const marker of presetMarkers) setPosition(`preset:${marker.id}`, marker.frequency);
  }, [frequencyBandOverlays, getAbsolutePosition, getCurrentAxis, getPosition, presetMarkers, rxFrequencies, txBandOverlays, txFrequencies]);

  const clearOverlayAxisTransition = useCallback(() => {
    if (overlayAxisTransitionTimerRef.current) {
      clearTimeout(overlayAxisTransitionTimerRef.current);
      overlayAxisTransitionTimerRef.current = null;
    }
    for (const element of overlayRefs.current.values()) element.style.transition = '';
  }, []);

  const animateOverlayAxisTransition = useCallback((durationMs: number) => {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || overlayRefs.current.size === 0) return;
    clearOverlayAxisTransition();
    const transition = `left ${Math.round(durationMs)}ms ease, width ${Math.round(durationMs)}ms ease`;
    for (const element of overlayRefs.current.values()) element.style.transition = transition;
    overlayAxisTransitionTimerRef.current = setTimeout(() => {
      overlayAxisTransitionTimerRef.current = null;
      clearOverlayAxisTransition();
    }, Math.ceil(durationMs) + 24);
  }, [clearOverlayAxisTransition]);

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

    if (!viewportGestureRef.current && !isValidRange(viewportInteractionRef.current?.range)) {
      viewAxisRef.current = { min: snapshot.axis.minHz, max: snapshot.axis.maxHz };
    }
    const viewAxis = getCurrentAxis() ?? snapshot.axis;
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
    updateOverlayPositions(viewAxis);
  }, [ensurePointData, ensureValueData, getCurrentAxis, getSnapshot, scheduleRender, updateOverlayPositions, updateRuler]);
  renderRef.current = draw;

  const invokeViewportChange = useCallback((range: { min: number; max: number }, source: 'pan' | 'zoom', phase: WaterfallViewportChangePhase): { min: number; max: number } => {
    const callback = viewportInteractionRef.current?.onChange;
    if (!callback) return range;
    const next = callback(range, source, phase);
    return isValidRange(next) ? { ...next } : range;
  }, []);

  const getFrequencyAtClientX = useCallback((clientX: number): number => {
    const axis = getCurrentAxis();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!axis || !rect || rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const displayFrequency = getWaterfallSemanticFrequencyAtRatio(
      ratio,
      axis.min,
      axis.max,
      frequencyAxisTransformRef.current,
      visualOffsetRef.current,
    );
    if (interactionFrequencyModeRef.current === 'absolute' || frequencyRangeModeRef.current === 'absolute-windowed') {
      return displayFrequency;
    }
    const baseband = displayFrequency - (referenceFrequencyRef.current ?? axis.min);
    const range = basebandRangeRef.current;
    return isValidRange(range) ? Math.max(range.min, Math.min(range.max, baseband)) : baseband;
  }, [getCurrentAxis]);

  const commitViewport = useCallback(() => {
    const pending = pendingViewportRef.current;
    if (!pending) return;
    pendingViewportRef.current = null;
    controller.setGestureViewFreeze(false);
    const effective = invokeViewportChange(pending.range, pending.source, 'commit');
    viewAxisRef.current = effective;
    viewportRuntime?.setCommittedRange(effective);
    if (viewportRuntime) requestAnimationFrame(() => viewportRuntime.clear());
    updateOverlayPositions(effective);
    scheduleRender();
  }, [controller, invokeViewportChange, scheduleRender, updateOverlayPositions, viewportRuntime]);

  const previewViewport = useCallback((range: { min: number; max: number }, source: 'pan' | 'zoom') => {
    const interaction = viewportInteractionRef.current;
    if (!interaction?.onChange || interaction.mode !== 'local-pan-zoom') return;
    const effective = interaction.supportsPreview === true
      ? invokeViewportChange(range, source, 'preview')
      : invokeViewportChange(range, source, 'commit');
    viewAxisRef.current = effective;
    updateOverlayPositions(effective);
    if (interaction.supportsPreview === true) {
      if (!pendingViewportRef.current) controller.setGestureViewFreeze(true);
      viewportRuntime?.setPreviewRange(effective);
      pendingViewportRef.current = { range: effective, source };
      if (viewportWheelCommitTimerRef.current) clearTimeout(viewportWheelCommitTimerRef.current);
      viewportWheelCommitTimerRef.current = setTimeout(() => {
        viewportWheelCommitTimerRef.current = null;
        commitViewport();
      }, TRACE_WHEEL_IDLE_MS);
    }
    scheduleRender();
  }, [commitViewport, controller, invokeViewportChange, scheduleRender, updateOverlayPositions, viewportRuntime]);

  const handleViewportPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = viewportInteractionRef.current;
    if (interaction?.mode !== 'local-pan-zoom' || !interaction.canPan || !interaction.onChange || event.button !== 0 || !event.isPrimary) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-waterfall-marker-interactive="true"]')) return;
    const axis = getCurrentAxis();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!axis || !rect || rect.width <= 0) return;
    event.preventDefault();
    viewportGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startRange: { ...axis },
      lastRange: { ...axis },
    };
  }, [getCurrentAxis]);

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const gesture = viewportGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const deltaHz = (event.clientX - gesture.startX) * (gesture.startRange.max - gesture.startRange.min) / rect.width;
      gesture.lastRange = {
        min: gesture.startRange.min - deltaHz,
        max: gesture.startRange.max - deltaHz,
      };
      previewViewport(gesture.lastRange, 'pan');
    };
    const handleUp = (event: PointerEvent) => {
      if (viewportGestureRef.current?.pointerId !== event.pointerId) return;
      viewportGestureRef.current = null;
      if (pendingViewportRef.current) commitViewport();
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    document.addEventListener('pointercancel', handleUp);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleUp);
    };
  }, [commitViewport, previewViewport]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (event: WheelEvent) => {
      const interaction = viewportInteractionRef.current;
      if (interaction?.mode !== 'local-pan-zoom' || !interaction.onChange) return;
      const now = Date.now();
      const axis = classifyWaterfallViewportWheelAxis(event, viewportWheelLockRef.current, now);
      if (!axis) return;
      const current = getCurrentAxis();
      const rect = container.getBoundingClientRect();
      if (!current || rect.width <= 0) return;
      if (axis === 'vertical' && interaction.canZoom && (!event.shiftKey && (event.ctrlKey || Math.abs(event.deltaY) >= Math.abs(event.deltaX)))) {
        event.preventDefault();
        viewportWheelLockRef.current = { axis, expiresAt: now + TRACE_WHEEL_IDLE_MS };
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const bounds = interaction.bounds;
        const span = current.max - current.min;
        const maxSpan = isValidRange(bounds) ? bounds.max - bounds.min : Number.POSITIVE_INFINITY;
        const factor = getWaterfallLocalZoomFactor(event, {
          isMac: typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent),
          pageHeightPx: typeof window !== 'undefined' ? window.innerHeight : 800,
        });
        const nextSpan = Math.max(TRACE_MIN_VIEWPORT_SPAN_HZ, Math.min(maxSpan, span * factor));
        const anchor = current.min + ratio * span;
        let nextMin = anchor - ratio * nextSpan;
        if (isValidRange(bounds)) nextMin = Math.max(bounds.min, Math.min(bounds.max - nextSpan, nextMin));
        previewViewport({ min: nextMin, max: nextMin + nextSpan }, 'zoom');
        return;
      }
      if (axis !== 'horizontal' || !interaction.canPan || !shouldHandleWaterfallHorizontalWheel(event)) return;
      event.preventDefault();
      viewportWheelLockRef.current = { axis, expiresAt: now + TRACE_WHEEL_IDLE_MS };
      const rawDelta = normalizeWaterfallWheelDeltaX(event, rect.width) || (event.shiftKey ? event.deltaY : 0);
      if (!Number.isFinite(rawDelta) || rawDelta === 0) return;
      const deltaHz = rawDelta * (current.max - current.min) / rect.width;
      previewViewport({ min: current.min + deltaHz, max: current.max + deltaHz }, 'pan');
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [getCurrentAxis, previewViewport]);

  const handleOverlayPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, state: DragState) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    const axis = getCurrentAxis();
    if (!rect || !axis || rect.width <= 0) return;
    overlayDragRef.current = state;
  }, [getCurrentAxis]);

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = overlayDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const axis = getCurrentAxis();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!axis || !rect || rect.width <= 0) return;
      const deltaHz = (event.clientX - drag.startX) * (axis.max - axis.min) / rect.width;
      if (drag.kind === 'tx' || drag.kind === 'tx-band') {
        if (!drag.exceededThreshold && Math.abs(event.clientX - drag.startX) < TRACE_DRAG_THRESHOLD_PX) return;
        drag.exceededThreshold = true;
        const frequency = drag.startFrequency + deltaHz;
        overlayOverrideRef.current.set(`${drag.kind === 'tx' ? 'tx' : 'tx-band'}:${drag.id}`, frequency);
        overlayLatestFrequencyRef.current = { id: drag.id, frequency };
        updateOverlayPositions(axis);
        if (overlayCommitTimerRef.current) clearTimeout(overlayCommitTimerRef.current);
        overlayCommitTimerRef.current = setTimeout(() => {
          const latest = overlayLatestFrequencyRef.current;
          if (!latest) return;
          if (drag.kind === 'tx') onTxFrequencyChange?.(latest.id, latest.frequency);
          else onTxBandOverlayFrequencyChange?.(latest.id, latest.frequency);
          overlayCommitTimerRef.current = null;
        }, 120);
        return;
      }

      const overlay = frequencyBandOverlays.find(item => item.id === drag.id);
      if (!overlay) return;
      const nextCenter = drag.startCenter! + deltaHz;
      const nextChange: FrequencyBandOverlayChange = {
        centerFrequency: nextCenter,
        rangeStartFrequency: nextCenter - drag.startWidth / 2,
        rangeEndFrequency: nextCenter + drag.startWidth / 2,
        widthHz: drag.startWidth,
      };
      overlayOverrideRef.current.set(`frequency-band:${drag.id}`, nextCenter);
      overlayLatestBandChangeRef.current = { id: drag.id, ...nextChange };
      updateOverlayPositions(axis);
      onFrequencyBandOverlayPreviewChange?.(drag.id, nextChange);
    };
    const handleUp = (event: PointerEvent) => {
      const drag = overlayDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      overlayDragRef.current = null;
      if (overlayCommitTimerRef.current) {
        clearTimeout(overlayCommitTimerRef.current);
        overlayCommitTimerRef.current = null;
      }
      if (drag.kind === 'tx' || drag.kind === 'tx-band') {
        const latest = overlayLatestFrequencyRef.current;
        if (latest && drag.exceededThreshold) {
          if (drag.kind === 'tx') onTxFrequencyChange?.(latest.id, latest.frequency);
          else onTxBandOverlayFrequencyChange?.(latest.id, latest.frequency);
        }
        overlayLatestFrequencyRef.current = null;
        setTimeout(() => overlayOverrideRef.current.delete(`${drag.kind === 'tx' ? 'tx' : 'tx-band'}:${drag.id}`), 400);
      } else {
        const latest = overlayLatestBandChangeRef.current;
        if (latest) {
          const { id, ...change } = latest;
          onFrequencyBandOverlayCommit?.(id, change);
        }
        overlayLatestBandChangeRef.current = null;
        overlayOverrideRef.current.delete(`frequency-band:${drag.id}`);
      }
      scheduleRender();
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    document.addEventListener('pointercancel', handleUp);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleUp);
    };
  }, [frequencyBandOverlays, getCurrentAxis, onFrequencyBandOverlayCommit, onFrequencyBandOverlayPreviewChange, onTxBandOverlayFrequencyChange, onTxFrequencyChange, scheduleRender, updateOverlayPositions]);

  useEffect(() => {
    if (!viewportInteraction?.range || viewportGestureRef.current) return;
    const previousAxis = viewAxisRef.current;
    if (
      previousAxis
      && (previousAxis.min !== viewportInteraction.range.min || previousAxis.max !== viewportInteraction.range.max)
      && !viewportRuntime?.getPreviewRange()
    ) {
      animateOverlayAxisTransition(calculateSpectrumAxisTransitionDuration(
        { minHz: previousAxis.min, maxHz: previousAxis.max, binCount: 1 },
        { minHz: viewportInteraction.range.min, maxHz: viewportInteraction.range.max, binCount: 1 },
      ));
    }
    viewAxisRef.current = { ...viewportInteraction.range };
    updateOverlayPositions(viewportInteraction.range);
    scheduleRender();
  }, [animateOverlayAxisTransition, scheduleRender, updateOverlayPositions, viewportInteraction?.range?.max, viewportInteraction?.range?.min, viewportRuntime]);

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
        updateOverlayPositions(preview);
      }
      scheduleRender();
    };
    const unsubscribe = viewportRuntime.subscribe(syncExternalPreview);
    syncExternalPreview();
    return unsubscribe;
  }, [scheduleRender, updateOverlayPositions, viewportRuntime]);

  useEffect(() => () => {
    if (viewportWheelCommitTimerRef.current) clearTimeout(viewportWheelCommitTimerRef.current);
    if (overlayCommitTimerRef.current) clearTimeout(overlayCommitTimerRef.current);
    clearOverlayAxisTransition();
    viewportRuntime?.clear();
    controller.setGestureViewFreeze(false);
  }, [clearOverlayAxisTransition, controller, viewportRuntime]);

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

  const renderAxis = getCurrentAxis();
  const markerPosition = (frequency: number) => getPosition(frequency, renderAxis);
  const ref = (key: string) => (element: HTMLDivElement | null) => {
    if (element) overlayRefs.current.set(key, element);
    else overlayRefs.current.delete(key);
  };

  const commonOverlayStyle = 'absolute top-0 h-full pointer-events-auto touch-none';
  const overlayElements = useMemo(() => ({
    txBandOverlays,
    frequencyBandOverlays,
    txFrequencies,
    rxFrequencies,
    presetMarkers,
  }), [frequencyBandOverlays, presetMarkers, rxFrequencies, txBandOverlays, txFrequencies]);

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      style={{ height: `${height}px`, touchAction: viewportInteraction?.mode === 'local-pan-zoom' ? 'none' : undefined }}
      onPointerDown={handleViewportPointerDown}
      onDoubleClick={(event) => {
        if (!onDoubleClickSetFrequency) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-waterfall-marker-interactive="true"]')) return;
        onDoubleClickSetFrequency(getFrequencyAtClientX(event.clientX));
      }}
      onContextMenu={(event) => {
        if (!onRightClickSetFrequency) return;
        event.preventDefault();
        onRightClickSetFrequency(getFrequencyAtClientX(event.clientX));
      }}
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
      <div className="pointer-events-none absolute inset-0 z-20">
        {overlayElements.txBandOverlays.map((overlay) => {
          const position = getAbsolutePosition(overlay.lineFrequency, renderAxis);
          if (position === null) return null;
          const start = getAbsolutePosition(overlay.rangeStartFrequency, renderAxis);
          const end = getAbsolutePosition(overlay.rangeEndFrequency, renderAxis);
          const draggable = Boolean(overlay.draggable && onTxBandOverlayFrequencyChange);
          return (
            <React.Fragment key={`trace-tx-band-${overlay.id}`}>
              <div ref={ref(`tx-band:${overlay.id}:band`)} className="absolute top-0 h-full bg-red-500/10" style={{ left: `${Math.max(0, Math.min(100, Math.min(start ?? position, end ?? position)))}%`, width: `${Math.max(0, Math.min(100, Math.abs((end ?? position) - (start ?? position))))}%` }} />
              <div
                ref={ref(`tx-band:${overlay.id}`)}
                className={`${commonOverlayStyle} ${draggable ? 'cursor-grab' : 'cursor-default'}`}
                style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
                data-waterfall-marker-interactive="true"
                onPointerDown={draggable ? (event) => handleOverlayPointerDown(event, {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startFrequency: overlay.lineFrequency,
                  startWidth: Math.abs(overlay.rangeEndFrequency - overlay.rangeStartFrequency),
                  kind: 'tx-band',
                  id: overlay.id,
                }) : undefined}
              >
                <div className="h-full w-0.5 bg-red-400/70" />
                {overlay.label && <div className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-1 text-[10px] font-semibold text-red-300">{overlay.label}</div>}
              </div>
            </React.Fragment>
          );
        })}
        {overlayElements.frequencyBandOverlays.map((overlay) => {
          const position = markerPosition(overlay.centerFrequency);
          if (position === null) return null;
          const draggable = Boolean(overlay.draggable && onFrequencyBandOverlayCommit);
          return (
            <React.Fragment key={`trace-frequency-band-${overlay.id}`}>
              <div ref={ref(`frequency-band:${overlay.id}:band`)} className="absolute top-0 h-full bg-cyan-400/10" style={{ left: `${position}%`, width: '0%' }} />
              <div
                ref={ref(`frequency-band:${overlay.id}`)}
                className={`${commonOverlayStyle} ${draggable ? 'cursor-grab' : 'cursor-default'}`}
                style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
                data-waterfall-marker-interactive="true"
                onPointerDown={draggable ? (event) => handleOverlayPointerDown(event, {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startFrequency: overlay.centerFrequency,
                  startCenter: overlay.centerFrequency,
                  startWidth: Math.abs(overlay.rangeEndFrequency - overlay.rangeStartFrequency),
                  kind: 'frequency-band',
                  id: overlay.id,
                  target: 'center',
                }) : undefined}
              >
                <div className="h-full w-px bg-cyan-200/60" />
                <div className="absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/60 px-1 text-[10px] text-cyan-200">{overlay.description ?? overlay.label}</div>
              </div>
            </React.Fragment>
          );
        })}
        {overlayElements.txFrequencies.map((marker) => {
          const position = markerPosition(marker.frequency);
          if (position === null) return null;
          const draggable = Boolean(onTxFrequencyChange);
          return (
            <div
              key={`trace-tx-${marker.operatorId}`}
              ref={ref(`tx:${marker.operatorId}`)}
              className={`${commonOverlayStyle} ${draggable ? 'cursor-grab' : 'cursor-default'}`}
              style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
              data-waterfall-marker-interactive="true"
              onPointerDown={draggable ? (event) => handleOverlayPointerDown(event, {
                pointerId: event.pointerId,
                startX: event.clientX,
                startFrequency: marker.frequency,
                startWidth: 0,
                kind: 'tx',
                id: marker.operatorId,
              }) : undefined}
            >
              <div className="h-full w-0.5 bg-red-400/70" />
              <div className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-1 text-[10px] font-semibold text-red-300">TX</div>
            </div>
          );
        })}
        {overlayElements.rxFrequencies.map((marker) => {
          const position = markerPosition(marker.frequency);
          if (position === null) return null;
          return (
            <div key={`trace-rx-${marker.operatorId}`} ref={ref(`rx:${marker.operatorId}`)} className={`${commonOverlayStyle} cursor-default`} style={{ left: `${position}%`, transform: 'translateX(-50%)' }} data-waterfall-marker-interactive="true">
              <div className="h-full w-0.5 bg-green-400/70" />
              <div className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-1 text-[10px] font-semibold text-green-300">RX</div>
            </div>
          );
        })}
        {overlayElements.presetMarkers.map((marker) => {
          const position = markerPosition(marker.frequency);
          if (position === null) return null;
          const clickable = Boolean(marker.clickable && onPresetMarkerClick);
          return (
            <div key={`trace-preset-${marker.id}`} ref={ref(`preset:${marker.id}`)} className={`${commonOverlayStyle} ${clickable ? 'cursor-pointer' : 'cursor-default'}`} style={{ left: `${position}%`, transform: 'translateX(-50%)' }} data-waterfall-marker-interactive="true" onClick={clickable ? (event) => { event.preventDefault(); event.stopPropagation(); onPresetMarkerClick?.(marker.frequency); } : undefined}>
              <div className="h-full w-px bg-amber-300/60" />
              <div className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-1 text-[10px] text-amber-200">{marker.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
