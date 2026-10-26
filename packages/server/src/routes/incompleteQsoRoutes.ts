import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  IncompleteQsoQuerySchema, IncompleteQsoSelectionSchema,
  type IncompleteQsoCandidate, type IncompleteQsoJob, type IncompleteQsoPreviewItem,
  type IncompleteQsoSelection, type QSORecord,
} from '@tx5dr/contracts';
import { FT8MessageParser, getBandFromFrequency } from '@tx5dr/core';
import { ADIFLogProvider } from '../log/ADIFLogProvider.js';
import type { LogManager } from '../log/LogManager.js';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { requireExistingLogbookAccess } from '../auth/authPlugin.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('IncompleteQsoRoutes');
const MAX_CHUNK = 25;
const DUPLICATE_WINDOW_MS = 5 * 60_000;

function deterministicQsoId(candidateId: string): string {
  return `tx5dr-review-${candidateId}`;
}

function toQso(candidate: IncompleteQsoCandidate): QSORecord {
  const grid = candidate.messages.filter(message => message.direction === 'rx')
    .map(message => FT8MessageParser.parseMessage(message.text))
    .find(message => 'grid' in message && typeof message.grid === 'string');
  return {
    id: deterministicQsoId(candidate.id), callsign: candidate.callsign,
    myCallsign: candidate.myCallsign, mode: candidate.mode, frequency: candidate.frequency,
    ...((grid && 'grid' in grid && grid.grid) ? { grid: grid.grid } : {}),
    startTime: candidate.startTime, endTime: candidate.endTime,
    reportSent: candidate.reportSent, reportReceived: candidate.reportReceived,
    messageHistory: candidate.messages.map(message => message.text),
  };
}

function duplicate(provider: ADIFLogProvider, candidate: IncompleteQsoCandidate): QSORecord | undefined {
  const band = getBandFromFrequency(candidate.frequency);
  return provider.findByCallsign(candidate.callsign).find(record =>
    record.mode === candidate.mode && getBandFromFrequency(record.frequency) === band
    && (!record.myCallsign || record.myCallsign.toUpperCase() === candidate.myCallsign)
    && Math.abs(record.startTime - candidate.startTime) <= DUPLICATE_WINDOW_MS);
}

function valid(candidate: IncompleteQsoCandidate): boolean {
  return candidate.frequency > 1_000_000 && candidate.reportSent.length > 0
    && candidate.reportReceived.length > 0 && candidate.messages.some(message => message.direction === 'tx')
    && candidate.messages.some(message => message.direction === 'rx');
}

