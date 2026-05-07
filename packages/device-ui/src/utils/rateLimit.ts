export function createLatestFrameScheduler<T>(delayMs: number, deliver: (value: T) => void): (value: T) => void {
  let latest: T | undefined;
  let timer: NodeJS.Timeout | undefined;
  return (value: T) => {
    latest = value;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (latest !== undefined) deliver(latest);
      latest = undefined;
    }, delayMs);
  };
}
