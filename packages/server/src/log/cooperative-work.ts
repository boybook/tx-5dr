/** Use the same private construction algorithm for synchronous callers and sliced commits. */
export function finishWork<T>(work: Generator<void, T>): T {
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

export async function finishWorkInSlices<T>(work: Generator<void, T>): Promise<T> {
  let started = performance.now();
  let count = 0;
  let step = work.next();
  while (!step.done) {
    if (++count % 64 === 0 && performance.now() - started >= 5) {
      await new Promise<void>(resolve => setImmediate(resolve));
      started = performance.now();
    }
    step = work.next();
  }
  return step.value;
}
