import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';
import type { DigitalMessagePreflightRequest, DigitalMessagePreflightResult } from '@tx5dr/plugin-api';
import { WSJTXNativeGate } from './WSJTXNativeGate.js';
import { digitalMessageTextsMatch, normalizeDigitalMessageText } from './digitalMessageValidation.js';

export class DigitalMessagePreflightService {
  private readonly lib = new WSJTXLib({ maxThreads: 2 });

  async check(request: DigitalMessagePreflightRequest): Promise<DigitalMessagePreflightResult> {
    const requestedText = normalizeDigitalMessageText(request.text);
    if (!requestedText) return { encodable: false, requestedText, reason: 'empty' };
    try {
      const mode = request.mode === 'FT4' ? WSJTXMode.FT4 : WSJTXMode.FT8;
      const result = await WSJTXNativeGate.run(() => this.lib.encode(mode, requestedText, 1500));
      const transmittedText = normalizeDigitalMessageText(result.messageSent ?? '');
      if (!digitalMessageTextsMatch(requestedText, transmittedText)) {
        return { encodable: false, requestedText, transmittedText, reason: 'encoder_changed_text' };
      }
      if (!result.audioData || result.audioData.length === 0) {
        return { encodable: false, requestedText, transmittedText, reason: 'encode_failed', error: 'empty_audio' };
      }
      return { encodable: true, requestedText, transmittedText };
    } catch (error) {
      return {
        encodable: false,
        requestedText,
        reason: 'encode_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