export function registerIncompleteQsoRoutes(
  fastify: FastifyInstance,
  engine: DigitalRadioEngine,
  logManager: LogManager,
): void {
  const access = requireExistingLogbookAccess(logManager);
  const scopedAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    await access(request, reply);
    if (request.logBookInstance) {
      (request.params as { id: string }).id = request.logBookInstance.id;
    }
  };
  const jobs = new Map<string, { logBookId: string; job: IncompleteQsoJob }>();
  const activeBooks = new Set<string>();
  const recoveredBooks = new Set<string>();
  const recoveringBooks = new Set<string>();
  let startupRecoveryTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleStartupRecovery = () => {
    startupRecoveryTimer = setTimeout(() => {
      const review = engine.getIncompleteQsoService();
      if (!review || review.getHealth().state === 'loading') {
        scheduleStartupRecovery();
        return;
      }
      if (review.getHealth().state !== 'ready') return;
      for (const book of logManager.getLogBooks()) {
        void recover(book.id).catch(error => logger.warn('Startup review reconciliation failed', {
          logBookId: book.id, error,
        }));
      }
    }, 2_000);
    startupRecoveryTimer.unref?.();
  };
  fastify.addHook('onReady', async () => { scheduleStartupRecovery(); });
  fastify.addHook('onClose', async () => { if (startupRecoveryTimer) clearTimeout(startupRecoveryTimer); });

  function resolve(id: string) {
    const book = logManager.getLogBook(id);
    const review = engine.getIncompleteQsoService();
    if (!book || !(book.provider instanceof ADIFLogProvider) || !review) {
      throw new Error('REVIEW_UNAVAILABLE');
    }
    return { book, provider: book.provider, review };
  }

  async function inspect(logBookId: string, item: IncompleteQsoSelection['items'][number]): Promise<IncompleteQsoPreviewItem> {
    const { provider, review } = resolve(logBookId);
    const candidate = await review.get(item.id, logBookId);
    if (!candidate || candidate.revision !== item.revision) {
      return { id: item.id, revision: item.revision, disposition: 'changed', candidate };
    }
    if (candidate.status !== 'pending') {
      return { id: item.id, revision: item.revision, disposition: 'recorded',
        qsoId: candidate.linkedQsoId, candidate };
    }
    const id = deterministicQsoId(candidate.id);
    const existingById = await provider.getQSO(id);
    const existing = existingById ?? duplicate(provider, candidate);
    return { id: item.id, revision: item.revision, candidate,
      disposition: existing ? 'duplicate' : valid(candidate) ? 'ready' : 'invalid',
      qsoId: existing?.id };
  }

  async function recover(logBookId: string): Promise<void> {
    if (recoveredBooks.has(logBookId) || recoveringBooks.has(logBookId)) return;
    recoveringBooks.add(logBookId);
    try {
    const { provider, review } = resolve(logBookId);
    let cursor: string | undefined;
    do {
      const page = await review.list(logBookId, { status: 'pending', limit: 50, cursor });
      for (const item of page.items) {
        if (!item.commitRequested) continue;
        const record = await provider.getQSO(deterministicQsoId(item.id));
        if (!record) continue;
        try {
          await review.update(item.id, logBookId, item.revision, {
            status: 'recorded', linkedQsoId: record.id, commitRequested: false,
          });
          const queued = await engine.pluginManager.logbookSyncHost.onQSOsComplete(record.myCallsign ?? item.myCallsign, [record]);
          if (queued) {
            const current = await review.get(item.id, logBookId);
            if (current) await review.update(item.id, logBookId, current.revision, { syncQueued: true });
          }
        } catch (error) {
          logger.warn('Review candidate recovery failed', { id: item.id, error });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    cursor = undefined;
    do {
      const page = await review.list(logBookId, { status: 'recorded', limit: 50, cursor });
      for (const item of page.items) {
        if (item.syncQueued || !item.linkedQsoId) continue;
        const record = await provider.getQSO(item.linkedQsoId);
        if (!record) continue;
        try {
          if (await engine.pluginManager.logbookSyncHost.onQSOsComplete(item.myCallsign, [record])) {
            await review.update(item.id, logBookId, item.revision, { syncQueued: true });
          }
        } catch (error) {
          logger.warn('Review upload recovery failed', { id: item.id, error });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    recoveredBooks.add(logBookId);
    } finally {
      recoveringBooks.delete(logBookId);
    }
  }

  fastify.get<{ Params: { id: string } }>('/:id/review-candidates/health', { preHandler: [scopedAccess] }, async request => {
    const { review } = resolve(request.params.id);
    return { success: true, data: review.getHealth() };
  });

  fastify.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/:id/review-candidates', { preHandler: [scopedAccess] }, async request => {
      void recover(request.params.id).catch(error => {
        logger.warn('Review candidate reconciliation failed', { logBookId: request.params.id, error });
      });
      const { review } = resolve(request.params.id);
      return { success: true, data: await review.list(request.params.id, IncompleteQsoQuerySchema.parse(request.query)) };
    },
  );

  fastify.get<{ Params: { id: string; candidateId: string } }>(
    '/:id/review-candidates/:candidateId', { preHandler: [scopedAccess] }, async request => {
      const { review } = resolve(request.params.id);
      return { success: true, data: await review.get(request.params.candidateId, request.params.id) };
    },
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/:id/review-candidates/preview', { preHandler: [scopedAccess] }, async request => {
      const selection = IncompleteQsoSelectionSchema.parse(request.body);
      const { provider } = resolve(request.params.id);
      if (!provider.getHealth().readable) throw new Error('LOGBOOK_UNAVAILABLE');
      const items = await Promise.all(selection.items.map(item => inspect(request.params.id, item)));
      return { success: true, data: { items } };
    },
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/:id/review-candidates/commit', { preHandler: [scopedAccess] }, async (request, reply) => {
      const selection = IncompleteQsoSelectionSchema.parse(request.body);
      const logBookId = request.params.id;
      const { provider } = resolve(logBookId);
      if (!provider.getHealth().writable || activeBooks.has(logBookId)) {
        return reply.status(409).send({ success: false, message: 'Review batch or logbook is busy' });
      }
      const job: IncompleteQsoJob = {
        id: randomUUID(), state: 'running',
        items: selection.items.map(item => ({ id: item.id, disposition: 'pending' })),
      };
      jobs.set(job.id, { logBookId, job });
      if (jobs.size > 100) jobs.delete(jobs.keys().next().value!);
      activeBooks.add(logBookId);
      void runJob(logBookId, selection, job).catch(error => {
        logger.error('Review batch job failed', { logBookId, error });
        for (const item of job.items) {
          if (item.disposition === 'pending') {
            item.disposition = 'not_attempted';
            item.error = error instanceof Error ? error.message : String(error);
          }
        }
      }).finally(() => {
        job.state = 'finished';
        activeBooks.delete(logBookId);
        recoveredBooks.delete(logBookId);
      });
      return reply.status(202).send({ success: true, data: { jobId: job.id } });
    },
  );

  async function runJob(logBookId: string, selection: IncompleteQsoSelection, job: IncompleteQsoJob): Promise<void> {
    const { provider, review } = resolve(logBookId);
    for (let offset = 0; offset < selection.items.length; offset += MAX_CHUNK) {
      const selected = selection.items.slice(offset, offset + MAX_CHUNK);
      const additions: Array<{ candidate: IncompleteQsoCandidate; record: QSORecord }> = [];
      for (const item of selected) {
        const outcome = job.items.find(result => result.id === item.id)!;
        try {
          const preview = await inspect(logBookId, item);
          if (preview.disposition !== 'ready' || !preview.candidate) {
            outcome.disposition = preview.disposition === 'recorded' ? 'duplicate'
              : preview.disposition === 'ready' ? 'failed' : preview.disposition;
            outcome.qsoId = preview.qsoId;
            continue;
          }
          const withinChunk = additions.find(entry => entry.candidate.callsign === preview.candidate!.callsign
            && entry.candidate.mode === preview.candidate!.mode
            && getBandFromFrequency(entry.candidate.frequency) === getBandFromFrequency(preview.candidate!.frequency)
            && Math.abs(entry.candidate.startTime - preview.candidate!.startTime) <= DUPLICATE_WINDOW_MS);
          if (withinChunk) {
            outcome.disposition = 'duplicate';
            outcome.qsoId = withinChunk.record.id;
            continue;
          }
          const intent = await review.update(item.id, logBookId, item.revision, { commitRequested: true });
          additions.push({ candidate: intent, record: toQso(intent) });
        } catch (error) {
          outcome.disposition = 'failed';
          outcome.error = error instanceof Error ? error.message : String(error);
        }
      }
      if (additions.length === 0) continue;
      let committed: Awaited<ReturnType<ADIFLogProvider['applyQsoBatch']>>;
      try {
        committed = await provider.applyQsoBatch(additions.map(({ record }) => ({ type: 'add', record })),
          { expectedRevision: await provider.getRevision() });
      } catch (error) {
        logger.warn('Review batch append failed', { logBookId, error });
        for (const entry of additions) {
          const outcome = job.items.find(item => item.id === entry.candidate.id)!;
          outcome.disposition = 'failed';
          outcome.error = error instanceof Error ? error.message : String(error);
        }
        if (!provider.getHealth().writable) {
          for (const pending of job.items) {
            if (pending.disposition === 'pending') pending.disposition = 'not_attempted';
          }
          break;
        }
        continue;
      }
      {
        const committedRecords: QSORecord[] = [];
        for (const [index, entry] of additions.entries()) {
          const result = committed.outcomes[index]!;
          const outcome = job.items.find(item => item.id === entry.candidate.id)!;
          outcome.disposition = 'recorded';
          outcome.qsoId = result.record.id;
          committedRecords.push(result.record);
          try {
            await review.update(entry.candidate.id, logBookId, entry.candidate.revision, {
              status: 'recorded', linkedQsoId: result.record.id, commitRequested: false,
            });
          } catch (error) {
            outcome.error = 'QSO saved; candidate status will be reconciled on restart';
            logger.warn('Candidate status write failed after QSO commit', { id: entry.candidate.id, error });
          }
          try {
            engine.emit('qsoRecordAdded', { operatorId: entry.candidate.operatorId,
              logBookId, qsoRecord: result.record });
          } catch (error) {
            logger.warn('Review QSO notification failed after commit', { qsoId: result.record.id, error });
          }
        }
        const byCallsign = new Map<string, typeof additions>();
        for (const entry of additions) {
          const group = byCallsign.get(entry.candidate.myCallsign) ?? [];
          group.push(entry);
          byCallsign.set(entry.candidate.myCallsign, group);
        }
        for (const [callsign, group] of byCallsign) {
          let syncQueued = false;
          try {
            syncQueued = await engine.pluginManager.logbookSyncHost.onQSOsComplete(callsign,
              group.map(entry => committedRecords[additions.indexOf(entry)]!));
          } catch (error) {
            logger.warn('Review upload enqueue failed after QSO commit', { logBookId, callsign, error });
          }
          for (const entry of group) {
            if (!syncQueued) {
              job.items.find(item => item.id === entry.candidate.id)!.error = 'QSO saved; upload queue needs retry';
              continue;
            }
            try {
              const current = await review.get(entry.candidate.id, logBookId);
              if (current?.status === 'recorded') {
                await review.update(current.id, logBookId, current.revision, { syncQueued: true });
              }
            } catch (error) {
              logger.warn('Candidate sync status update failed', { id: entry.candidate.id, error });
            }
          }
        }
        try {
          engine.emit('logbookUpdated', { logBookId, operatorId: additions[0]!.candidate.operatorId,
            statistics: {
              ...await provider.getStatistics(),
              totalOperators: logManager.getOperatorIdsForLogBook(logBookId).length,
            } });
        } catch (error) {
          logger.warn('Review logbook statistics notification failed', { logBookId, error });
        }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  fastify.get<{ Params: { id: string; jobId: string } }>(
    '/:id/review-candidates/jobs/:jobId', { preHandler: [scopedAccess] }, async request => {
      resolve(request.params.id);
      const found = jobs.get(request.params.jobId);
      return { success: true, data: found?.logBookId === request.params.id ? found.job : null };
    },
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/:id/review-candidates/dismiss', { preHandler: [scopedAccess] }, async request => {
      const selection = IncompleteQsoSelectionSchema.parse(request.body);
      const { review } = resolve(request.params.id);
      const items = await Promise.all(selection.items.map(async item => {
        try {
          const current = await review.get(item.id, request.params.id);
          if (!current || current.status !== 'pending') return { id: item.id, status: 'changed' };
          const candidate = await review.update(item.id, request.params.id, item.revision, { status: 'dismissed' });
          return { id: item.id, status: candidate.status };
        } catch { return { id: item.id, status: 'changed' }; }
      }));
      return { success: true, data: { items } };
    },
  );

  fastify.post<{ Params: { id: string; candidateId: string } }>(
    '/:id/review-candidates/:candidateId/retry-sync', { preHandler: [scopedAccess] }, async request => {
      const { provider, review } = resolve(request.params.id);
      const candidate = await review.get(request.params.candidateId, request.params.id);
      if (!candidate?.linkedQsoId || candidate.status !== 'recorded') throw new Error('REVIEW_CANDIDATE_NOT_RECORDED');
      const record = await provider.getQSO(candidate.linkedQsoId);
      if (!record) throw new Error('REVIEW_QSO_NOT_FOUND');
      const queued = await engine.pluginManager.logbookSyncHost.onQSOsComplete(candidate.myCallsign, [record]);
      if (queued) await review.update(candidate.id, request.params.id, candidate.revision, { syncQueued: true });
      return { success: queued, data: { queued } };
    },
  );
}
