/**
 * Shared utility functions for autocall built-in plugins.
 *
 * Internal only — not exported to @tx5dr/plugin-api.
 */
import {
  FT8MessageType,
  type FrameMessage,
  type ParsedFT8Message,
  type PluginContext,
} from '@tx5dr/plugin-api';

export type TriggerMode = 'cq' | 'cq-or-signoff' | 'any';

export function getTriggerMode(ctx: PluginContext): TriggerMode {
  const value = ctx.config.triggerMode;
  if (value === 'any' || value === 'cq-or-signoff') {
    return value;
  }
  return 'cq';
}

export function getAutocallPriority(ctx: PluginContext, defaultValue: number): number {
  return typeof ctx.config.autocallPriority === 'number'
    ? ctx.config.autocallPriority
    : defaultValue;
}

export function getSenderCallsign(message: ParsedFT8Message['message']): string {
  if ('senderCallsign' in message && typeof message.senderCallsign === 'string') {
    return message.senderCallsign.toUpperCase();
  }
  return '';
}

export function getTargetCallsign(message: ParsedFT8Message['message']): string {
  if ('targetCallsign' in message && typeof message.targetCallsign === 'string') {
    return message.targetCallsign.toUpperCase();
  }
  return '';
}

export function isPureStandby(ctx: PluginContext): boolean {
  if (ctx.operator.isTransmitting) {
    return false;
  }

  const automation = ctx.operator.automation;
  if (!automation) {
    return true;
  }

  const targetCallsign = typeof automation.context?.targetCallsign === 'string'
    ? automation.context.targetCallsign.trim()
    : '';
  return automation.currentState === 'TX6' && targetCallsign.length === 0;
}

export function shouldTriggerMessage(
  parsedMessage: ParsedFT8Message,
  ctx: PluginContext,
  triggerMode: TriggerMode,
): boolean {
  const message = parsedMessage.message;
  const myCallsign = ctx.operator.callsign.toUpperCase();
  if (getTargetCallsign(message) === myCallsign) {
    return true;
  }

  if (message.type === FT8MessageType.CQ) {
    return true;
  }

  if (triggerMode === 'any') {
    return true;
  }

  if (triggerMode === 'cq-or-signoff') {
    return message.type === FT8MessageType.RRR || message.type === FT8MessageType.SEVENTY_THREE;
  }

  return false;
}

export function toFrameMessage(parsedMessage: ParsedFT8Message): FrameMessage {
  return {
    snr: parsedMessage.snr,
    freq: parsedMessage.df,
    dt: parsedMessage.dt,
    message: parsedMessage.rawMessage,
    confidence: 1,
    logbookAnalysis: parsedMessage.logbookAnalysis,
  };
}
