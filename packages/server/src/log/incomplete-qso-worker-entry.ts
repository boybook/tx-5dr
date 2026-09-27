import { IncompleteQsoQuerySchema } from '@tx5dr/contracts';
import { IncompleteQsoWorkerStore, type ReviewRxSlot, type ReviewTxFact } from './IncompleteQsoWorkerStore.js';

type WorkerRequest = {
  id: number;
  operation: string;
  payload: Record<string, unknown>;
};

const root = process.env.TX5DR_REVIEW_DIR;
if (!root) throw new Error('TX5DR_REVIEW_DIR is required');
const store = new IncompleteQsoWorkerStore(root);
let tail = store.initialize().then(() => {
  process.send?.({ type: 'ready' });
}).catch(error => {
  process.send?.({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  throw error;
});

process.on('message', (request: WorkerRequest) => {
  if (!request || typeof request.id !== 'number') return;
  tail = tail.then(async () => {
    const { operation, payload } = request;
    let result: unknown;
    switch (operation) {
      case 'rx': result = await store.ingestRx(payload.slot as ReviewRxSlot); break;
      case 'tx': result = await store.ingestTx(payload.fact as ReviewTxFact); break;
      case 'get': result = await store.get(String(payload.id), payload.logBookId as string | undefined); break;
      case 'list': result = store.list(String(payload.logBookId), IncompleteQsoQuerySchema.parse(payload.query)); break;
      case 'update': result = await store.update(String(payload.id), String(payload.logBookId), Number(payload.revision), payload.patch as never); break;
      case 'link': result = await store.linkQso(String(payload.logBookId), payload.record as never); break;
      default: throw new Error(`Unknown review operation: ${operation}`);
    }
    process.send?.({ type: 'result', id: request.id, result });
  }).catch(error => {
    process.send?.({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) });
  });
});

process.on('disconnect', () => process.exit(0));
