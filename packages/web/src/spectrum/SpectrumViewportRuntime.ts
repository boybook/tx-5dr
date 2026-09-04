export interface SpectrumViewportRange {
  min: number;
  max: number;
}

export interface SpectrumViewportRuntime {
  getPreviewRange(): SpectrumViewportRange | null;
  getPhase(): 'preview' | 'commit-hold' | null;
  setPreviewRange(range: SpectrumViewportRange | null): void;
  setCommittedRange(range: SpectrumViewportRange): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

/**
 * Small imperative bridge shared by multiple render surfaces in one
 * presentation. Preview ranges never enter React state or server negotiation;
 * they are broadcast only to sibling renderers so a trace and waterfall stay
 * visually locked during the same gesture.
 */
export function createSpectrumViewportRuntime(): SpectrumViewportRuntime {
  let previewRange: SpectrumViewportRange | null = null;
  let phase: 'preview' | 'commit-hold' | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getPreviewRange: () => previewRange,
    getPhase: () => phase,
    setPreviewRange: (range) => {
      if (
        phase === (range ? 'preview' : null)
        && ((previewRange === null && range === null)
          || (previewRange && range && previewRange.min === range.min && previewRange.max === range.max))
      ) {
        return;
      }
      previewRange = range ? { ...range } : null;
      phase = range ? 'preview' : null;
      notify();
    },
    setCommittedRange: (range) => {
      previewRange = { ...range };
      phase = 'commit-hold';
      notify();
    },
    clear: () => {
      if (previewRange === null && phase === null) return;
      previewRange = null;
      phase = null;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
