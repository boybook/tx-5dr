import { randomUUID } from 'node:crypto';
import type {
  ParsedFT8Message,
  StrategyQSOCompletionEffect,
} from '@tx5dr/plugin-api';
import { FT8MessageType } from '@tx5dr/plugin-api';
import { FT8MessageParser } from '@tx5dr/core';
import {
  buildWWDigiGrid,
  buildWWDigiRogerGrid,
  buildWWDigiRR73,
  parseWWDigiMessage,
} from './protocol.js';

export type WWDigiProtocolPhase =
  | 'wait-r-grid'
  | 'wait-rr73'
  | 'wait-standard-final'
  | 'send-rr73';

export interface WWDigiProtocolConfig {
  myCallsign: string;
  myGrid: string;
  modeName: 'FT8' | 'FT4';
}

export interface WWDigiProtocolContext {
  version: 1;
  contextId: string;
  callsign: string;
  phase: WWDigiProtocolPhase;
  startedAt: number;
  lastActivityAt: number;
  audioFrequencyHz: number;
  targetGrid?: string;
  reportSnr?: number;
  hasDirectedReply: boolean;
  lastReceivedText?: string;
  lastPhysicalText?: string;
  lastPhysicalPhase?: WWDigiProtocolPhase;
  outgoingOverride?: string;
  messageHistory: string[];
}

export interface WWDigiContextReduction {
  context: WWDigiProtocolContext;
  changed: boolean;
  completed: boolean;
}

interface InitializeContextInput {
  callsign: string;
  audioFrequencyHz: number;
  now: number;
  lastMessageRaw?: string;
  lastMessageAt?: number;
  targetGrid?: string;
  lastSnr?: number;
  alternateText?: string;
}

function callsignMatches(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toUpperCase() === right.trim().toUpperCase());
}

function cloneContext(context: WWDigiProtocolContext): WWDigiProtocolContext {
  return structuredClone(context);
}

function appendInbound(context: WWDigiProtocolContext, rawMessage: string): void {
  if (context.messageHistory[context.messageHistory.length - 1] !== rawMessage) {
    context.messageHistory.push(rawMessage);
  }
  context.hasDirectedReply = true;
  context.lastReceivedText = rawMessage;
  context.outgoingOverride = undefined;
}

function hasPhysicalResponseForCurrentPhase(context: WWDigiProtocolContext): boolean {
  return context.lastPhysicalPhase === context.phase;
}

export function isWWDigiProtocolContext(value: unknown): value is WWDigiProtocolContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Partial<WWDigiProtocolContext>;
  return context.version === 1
    && typeof context.contextId === 'string'
    && typeof context.callsign === 'string'
    && ['wait-r-grid', 'wait-rr73', 'wait-standard-final', 'send-rr73'].includes(context.phase ?? '')
    && Number.isFinite(context.startedAt)
    && Number.isFinite(context.lastActivityAt)
    && Number.isFinite(context.audioFrequencyHz)
    && Array.isArray(context.messageHistory);
}

export function initializeWWDigiProtocolContext(
  input: InitializeContextInput,
  config: WWDigiProtocolConfig,
): WWDigiProtocolContext {
  const callsign = input.callsign.trim().toUpperCase();
  const messageAt = input.lastMessageAt ?? input.now;
  const context: WWDigiProtocolContext = {
    version: 1,
    contextId: randomUUID(),
    callsign,
    phase: 'wait-r-grid',
    startedAt: input.now,
    lastActivityAt: input.lastMessageRaw ? messageAt : input.now,
    audioFrequencyHz: input.audioFrequencyHz,
    targetGrid: input.targetGrid,
    reportSnr: input.lastSnr,
    hasDirectedReply: false,
    outgoingOverride: input.alternateText,
    messageHistory: input.lastMessageRaw ? [input.lastMessageRaw] : [],
  };

  if (!input.lastMessageRaw || input.alternateText) return context;
  const parsed = parseWWDigiMessage(input.lastMessageRaw);
  const standard = FT8MessageParser.parseMessage(input.lastMessageRaw);
  if (standard.type === FT8MessageType.SIGNAL_REPORT
      && callsignMatches(standard.targetCallsign, config.myCallsign)
      && callsignMatches(standard.senderCallsign, callsign)) {
    context.phase = 'wait-standard-final';
    context.hasDirectedReply = true;
    context.lastReceivedText = input.lastMessageRaw;
    return context;
  }
  if (parsed.type === 'grid'
      && callsignMatches(parsed.targetCallsign, config.myCallsign)
      && callsignMatches(parsed.senderCallsign, callsign)) {
    context.phase = 'wait-rr73';
    context.targetGrid = parsed.grid;
    context.hasDirectedReply = true;
    context.lastReceivedText = input.lastMessageRaw;
    return context;
  }
  if (parsed.type === 'roger-grid'
      && callsignMatches(parsed.targetCallsign, config.myCallsign)
      && callsignMatches(parsed.senderCallsign, callsign)) {
    context.phase = 'send-rr73';
    context.targetGrid = parsed.grid;
    context.hasDirectedReply = true;
    context.lastReceivedText = input.lastMessageRaw;
    return context;
  }
  if (parsed.type === 'cq' && callsignMatches(parsed.senderCallsign, callsign)) {
    context.targetGrid = parsed.grid;
  }
  return context;
}

