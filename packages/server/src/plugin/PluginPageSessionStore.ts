import { randomUUID } from 'crypto';
import type { PluginUIInstanceTarget } from '@tx5dr/plugin-api';
import type { PluginPageBoundResource } from './page-scope.js';

export interface PluginPageSession {
  sessionId: string;
  pluginName: string;
  pageId: string;
  accessScope: 'admin' | 'operator';
  instanceTarget: PluginUIInstanceTarget;
  resource?: PluginPageBoundResource;
  createdAt: number;
  expiresAt: number;
}

export class PluginPageSessionStore {
  private readonly sessions = new Map<string, PluginPageSession>();

  constructor(private readonly ttlMs = 60 * 60 * 1000) {}

  create(input: Omit<PluginPageSession, 'sessionId' | 'createdAt' | 'expiresAt'>): PluginPageSession {
    this.pruneExpired();
    const now = Date.now();
    const session: PluginPageSession = {
      ...input,
      sessionId: randomUUID(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): PluginPageSession | null {
    this.pruneExpired();
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    return session.expiresAt > Date.now() ? session : null;
  }

  touch(sessionId: string): PluginPageSession | null {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }

    session.expiresAt = Date.now() + this.ttlMs;
    return session;
  }

  listByPluginInstance(
    pluginName: string,
    instanceTarget: PluginUIInstanceTarget,
    pageId?: string,
  ): PluginPageSession[] {
    this.pruneExpired();
    return Array.from(this.sessions.values())
      .filter((session) => {
        if (session.pluginName !== pluginName) {
          return false;
        }
        if (pageId && session.pageId !== pageId) {
          return false;
        }
        return sameInstanceTarget(session.instanceTarget, instanceTarget);
      })
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

function sameInstanceTarget(
  left: PluginUIInstanceTarget,
  right: PluginUIInstanceTarget,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'global' && right.kind === 'global') {
    return true;
  }
  if (left.kind === 'operator' && right.kind === 'operator') {
    return left.operatorId === right.operatorId;
  }
  return false;
}
