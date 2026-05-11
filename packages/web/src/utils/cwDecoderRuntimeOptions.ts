const DEFAULT_RUNTIME_BACKENDS = ['cpu'] as const;

export function normalizeCWDecoderRuntimeBackends(
  value: unknown,
  fallback: readonly string[] = DEFAULT_RUNTIME_BACKENDS,
): string[] {
  const runtimes = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  return runtimes.length > 0 ? runtimes : [...fallback];
}

export function normalizeSelectedCWDecoderRuntimeBackend(
  selected: string,
  options: readonly string[],
): string {
  if (options.includes(selected)) return selected;
  return options[0] ?? 'cpu';
}

export function getCWDecoderRuntimeLabel(runtime: string): string {
  switch (runtime) {
    case 'cpu':
      return 'CPU';
    case 'coreml':
      return 'CoreML';
    case 'cuda':
      return 'CUDA';
    case 'webgpu':
      return 'WebGPU';
    case 'directml':
      return 'DirectML';
    case 'wasm':
      return 'WASM';
    default:
      return runtime;
  }
}

export function getCWDecoderRuntimeDescription(runtime: string): string | null {
  switch (runtime) {
    case 'cuda':
      return 'Linux x64 NVIDIA GPU; requires externally installed CUDA v12 runtime.';
    case 'webgpu':
      return 'Experimental ONNX Runtime WebGPU execution provider.';
    case 'coreml':
      return 'macOS CoreML acceleration on supported Apple devices.';
    case 'cpu':
      return 'Portable CPU execution provider.';
    default:
      return null;
  }
}
