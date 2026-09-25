import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FT8MessageParser, getBandFromFrequency } from '@tx5dr/core';
import { IncompleteQsoCandidateSchema, IncompleteQsoSummarySchema,
  type IncompleteQsoCandidate, type IncompleteQsoMessage, type IncompleteQsoQuery } from '@tx5dr/contracts';
import { SafeFileWriter } from '../utils/persistence/SafeFileWriter.js';

export interface ReviewRxSlot {
  mode: 'FT8' | 'FT4';
  startMs: number;
  frequency: number;
  frames: Array<{ message: string; snr: number; freq: number; confidence: number }>;
}

export interface ReviewTxFact {
  operatorId: string;
  logBookId: string;
  myCallsign: string;
  mode: 'FT8' | 'FT4';
  startMs: number;
  frequency: number;
  audioOffsetHz: number;
  text: string;
}

interface Summary {
  id: string;
  revision: number;
  logBookId: string;
  myCallsign: string;
  callsign: string;
  mode: 'FT8' | 'FT4';
  frequency: number;
  startTime: number;
  endTime: number;
  status: IncompleteQsoCandidate['status'];
  linkedQsoId?: string;
  commitRequested?: boolean;
  syncQueued?: boolean;
}

interface Observation {
  slotStartMs: number;
  direction: 'rx' | 'tx';
  text: string;
  sender: string;
  target: string;
  report?: string;
  mode: 'FT8' | 'FT4';
  frequency: number;
  audioOffsetHz: number;
  snr?: number;
  confidence?: number;
}

interface Attempt {
  operatorId: string;
  logBookId: string;
  myCallsign: string;
  callsign: string;
  mode: 'FT8' | 'FT4';
  frequency: number;
  messages: Observation[];
  candidateId?: string;
}

interface CompletedContact {
  logBookId: string;
  callsign: string;
  myCallsign: string;
  mode: string;
  frequency: number;
  startTime: number;
  qsoId: string;
}

const WINDOW_MS = 5 * 60_000;
const MAX_RECENT_RX = 2_000;
const MAX_ATTEMPTS = 500;

function parseObservation(input: Omit<Observation, 'sender' | 'target' | 'report'>): Observation | null {
  if (FT8MessageParser.rawContainsUndecodedCallsign(input.text)) return null;
  const parsed = FT8MessageParser.parseMessage(input.text);
  if (!('senderCallsign' in parsed) || typeof parsed.senderCallsign !== 'string') return null;
  if (!['cq', 'call', 'signal_report', 'roger_report', 'rrr', '73'].includes(parsed.type)) return null;
  const target = parsed.type === 'cq' ? 'CQ'
    : 'targetCallsign' in parsed && typeof parsed.targetCallsign === 'string'
      ? parsed.targetCallsign.toUpperCase() : null;
  if (!target) return null;
  const reportToken = input.text.trim().split(/\s+/).at(-1);
  return {
    ...input,
    sender: parsed.senderCallsign.toUpperCase(),
    target,
    ...(('report' in parsed && typeof parsed.report === 'number' && reportToken)
      ? { report: reportToken.replace(/^R(?=[+-]?\d)/, '') } : {}),
  };
}

function summary(record: IncompleteQsoCandidate): Summary {
  const { id, revision, logBookId, myCallsign, callsign, mode, frequency, startTime,
    endTime, status, linkedQsoId, commitRequested, syncQueued } = record;
  return { id, revision, logBookId, myCallsign, callsign, mode, frequency, startTime,
    endTime, status, linkedQsoId, commitRequested, syncQueued };
}

function monthOf(time: number): string {
  return new Date(time).toISOString().slice(0, 7);
}

function candidateFile(root: string, record: Pick<IncompleteQsoCandidate, 'myCallsign' | 'startTime' | 'id'>): string {
  return path.join(root, encodeURIComponent(record.myCallsign), monthOf(record.startTime), `${record.id}.json`);
}

export class IncompleteQsoWorkerStore {
  private readonly writer = new SafeFileWriter({ backups: 1 });
  private readonly indexes = new Map<string, Map<string, Summary>>();
  private readonly byId = new Map<string, Summary>();
  private readonly orderedMonths = new Map<string, Summary[]>();
  private readonly pendingByPair = new Map<string, Set<string>>();
  private readonly attempts = new Map<string, Attempt>();
  private recentRx: Observation[] = [];
  private recentCompleted: CompletedContact[] = [];

