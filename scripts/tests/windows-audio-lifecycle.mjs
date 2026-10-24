import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createRequire } from 'node:module';

assert.equal(process.platform, 'win32', 'This regression requires the Windows native runtime');
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
const { RtAudio, RtAudioApi } = createRequire(import.meta.url)('audify');
let finalized = 0;
const registry = new FinalizationRegistry(() => { finalized++; });
function discover() {
  const audio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  registry.register(audio, true);
  assert.ok(Array.isArray(audio.getDevices()));
}
for (let i = 0; i < 20; i++) {
  discover();
  global.gc();
  await setImmediate();
  global.gc();
  await setImmediate();
}
assert.equal(finalized, 20, 'All temporary device enumerators must be finalized');
process.stdout.write('Windows WASAPI enumeration and garbage collection passed (20 instances).\n');
