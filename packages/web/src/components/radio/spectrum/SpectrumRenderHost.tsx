import React, { useMemo, useRef } from 'react';
import { WebGLSpectrumTrace, type WebGLSpectrumTraceProps } from './WebGLSpectrumTrace';
import { WebGLWaterfall } from './WebGLWaterfall';
import { createSpectrumViewportRuntime } from '../../../spectrum/SpectrumViewportRuntime';

export type SpectrumPresentation = 'waterfall' | 'trace-waterfall';

type WaterfallProps = React.ComponentProps<typeof WebGLWaterfall>;

export interface SpectrumRenderHostProps {
  presentation?: SpectrumPresentation;
  className?: string;
  height: number;
  waterfallProps: WaterfallProps;
  traceHeight?: number;
}

function resolveTraceHeight(height: number, requested?: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(96, requested), Math.max(96, height - 48));
  }
  // Keep the trace compact in a standalone window while giving it enough
  // vertical room for a readable dB axis and peak shape.
  return Math.min(220, Math.max(112, Math.round(height * 0.27)));
}

export function resolveSpectrumWaterfallHeight(
  height: number,
  traceHeight: number,
  standalone: boolean,
): number {
  return Math.max(1, standalone ? height - traceHeight : height);
}

function createTraceProps(props: WaterfallProps, height: number, viewportRuntime?: ReturnType<typeof createSpectrumViewportRuntime>): WebGLSpectrumTraceProps {
  return {
    controller: props.controller,
    height,
    minDb: props.minDb,
    maxDb: props.maxDb,
    frequencyRangeMode: props.frequencyRangeMode,
    referenceFrequencyHz: props.referenceFrequencyHz,
    frequencyAxisTransform: props.frequencyAxisTransform,
    visualFrequencyOffsetHz: props.visualFrequencyOffsetHz,
    basebandInteractionRange: props.basebandInteractionRange,
    interactionFrequencyMode: props.interactionFrequencyMode,
    interactionFrequencyRange: props.interactionFrequencyRange,
    viewportInteraction: props.viewportInteraction,
    viewportRuntime: viewportRuntime ?? props.viewportRuntime,
    rxFrequencies: props.rxFrequencies,
    txFrequencies: props.txFrequencies,
    txBandOverlays: props.txBandOverlays,
    frequencyBandOverlays: props.frequencyBandOverlays,
    presetMarkers: props.presetMarkers,
    onTxFrequencyChange: props.onTxFrequencyChange,
    onTxBandOverlayFrequencyChange: props.onTxBandOverlayFrequencyChange,
    onFrequencyBandOverlayPreviewChange: props.onFrequencyBandOverlayPreviewChange,
    onFrequencyBandOverlayCommit: props.onFrequencyBandOverlayCommit,
    onPresetMarkerClick: props.onPresetMarkerClick,
    onDoubleClickSetFrequency: props.onDoubleClickSetFrequency,
    onRightClickSetFrequency: props.onRightClickSetFrequency,
  };
}

/**
 * Owns the presentation layout while keeping one SpectrumDisplay data model.
 * Inline pages use the existing waterfall surface. The standalone window adds
 * a WebGL trace surface and moves frequency overlays to that surface; the
 * lower waterfall remains overlay-free while sharing background viewport
 * gestures.
 */
export const SpectrumRenderHost: React.FC<SpectrumRenderHostProps> = ({
  presentation = 'waterfall',
  className = '',
  height,
  waterfallProps,
  traceHeight: requestedTraceHeight,
}) => {
  const traceHeight = resolveTraceHeight(height, requestedTraceHeight);
  const standalone = presentation === 'trace-waterfall';
  const viewportRuntimeRef = useRef(createSpectrumViewportRuntime());
  const traceProps = useMemo(
    () => createTraceProps(waterfallProps, traceHeight, viewportRuntimeRef.current),
    [traceHeight, waterfallProps],
  );
  const readOnlyWaterfallProps = useMemo<WaterfallProps>(() => {
    const waterfallHeight = resolveSpectrumWaterfallHeight(height, traceHeight, standalone);
    if (!standalone) {
      // SpectrumRenderHost owns presentation geometry. Keep the child surface
      // on the exact same height so bottom-anchored TX/RX labels are not laid
      // out against WebGLWaterfall's default height and clipped by the host.
      return {
        ...waterfallProps,
        height: waterfallHeight,
      };
    }
    const waterfallRows = typeof waterfallProps.totalRows === 'number'
      ? Math.max(1, Math.round(waterfallProps.totalRows * waterfallHeight / Math.max(height, 1)))
      : waterfallProps.totalRows;
    return {
      ...waterfallProps,
      height: waterfallHeight,
      totalRows: waterfallRows,
      rxFrequencies: [],
      txFrequencies: [],
      txBandOverlays: [],
      frequencyBandOverlays: [],
      presetMarkers: [],
      viewportInteraction: waterfallProps.viewportInteraction,
      viewportRuntime: viewportRuntimeRef.current,
      enableLocalViewportPanZoom: false,
      localViewportRange: null,
      localViewportBounds: null,
      onLocalViewportChange: undefined,
      onTxFrequencyChange: undefined,
      onTxBandOverlayFrequencyChange: undefined,
      onFrequencyBandOverlayPreviewChange: undefined,
      onFrequencyBandOverlayCommit: undefined,
      onPresetMarkerClick: undefined,
      onDragFrequencyPreview: undefined,
      onDragFrequencyChange: undefined,
      onDragFrequencyActiveChange: undefined,
      enableHorizontalWheelFrequency: false,
      onDoubleClickSetFrequency: undefined,
      onRightClickSetFrequency: undefined,
      className: 'bg-transparent',
    };
  }, [height, standalone, traceHeight, waterfallProps]);

  if (!standalone) {
    return (
      <div
        className={`relative min-h-0 shrink-0 overflow-hidden ${className}`}
        style={{ height, minHeight: height, maxHeight: height }}
      >
        <WebGLWaterfall {...readOnlyWaterfallProps} className={className || waterfallProps.className} />
      </div>
    );
  }

  return (
    <div className={`flex min-h-0 flex-col overflow-hidden ${className}`} style={{ height }}>
      <div className="relative shrink-0 overflow-hidden" style={{ height: traceHeight }}>
        <WebGLSpectrumTrace {...traceProps} className="bg-transparent" />
      </div>
      <div className="h-px shrink-0 bg-white/10" />
      <div className="min-h-0 flex-1">
        <WebGLWaterfall {...readOnlyWaterfallProps} className="h-full bg-transparent" />
      </div>
    </div>
  );
};
