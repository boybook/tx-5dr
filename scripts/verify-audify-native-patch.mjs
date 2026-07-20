import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

if (process.platform !== 'linux' && process.platform !== 'win32') {
  console.log(`Audify native patch verification is not required on ${process.platform}`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const binaryPath = require.resolve('audify/build/Release/audify.node');
const binary = readFileSync(binaryPath);
const markers = ['inputNativeId', 'outputNativeId'];

for (const marker of markers) {
  if (!binary.includes(Buffer.from(marker))) {
    throw new Error(`Audify native binding is missing the TX-5DR patch marker: ${marker}`);
  }
}

require('audify');
console.log(`Audify native patch verified: ${binaryPath}`);
