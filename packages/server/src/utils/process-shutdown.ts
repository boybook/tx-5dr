let processShuttingDown = false;

export function markProcessShuttingDown(): void {
  processShuttingDown = true;
}

export function isProcessShuttingDown(): boolean {
  return processShuttingDown;
}
