/**
 * Native module diagnostic script — runs as an isolated child process.
 *
 * Sequentially attempts to import each native module used by the server.
 * The parent process (electron-main) reads stdout line-by-line to determine
 * which modules loaded and which failed or crashed the process.
 *
 * Protocol (one line per event, flushed immediately):
 *   CHECKING:<module>   — about to load <module>
 *   OK:<module>         — import succeeded
 *   FAIL:<module>:<msg> — import threw a JS error (process still alive)
 *   DONE               — all checks finished
 *
 * If the process dies between CHECKING:X and the corresponding OK/FAIL,
 * module X caused a fatal crash (e.g. native binding segfault).
 */

const NATIVE_MODULES = [
  'audify',
  'serialport',
  'bcrypt',
  'node-datachannel',
  'rubato-fft-node',
  'hamlib',
  'icom-wlan-node',
  'node-wav',
  'wsjtx-lib',
];

function writeLine(line: string): void {
  process.stdout.write(line + '\n');
}

async function main(): Promise<void> {
  for (const mod of NATIVE_MODULES) {
    writeLine(`CHECKING:${mod}`);
    try {
      await import(mod);
      writeLine(`OK:${mod}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Keep message on a single line so the parent parser stays simple
      writeLine(`FAIL:${mod}:${msg.replace(/\n/g, ' ')}`);
    }
  }
  writeLine('DONE');
}

main().catch((err) => {
  writeLine(`ERROR:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
