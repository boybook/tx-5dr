import { EventEmitter } from 'eventemitter3';
import type { VoicePTTLock } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('VoicePTTLockManager');

export interface VoicePTTLockManagerEvents {
  lockChanged: (lock: VoicePTTLock) => void;
}

/**
 * Voice PTT exclusive lock manager.
 * Only one client can hold the PTT lock at a time.
 * Includes timeout protection and auto-release on client disconnect.
 */
export class VoicePTTLockManager extends EventEmitter<VoicePTTLockManagerEvents> {
  private lock: VoicePTTLock = {
    locked: false,
    lockedBy: null,
    lockedByLabel: null,
    lockedAt: null,
    timeoutMs: 180000, // 3 minutes
  };
  private timeoutTimer: NodeJS.Timeout | null = null;

  /**
   * Request the PTT lock for a client.
   * Returns success=true if the lock was acquired.
   */
  requestLock(clientId: string, label: string): { success: boolean; reason?: string } {
    if (this.lock.locked) {
      if (this.lock.lockedBy === clientId) {
        // Already held by this client - idempotent success
        return { success: true };
      }
      return {
        success: false,
        reason: `PTT locked by ${this.lock.lockedByLabel || 'another user'}`,
      };
    }

    this.lock = {
      locked: true,
      lockedBy: clientId,
      lockedByLabel: label || clientId,
      lockedAt: Date.now(),
      timeoutMs: this.lock.timeoutMs,
    };

    // Start timeout timer
    this.startTimeoutTimer();

    logger.info('PTT lock acquired', { clientId, label });
    this.emit('lockChanged', this.getLockState());
    return { success: true };
  }

  /**
   * Release the PTT lock.
   * Only the holder or a force release can unlock.
   */
  releaseLock(clientId: string): boolean {
    if (!this.lock.locked) {
      return true; // Already unlocked
    }

    if (this.lock.lockedBy !== clientId) {
      logger.warn('PTT release denied: not the lock holder', {
        requestor: clientId,
        holder: this.lock.lockedBy,
      });
      return false;
    }

    this.doRelease('released by holder');
    return true;
  }

  /**
   * Force release the PTT lock (timeout, admin override, or engine stop).
   */
  forceRelease(reason: string): void {
    if (!this.lock.locked) return;
    logger.warn('PTT lock force released', { reason, holder: this.lock.lockedBy });
    this.doRelease(reason);
  }

  /**
   * Handle client disconnect - auto-release if they held the lock.
   */
  handleClientDisconnect(clientId: string): void {
    if (this.lock.locked && this.lock.lockedBy === clientId) {
      logger.info('PTT lock auto-released due to client disconnect', { clientId });
      this.doRelease('client disconnected');
    }
  }

  getLockState(): VoicePTTLock {
    return { ...this.lock };
  }

  isLocked(): boolean {
    return this.lock.locked;
  }

  getLockHolder(): string | null {
    return this.lock.lockedBy;
  }

  destroy(): void {
    this.clearTimeoutTimer();
    if (this.lock.locked) {
      this.doRelease('manager destroyed');
    }
    this.removeAllListeners();
  }

  private doRelease(reason: string): void {
    this.clearTimeoutTimer();
    const previousHolder = this.lock.lockedBy;
    this.lock = {
      locked: false,
      lockedBy: null,
      lockedByLabel: null,
      lockedAt: null,
      timeoutMs: this.lock.timeoutMs,
    };
    logger.info('PTT lock released', { reason, previousHolder });
    this.emit('lockChanged', this.getLockState());
  }

  private startTimeoutTimer(): void {
    this.clearTimeoutTimer();
    this.timeoutTimer = setTimeout(() => {
      if (this.lock.locked) {
        logger.warn('PTT lock timed out', {
          holder: this.lock.lockedBy,
          timeoutMs: this.lock.timeoutMs,
        });
        this.doRelease('timeout');
      }
    }, this.lock.timeoutMs);
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }
}
