import React, { useMemo, useRef } from 'react';
import { WebGLSpectrumTrace } from './WebGLSpectrumTrace';
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

const TRACE_DIVIDER_HEIGHT_PX = 1;

function resolveTraceHeight(height: number, requested?: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(96, requested), Math.max(96, height - 48));
  }
  // Keep the trace compact in a standalone window while giving it enough
  // vertical room for a readable dB axis and peak shape.
  return Math.min(220, Math.max(112, Math.round(height * 0.27)));
}

/** Height available to waterfall rows below the optional trace header. */
export function resolveSpectrumWaterfallHeight(
  height: number,
  traceHeight: number,
  standalone: boolean,
): number {
  return Math.max(1, standalone ? height - traceHeight : height);
}

/**
 * Owns the presentation layout while keeping one SpectrumDisplay data model.
 * Inline pages use the existing waterfall surface. The standalone window
 * mounts the render-only trace as the waterfall's header, so one overlay and
 * interaction layer spans both: markers, hover probe, popovers, overlay drags,
 * click-to-tune and viewport gestures behave identically above and below. The
 * shared viewport runtime only carries live viewport previews to the trace.
 */
export const SpectrumRenderHost: React.FC<SpectrumRenderHostProps> = ({
  presentation = 'waterfall',
  className = '',
  height,
  waterfallProps,
  traceHeight: requestedTraceHeight,
}) => {
  const standalone = presentation === 'trace-waterfall';
  const traceHeight = resolveTraceHeight(height, requestedTraceHeight);
  const headerHeight = standalone ? traceHeight + TRACE_DIVIDER_HEIGHT_PX : 0;
  const viewportRuntimeRef = useRef(createSpectrumViewportRuntime());

  const header = useMemo(() => {
    if (!standalone) return undefined;
    return (
      <div className="flex h-full flex-col">
        <WebGLSpectrumTrace
          controller={waterfallProps.controller}
          height={traceHeight}
          minDb={waterfallProps.minDb}
          maxDb={waterfallProps.maxDb}
          frequencyAxisTransform={waterfallProps.frequencyAxisTransform}
          visualFrequencyOffsetHz={waterfallProps.visualFrequencyOffsetHz}
          viewportInteraction={waterfallProps.viewportInteraction}
          viewportRuntime={viewportRuntimeRef.current}
          className="shrink-0 bg-transparent"
        />
        <div className="h-px shrink-0 bg-white/10" />
      </div>
    );
  }, [
    standalone,
    traceHeight,
    waterfallProps.controller,
    waterfallProps.frequencyAxisTransform,
    waterfallProps.maxDb,
    waterfallProps.minDb,
    waterfallProps.viewportInteraction,
    waterfallProps.visualFrequencyOffsetHz,
  ]);

  const surfaceWaterfallProps = useMemo<WaterfallProps>(() => {
    if (!standalone) {
      // SpectrumRenderHost owns presentation geometry. Keep the child surface
      // on the exact same height so bottom-anchored TX/RX labels are not laid
      // out against WebGLWaterfall's default height and clipped by the host.
      return { ...waterfallProps, height };
    }
    const rowsHeight = resolveSpectrumWaterfallHeight(height, headerHeight, true);
    const waterfallRows = typeof waterfallProps.totalRows === 'number'
      ? Math.max(1, Math.round(waterfallProps.totalRows * rowsHeight / Math.max(height, 1)))
      : waterfallProps.totalRows;
    return {
      ...waterfallProps,
      height,
      header,
      headerHeight,
      totalRows: waterfallRows,
      viewportRuntime: viewportRuntimeRef.current,
      // Only the negotiated viewport drives both surfaces.
      enableLocalViewportPanZoom: false,
      localViewportRange: null,
      localViewportBounds: null,
      onLocalViewportChange: undefined,
      className: 'bg-transparent',
    };
  }, [header, headerHeight, height, standalone, waterfallProps]);

  if (!standalone) {
    return (
      <div
        className={`relative min-h-0 shrink-0 overflow-hidden ${className}`}
        style={{ height, minHeight: height, maxHeight: height }}
      >
        <WebGLWaterfall {...surfaceWaterfallProps} className={className || waterfallProps.className} />
      </div>
    );
  }

  return (
    <div className={`relative min-h-0 overflow-hidden ${className}`} style={{ height }}>
      <WebGLWaterfall {...surfaceWaterfallProps} className="h-full bg-transparent" />
    </div>
  );
};
