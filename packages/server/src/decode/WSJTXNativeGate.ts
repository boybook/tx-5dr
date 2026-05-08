/**
 * Serializes calls into wsjtx-lib's native bindings.
 *
 * The native WSJT-X/Fortran code keeps process-wide static state in several
 * routines, so encode and decode must not overlap on libuv worker threads.
 */
export class WSJTXNativeGate {
  private static tail: Promise<void> = Promise.resolve();

  static async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = WSJTXNativeGate.tail;
    let release!: () => void;
    WSJTXNativeGate.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
