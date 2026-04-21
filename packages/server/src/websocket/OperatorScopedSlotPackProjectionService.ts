import { FT8MessageParser, getBandFromFrequency } from '@tx5dr/core';
import type { FrameMessage, LogbookAnalysis, SlotPack } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import type { LogManager } from '../log/LogManager.js';
import type { CallsignContextTracker } from '../slot/CallsignContextTracker.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('OperatorScopedSlotPackProjectionService');

interface OperatorScopedSlotPackProjectionServiceDeps {
  callsignTracker: CallsignContextTracker;
  logManager: LogManager;
}

export class OperatorScopedSlotPackProjectionService {
  constructor(private readonly deps: OperatorScopedSlotPackProjectionServiceDeps) {}

  async projectSlotPack(slotPack: SlotPack, operatorId: string | null): Promise<SlotPack> {
    const projectedFrames = operatorId
      ? await Promise.all(slotPack.frames.map(async (frame) => this.projectFrame(frame, operatorId)))
      : slotPack.frames.map((frame) => this.cloneFrameWithoutAnalysis(frame));

    return {
      ...slotPack,
      frames: projectedFrames,
      stats: { ...slotPack.stats },
      decodeHistory: slotPack.decodeHistory.map((entry) => ({ ...entry })),
    };
  }

  private async projectFrame(frame: FrameMessage, operatorId: string): Promise<FrameMessage> {
    const nextFrame = this.cloneFrameWithoutAnalysis(frame);

    if (frame.snr === -999) {
      return nextFrame;
    }

    try {
      const analysis = await this.analyzeFrameForOperator(frame, operatorId);
      if (analysis) {
        nextFrame.logbookAnalysis = analysis;
      }
    } catch (error) {
      logger.warn(`failed to analyze frame for operator=${operatorId}: ${frame.message}`, error);
    }

    return nextFrame;
  }

  private cloneFrameWithoutAnalysis(frame: FrameMessage): FrameMessage {
    const { logbookAnalysis: _ignored, ...nextFrame } = frame;
    return { ...nextFrame };
  }

  private async analyzeFrameForOperator(
    frame: FrameMessage,
    operatorId: string,
  ): Promise<LogbookAnalysis | undefined> {
    const parsedMessage = FT8MessageParser.parseMessage(frame.message);

    let callsign: string | undefined;
    let grid: string | undefined;

    if ('senderCallsign' in parsedMessage && typeof parsedMessage.senderCallsign === 'string') {
      callsign = parsedMessage.senderCallsign;
    }

    if (parsedMessage.type === 'cq' || parsedMessage.type === 'call') {
      grid = parsedMessage.grid;
    }

    if (!callsign) {
      return undefined;
    }

    if (!grid) {
      grid = this.deps.callsignTracker.getGrid(callsign);
    }

    const logBook = await this.deps.logManager.getOperatorLogBook(operatorId);
    if (!logBook) {
      return undefined;
    }

    const band = this.getCurrentBand();
    const canAnalyzeGridByBand = Boolean(grid && band && band !== 'Unknown');
    const analysis = await logBook.provider.analyzeCallsign(callsign, grid, { band });

    return {
      isNewCallsign: analysis.isNewCallsign,
      isNewDxccEntity: analysis.isNewDxccEntity,
      isNewBandDxccEntity: analysis.isNewBandDxccEntity,
      isConfirmedDxcc: analysis.isConfirmedDxcc,
      isNewGrid: canAnalyzeGridByBand ? analysis.isNewGrid : undefined,
      callsign,
      grid,
      prefix: analysis.prefix,
      state: analysis.state,
      stateConfidence: analysis.stateConfidence,
      dxccId: analysis.dxccId,
      dxccEntity: analysis.dxccEntity,
      dxccStatus: analysis.dxccStatus,
    };
  }

  private getCurrentBand(): string {
    try {
      const last = ConfigManager.getInstance().getLastSelectedFrequency();
      if (last?.frequency && last.frequency > 1_000_000) {
        return getBandFromFrequency(last.frequency);
      }
    } catch (error) {
      logger.debug('Failed to resolve current band for slot pack projection', error);
    }

    return 'Unknown';
  }
}