export function deriveWWDigiTransmission(
  context: WWDigiProtocolContext,
  config: WWDigiProtocolConfig,
  phase = context.phase,
): string {
  if (phase === context.phase && context.outgoingOverride) return context.outgoingOverride;
  if (phase === 'wait-r-grid') {
    return buildWWDigiGrid(context.callsign, config.myCallsign, config.myGrid);
  }
  if (phase === 'wait-rr73') {
    return buildWWDigiRogerGrid(context.callsign, config.myCallsign, config.myGrid);
  }
  if (phase === 'wait-standard-final') {
    return FT8MessageParser.generateMessage({
      type: FT8MessageType.ROGER_REPORT,
      senderCallsign: config.myCallsign,
      targetCallsign: context.callsign,
      report: context.reportSnr ?? 0,
    });
  }
  return buildWWDigiRR73(context.callsign, config.myCallsign);
}

export function reduceWWDigiInbound(
  source: WWDigiProtocolContext,
  message: ParsedFT8Message,
  config: WWDigiProtocolConfig,
): WWDigiContextReduction {
  const context = cloneContext(source);
  const parsed = parseWWDigiMessage(message.rawMessage);
  const standard = message.message;
  const parsedSender = 'senderCallsign' in parsed ? parsed.senderCallsign : undefined;
  const parsedTarget = 'targetCallsign' in parsed ? parsed.targetCallsign : undefined;
  const standardSender = 'senderCallsign' in standard ? standard.senderCallsign : undefined;
  const standardTarget = 'targetCallsign' in standard ? standard.targetCallsign : undefined;
  const sender = parsedSender ?? standardSender;
  const target = parsedTarget ?? standardTarget;
  if (!callsignMatches(sender, context.callsign)
      || !callsignMatches(target, config.myCallsign)) {
    return { context, changed: false, completed: false };
  }

  const previousPhase = context.phase;
  if (parsed.type === 'roger-grid') {
    appendInbound(context, message.rawMessage);
    context.phase = 'send-rr73';
    context.targetGrid = parsed.grid;
  } else if (parsed.type === 'grid') {
    appendInbound(context, message.rawMessage);
    context.phase = 'wait-rr73';
    context.targetGrid = parsed.grid;
  } else if (standard.type === FT8MessageType.SIGNAL_REPORT) {
    appendInbound(context, message.rawMessage);
    context.phase = 'wait-standard-final';
    context.reportSnr = message.snr;
  } else {
    const isFinal = parsed.type === 'rr73'
      || standard.type === FT8MessageType.RRR
      || standard.type === FT8MessageType.SEVENTY_THREE;
    if (!isFinal
        || (context.phase !== 'wait-rr73' && context.phase !== 'wait-standard-final')
        || !hasPhysicalResponseForCurrentPhase(context)) {
      return { context, changed: false, completed: false };
    }
    appendInbound(context, message.rawMessage);
    context.lastActivityAt = message.timestamp;
    return { context, changed: true, completed: true };
  }

  context.lastActivityAt = message.timestamp;
  return {
    context,
    changed: previousPhase !== context.phase
      || source.lastReceivedText !== context.lastReceivedText
      || source.targetGrid !== context.targetGrid
      || source.reportSnr !== context.reportSnr
      || source.lastActivityAt !== context.lastActivityAt,
    completed: false,
  };
}

export function reduceWWDigiPhysicalSuccess(
  source: WWDigiProtocolContext,
  text: string,
  timestamp: number,
  audioFrequencyHz = source.audioFrequencyHz,
): WWDigiContextReduction {
  const context = cloneContext(source);
  context.messageHistory.push(text);
  context.lastPhysicalText = text;
  context.lastPhysicalPhase = context.phase;
  context.audioFrequencyHz = audioFrequencyHz;
  context.lastActivityAt = timestamp;
  return {
    context,
    changed: true,
    completed: context.phase === 'send-rr73' && context.hasDirectedReply,
  };
}

export function setWWDigiProtocolPhase(
  source: WWDigiProtocolContext,
  phase: WWDigiProtocolPhase,
): WWDigiProtocolContext {
  return { ...cloneContext(source), phase, outgoingOverride: undefined };
}

export function setWWDigiOutgoingOverride(
  source: WWDigiProtocolContext,
  text: string,
): WWDigiProtocolContext {
  return { ...cloneContext(source), outgoingOverride: text };
}

export function buildWWDigiCompletionEffect(
  context: WWDigiProtocolContext,
  input: {
    streamId: string;
    lifecycleEpoch: number;
    endTime: number;
    authorizationId?: string;
    recoveredFinalAcknowledgement?: boolean;
  },
  config: WWDigiProtocolConfig,
): StrategyQSOCompletionEffect {
  return {
    streamId: input.streamId,
    lifecycleEpoch: input.lifecycleEpoch,
    persistencePolicy: 'preserve-distinct',
    metadata: {
      authorizationId: input.authorizationId,
      streamId: input.streamId,
      ...(input.recoveredFinalAcknowledgement ? { recoveredFinalAcknowledgement: true } : {}),
    },
    record: {
      id: context.contextId,
      callsign: context.callsign,
      grid: context.targetGrid,
      frequency: context.audioFrequencyHz,
      mode: config.modeName,
      startTime: context.startedAt,
      endTime: input.endTime,
      messageHistory: [...context.messageHistory],
      myCallsign: config.myCallsign,
      myGrid: config.myGrid,
      contestId: 'WW-DIGI',
    },
  };
}
