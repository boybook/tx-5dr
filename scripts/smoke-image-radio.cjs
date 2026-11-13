// Exercises the Image Radio (SSTV/Radiofax) native runtime of a built product.
// Modules resolve from the working directory, so the caller selects the product:
// smoke-packaged-server.mjs evaluates this source inside the packaged server
// directory, and the Docker build runs it against the production node_modules.
const { PNG } = require('pngjs');
if (typeof PNG.sync.read !== 'function') throw new Error('pngjs unavailable');
const rasterwave = require('rasterwave-node');
if (rasterwave.sstvModes().length !== 31) throw new Error('rasterwave mode catalog incomplete');
if (typeof rasterwave.correctFaxPaper !== 'function') throw new Error('radiofax correction unavailable');
for (const name of ['SstvDecoder', 'FaxDecoder', 'SstvEncoder']) {
  if (typeof rasterwave[name] !== 'function') throw new Error(`missing ${name}`);
}
const mode = rasterwave.sstvModes().find((item) => item.mode === 'robot8Bw');
const pixels = new Uint8Array(mode.width * mode.height * 3);
const encoders = [
  { enhancedPreamble: true, stationId: { kind: 'fsk', callsign: 'N0CALL' }, postImageGapMs: 500, endGuardMs: 300 },
  { stationId: { kind: 'cw', callsign: 'N0CALL', wpm: 20, toneHz: 800 }, postImageGapMs: 500, endGuardMs: 300 },
  { stationId: { kind: 'none' }, endGuardMs: 300 },
].map((options) => new rasterwave.SstvEncoder(pixels, mode.mode, 12000, options));
if (encoders.some((encoder) => encoder.progress.rasterEndSample <= 0)) throw new Error('SSTV envelope progress unavailable');
Promise.all([
  ...encoders.map((encoder) => encoder.dispose()),
  new rasterwave.SstvDecoder(12000, { outputMode: 'continuousPaper', fallbackMode: 'robot36', queueCapacitySamples: 24000 }, () => {}).dispose(),
  new rasterwave.FaxDecoder(12000, { outputMode: 'continuousPaper', continuousAuto: true, queueCapacitySamples: 24000 }, () => {}).dispose(),
  rasterwave.correctFaxPaper(new Uint8Array(8), 4, 2, 0, []),
]).then(() => console.log('Packaged Image Radio runtime ok')).catch((error) => { console.error(error); process.exit(1); });
