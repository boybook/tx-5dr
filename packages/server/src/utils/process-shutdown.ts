let processShuttingDown = false;
let newMutationsBlocked = false;

export function markProcessShuttingDown(): void {
  processShuttingDown = true;
  newMutationsBlocked = true;
}

export function isProcessShuttingDown(): boolean {
  return processShuttingDown;
}

export function blockNewMutations(): void {
  newMutationsBlocked = true;
}

export function areNewMutationsBlocked(): boolean {
  return newMutationsBlocked;
}

export function allowNewMutationsForTests(): void {
  processShuttingDown = false;
  newMutationsBlocked = false;
}
