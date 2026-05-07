#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const nativeDir = join(process.cwd(), 'native');
if (!existsSync(nativeDir)) {
  console.log('[device-ui] native renderers are not present in this checkout; skipping build:native');
  process.exit(0);
}
console.log('[device-ui] native renderer build hook is ready; CMake build is implemented with native sources.');
