import { copyFile } from 'node:fs/promises';

// The Host serves this stylesheet at runtime, so it must ship inside dist:
// platform packaging copies dist only.
await copyFile(new URL('../ui.css', import.meta.url), new URL('../dist/ui.css', import.meta.url));
