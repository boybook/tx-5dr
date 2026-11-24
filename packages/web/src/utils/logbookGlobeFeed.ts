import type { OperatorStatus } from '@tx5dr/contracts';
import type { LiveDecodeView } from './liveDecodes';
import type { ReceptionView } from './receptionGlobe';

/**
 * Live data the logbook globe shows, pushed by the logbook socket: operator
 * status (several times a second while transmitting), reception reports and
 * decoded stations (every slot).
 *
 * Only the globe reads it, so it lives outside the logbook page's React state:
 * an update re-renders the globe alone, never the page and its QSO table.
 */
export interface LogbookGlobeFeedState {
  operators: OperatorStatus[];
  reception: ReceptionView | null;
  liveDecodes: LiveDecodeView | null;
  /** The server accepts target selection from this page. */
  targetingSupported: boolean;
}

export interface LogbookGlobeFeed {
  getState(): LogbookGlobeFeedState;
  /** Applies a change; returning the same values notifies no one. */
  update(change: (state: LogbookGlobeFeedState) => Partial<LogbookGlobeFeedState>): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

const INITIAL_STATE: LogbookGlobeFeedState = {
  operators: [],
  reception: null,
  liveDecodes: null,
  targetingSupported: false,
};

export function createLogbookGlobeFeed(): LogbookGlobeFeed {
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());

  return {
    getState: () => state,
    update(change) {
      const patch = change(state);
      const changed = (Object.keys(patch) as Array<keyof LogbookGlobeFeedState>)
        .some(key => patch[key] !== state[key]);
      if (!changed) return;
      state = { ...state, ...patch };
      notify();
    },
    reset() {
      if (state === INITIAL_STATE) return;
      state = INITIAL_STATE;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** An operator's status merged into the list; the same list when nothing changed. */
export function mergeOperatorStatus(operators: OperatorStatus[], status: OperatorStatus): OperatorStatus[] {
  const index = operators.findIndex(item => item.id === status.id);
  if (index < 0) return [...operators, status];
  const current = operators[index];
  if (current === status || JSON.stringify(current) === JSON.stringify(status)) return operators;
  const next = [...operators];
  next[index] = status;
  return next;
}
