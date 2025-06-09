import React from 'react';

type StateCreator<T> = (
  set: (partial: Partial<T> | ((state: T) => Partial<T>)) => void,
  get: () => T
) => T;

export function create<T>(initializer: StateCreator<T>) {
  let state: T;
  const listeners = new Set<(state: T) => void>();

  const setState = (partial: Partial<T> | ((state: T) => Partial<T>)) => {
    const next = typeof partial === 'function' ? (partial as (state: T) => Partial<T>)(state) : partial;
    state = { ...state, ...next } as T;
    listeners.forEach(l => l(state));
  };

  const getState = () => state;

  state = initializer(setState, getState);

  function useStore<U = T>(selector: (state: T) => U = (s => s as unknown as U)) {
    const [selected, setSelected] = React.useState(() => selector(state));
    React.useEffect(() => {
      const listener = (s: T) => {
        const newSelected = selector(s);
        setSelected(prev => (Object.is(prev, newSelected) ? prev : newSelected));
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, [selector]);
    return selected;
  }

  useStore.getState = getState;
  useStore.setState = setState;
  useStore.subscribe = (listener: (state: T) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return useStore;
}