  constructor(private readonly root: string) {}

  private pairKey(item: Pick<Summary, 'logBookId' | 'myCallsign' | 'callsign' | 'mode' | 'frequency'>): string {
    return `${item.logBookId}:${item.myCallsign}:${item.callsign}:${item.mode}:${getBandFromFrequency(item.frequency)}`;
  }

  private indexSummary(item: Summary, previous?: Summary): void {
    if (previous?.status === 'pending') {
      const key = this.pairKey(previous);
      const ids = this.pendingByPair.get(key);
      ids?.delete(previous.id);
      if (ids?.size === 0) this.pendingByPair.delete(key);
    }
    this.byId.set(item.id, item);
    if (item.status === 'pending') {
      const key = this.pairKey(item);
      const ids = this.pendingByPair.get(key) ?? new Set<string>();
      ids.add(item.id);
      this.pendingByPair.set(key, ids);
    }
  }

  private rebuildMonthOrder(key: string): void {
    const month = this.indexes.get(key);
    this.orderedMonths.set(key, [...(month?.values() ?? [])]
      .sort((a, b) => b.startTime - a.startTime || b.id.localeCompare(a.id)));
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const station of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!station.isDirectory()) continue;
      const stationPath = path.join(this.root, station.name);
      for (const month of await fs.readdir(stationPath, { withFileTypes: true })) {
        if (!month.isDirectory() || !/^\d{4}-\d{2}$/.test(month.name)) continue;
        await this.loadMonth(station.name, month.name);
      }
    }
  }

  private async loadMonth(station: string, month: string): Promise<void> {
    const key = `${station}/${month}`;
    const dir = path.join(this.root, station, month);
    const indexFile = path.join(dir, 'index.json');
    const files = (await fs.readdir(dir)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    let index: Map<string, Summary> | undefined;
    try {
      const [raw, indexStat] = await Promise.all([fs.readFile(indexFile, 'utf8'), fs.stat(indexFile)]);
      const values = IncompleteQsoSummarySchema.array().parse(JSON.parse(raw));
      if (!Array.isArray(values) || values.length !== files.length) throw new Error('Index count mismatch');
      index = new Map(values.map(value => [value.id, value]));
      if (files.some(name => !index!.has(name.slice(0, -5)))) throw new Error('Index identity mismatch');
      for (const name of files) {
        if ((await fs.stat(path.join(dir, name))).mtimeMs > indexStat.mtimeMs) {
          throw new Error('Index older than candidate');
        }
      }
    } catch {
      index = new Map();
      for (const name of files) {
        try {
          const record = IncompleteQsoCandidateSchema.parse(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')));
          index.set(record.id, summary(record));
        } catch { /* A corrupt candidate remains untouched for operator recovery. */ }
      }
      await this.writer.writeFile(indexFile, JSON.stringify([...index.values()]));
    }
    this.indexes.set(key, index);
    for (const value of index.values()) this.indexSummary(value);
    this.rebuildMonthOrder(key);
  }

  private async save(record: IncompleteQsoCandidate): Promise<IncompleteQsoCandidate> {
    const validated = IncompleteQsoCandidateSchema.parse(record);
    const file = candidateFile(this.root, validated);
    await this.writer.writeFile(file, JSON.stringify(validated));
    const key = `${encodeURIComponent(validated.myCallsign)}/${monthOf(validated.startTime)}`;
    const index = this.indexes.get(key) ?? new Map<string, Summary>();
    const previous = index.get(validated.id);
    const next = summary(validated);
    index.set(validated.id, next);
    this.indexes.set(key, index);
    this.indexSummary(next, previous);
    this.rebuildMonthOrder(key);
    await this.writer.writeFile(path.join(path.dirname(file), 'index.json'), JSON.stringify([...index.values()]));
    return validated;
  }

  async get(id: string, logBookId?: string): Promise<IncompleteQsoCandidate | null> {
    const found = this.byId.get(id);
    if (found && logBookId && found.logBookId !== logBookId) return null;
    if (!found) return null;
    return IncompleteQsoCandidateSchema.parse(JSON.parse(await fs.readFile(candidateFile(this.root, found), 'utf8')));
  }

  list(logBookId: string, query: IncompleteQsoQuery): { items: Summary[]; nextCursor?: string } {
    const [cursorTime, ...cursorIdParts] = query.cursor?.split(':') ?? [];
    const cursorId = cursorIdParts.join(':');
    const items: Summary[] = [];
    for (const monthKey of [...this.orderedMonths.keys()].sort((a, b) =>
      b.slice(-7).localeCompare(a.slice(-7)) || a.localeCompare(b))) {
      const month = monthKey.slice(-7);
      if (query.from !== undefined && `${month}-31` < new Date(query.from).toISOString().slice(0, 10)) continue;
      if (query.until !== undefined && `${month}-01` > new Date(query.until).toISOString().slice(0, 10)) continue;
      for (const item of this.orderedMonths.get(monthKey)!) {
        if (item.logBookId !== logBookId || item.status !== query.status
          || (query.callsign && !item.callsign.includes(query.callsign.trim().toUpperCase()))
          || (query.mode && item.mode !== query.mode)
          || (query.from !== undefined && item.startTime < query.from)
          || (query.until !== undefined && item.startTime > query.until)
          || (cursorTime !== undefined && (item.startTime > Number(cursorTime)
            || (item.startTime === Number(cursorTime) && item.id >= cursorId)))) continue;
        items.push(item);
        if (items.length > query.limit) {
          const page = items.slice(0, query.limit);
          return { items: page, nextCursor: `${page.at(-1)!.startTime}:${page.at(-1)!.id}` };
        }
      }
    }
    return { items };
  }

  async update(id: string, logBookId: string, revision: number, patch: Partial<IncompleteQsoCandidate>): Promise<IncompleteQsoCandidate> {
    const current = await this.get(id, logBookId);
    if (!current || current.revision !== revision) throw new Error('REVIEW_CANDIDATE_CHANGED');
    return this.save({ ...current, ...patch, id, logBookId, revision: revision + 1 });
  }

  async linkQso(logBookId: string, record: { id: string; callsign: string; myCallsign?: string; mode: string; frequency: number; startTime: number }): Promise<void> {
    if (!record.myCallsign || (record.mode !== 'FT8' && record.mode !== 'FT4')) return;
    this.recentCompleted.push({ logBookId, callsign: record.callsign.toUpperCase(),
      myCallsign: record.myCallsign.toUpperCase(), mode: record.mode, frequency: record.frequency,
      startTime: record.startTime, qsoId: record.id });
    this.recentCompleted = this.recentCompleted.filter(item => item.startTime >= record.startTime - WINDOW_MS).slice(-500);
    const key = `${logBookId}:${record.myCallsign.toUpperCase()}:${record.callsign.toUpperCase()}:${record.mode}:${getBandFromFrequency(record.frequency)}`;
    const matches = [...(this.pendingByPair.get(key) ?? [])]
      .map(id => this.byId.get(id)!)
      .filter(item => Math.abs(item.startTime - record.startTime) <= WINDOW_MS);
    for (const item of matches) {
      await this.update(item.id, logBookId, item.revision, {
        status: 'recorded', linkedQsoId: record.id, syncQueued: true,
      });
    }
  }

  private addToAttempt(attempt: Attempt, observation: Observation): void {
    if (!attempt.messages.some(message => message.slotStartMs === observation.slotStartMs
      && message.direction === observation.direction && message.text === observation.text)) {
      attempt.messages.push(observation);
      attempt.messages.sort((a, b) => a.slotStartMs - b.slotStartMs);
    }
  }

  private async persistEligible(attempt: Attempt): Promise<void> {
    const sent = [...attempt.messages].reverse().find(message => message.direction === 'tx' && message.report !== undefined);
    const received = [...attempt.messages].reverse().find(message => message.direction === 'rx' && message.report !== undefined);
    if (!sent || !received || attempt.frequency < 1_000_000) return;
    const messages: IncompleteQsoMessage[] = attempt.messages.map(({ slotStartMs, direction, text, audioOffsetHz, snr, confidence }) =>
      ({ slotStartMs, direction, text, audioOffsetHz, snr, confidence }));
    const current = attempt.candidateId ? await this.get(attempt.candidateId) : null;
    if (current?.status !== undefined && current.status !== 'pending') return;
    const startTime = attempt.messages[0]!.slotStartMs;
    const endTime = attempt.messages.at(-1)!.slotStartMs;
    const next: IncompleteQsoCandidate = current ? {
      ...current, revision: current.revision + 1, endTime, reportSent: sent.report!,
      reportReceived: received.report!, messages,
    } : {
      schemaVersion: 1, id: randomUUID(), revision: 1, logBookId: attempt.logBookId,
      operatorId: attempt.operatorId, myCallsign: attempt.myCallsign, callsign: attempt.callsign,
      mode: attempt.mode, frequency: attempt.frequency, startTime, endTime,
      reportSent: sent.report!, reportReceived: received.report!, messages, status: 'pending',
    };
    const completed = this.recentCompleted.find(item => item.logBookId === attempt.logBookId
      && item.myCallsign === attempt.myCallsign && item.callsign === attempt.callsign
      && item.mode === attempt.mode
      && getBandFromFrequency(item.frequency) === getBandFromFrequency(attempt.frequency)
      && Math.abs(item.startTime - startTime) <= WINDOW_MS);
    if (completed) {
      next.status = 'recorded';
      next.linkedQsoId = completed.qsoId;
      next.syncQueued = true;
    }
    attempt.candidateId = next.id;
    await this.save(next);
  }

  async ingestRx(slot: ReviewRxSlot): Promise<void> {
    if (slot.frequency < 1_000_000) return;
    for (const frame of slot.frames) {
      if (frame.snr === -999) continue;
      const observation = parseObservation({ slotStartMs: slot.startMs, direction: 'rx', text: frame.message,
        mode: slot.mode, frequency: slot.frequency + frame.freq, audioOffsetHz: frame.freq,
        snr: frame.snr, confidence: frame.confidence });
      if (!observation) continue;
      this.recentRx.push(observation);
      for (const attempt of this.attempts.values()) {
        if (attempt.mode !== slot.mode || attempt.myCallsign !== observation.target
          || attempt.callsign !== observation.sender
          || getBandFromFrequency(attempt.frequency) !== getBandFromFrequency(observation.frequency)
          || Math.abs(slot.startMs - attempt.messages.at(-1)!.slotStartMs) > WINDOW_MS) continue;
        this.addToAttempt(attempt, observation);
        await this.persistEligible(attempt);
      }
    }
    this.recentRx = this.recentRx.filter(item => item.slotStartMs >= slot.startMs - WINDOW_MS).slice(-MAX_RECENT_RX);
    for (const [key, attempt] of this.attempts) {
      if (attempt.messages.at(-1)!.slotStartMs < slot.startMs - WINDOW_MS) this.attempts.delete(key);
    }
  }

  async ingestTx(fact: ReviewTxFact): Promise<void> {
    if (fact.frequency < 1_000_000) return;
    const observation = parseObservation({ slotStartMs: fact.startMs, direction: 'tx', text: fact.text,
      mode: fact.mode, frequency: fact.frequency + fact.audioOffsetHz, audioOffsetHz: fact.audioOffsetHz });
    if (!observation || observation.sender !== fact.myCallsign.toUpperCase()) return;
    const key = `${fact.operatorId}:${observation.target}:${fact.mode}:${getBandFromFrequency(fact.frequency)}`;
    let attempt = this.attempts.get(key);
    if (attempt && fact.startMs - attempt.messages.at(-1)!.slotStartMs > WINDOW_MS) attempt = undefined;
    if (!attempt) {
      attempt = { operatorId: fact.operatorId, logBookId: fact.logBookId,
        myCallsign: observation.sender, callsign: observation.target, mode: fact.mode,
        frequency: observation.frequency, messages: [] };
      for (const prior of this.recentRx) {
        if (prior.mode === fact.mode && prior.sender === observation.target
          && (prior.target === observation.sender || prior.target === 'CQ')
          && Math.abs(fact.startMs - prior.slotStartMs) <= WINDOW_MS
          && getBandFromFrequency(prior.frequency) === getBandFromFrequency(attempt.frequency)) {
          this.addToAttempt(attempt, prior);
        }
      }
      this.attempts.set(key, attempt);
      for (const [oldKey, oldAttempt] of this.attempts) {
        if (this.attempts.size <= MAX_ATTEMPTS) break;
        if (oldAttempt.messages.at(-1)!.slotStartMs < fact.startMs - WINDOW_MS || oldKey !== key) {
          this.attempts.delete(oldKey);
        }
      }
    }
    this.addToAttempt(attempt, observation);
    await this.persistEligible(attempt);
  }
}
