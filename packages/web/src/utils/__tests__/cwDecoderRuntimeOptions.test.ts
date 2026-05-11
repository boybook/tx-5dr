import { describe, expect, it } from 'vitest';
import {
  getCWDecoderRuntimeDescription,
  getCWDecoderRuntimeLabel,
  normalizeCWDecoderRuntimeBackends,
  normalizeSelectedCWDecoderRuntimeBackend,
} from '../cwDecoderRuntimeOptions';

describe('CW decoder runtime options', () => {
  it('normalizes backend descriptor runtime lists for the settings select', () => {
    expect(normalizeCWDecoderRuntimeBackends(['cpu', 'cuda', 'webgpu'])).toEqual(['cpu', 'cuda', 'webgpu']);
    expect(normalizeCWDecoderRuntimeBackends(undefined)).toEqual(['cpu']);
  });

  it('keeps CUDA/WebGPU selections when the backend advertises them', () => {
    const options = normalizeCWDecoderRuntimeBackends(['cpu', 'cuda', 'webgpu']);

    expect(normalizeSelectedCWDecoderRuntimeBackend('cuda', options)).toBe('cuda');
    expect(normalizeSelectedCWDecoderRuntimeBackend('webgpu', options)).toBe('webgpu');
    expect(normalizeSelectedCWDecoderRuntimeBackend('coreml', options)).toBe('cpu');
  });

  it('labels GPU runtimes and provides dependency hints', () => {
    expect(getCWDecoderRuntimeLabel('cuda')).toBe('CUDA');
    expect(getCWDecoderRuntimeLabel('webgpu')).toBe('WebGPU');
    expect(getCWDecoderRuntimeDescription('cuda')).toContain('CUDA v12');
    expect(getCWDecoderRuntimeDescription('webgpu')).toContain('Experimental');
  });
});
