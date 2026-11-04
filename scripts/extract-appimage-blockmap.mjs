import { open, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** Copy the updater's existing embedded metadata without changing signed bytes. */
export async function extractAppImageBlockmap(file) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 4) throw new Error('AppImage has no embedded blockmap trailer');
    const trailer = Buffer.alloc(4);
    await handle.read(trailer, 0, 4, size - 4);
    const length = trailer.readUInt32BE(0);
    if (length === 0 || length > size - 4 || length > 64 * 1024 * 1024) {
      throw new Error('Invalid AppImage embedded blockmap size');
    }
    const compressed = Buffer.alloc(length);
    const { bytesRead } = await handle.read(compressed, 0, length, size - 4 - length);
    if (bytesRead !== length) throw new Error('Truncated AppImage embedded blockmap');
    const map = JSON.parse(inflateRawSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8'));
    if (map.version !== '2' || !Array.isArray(map.files) || map.files.length === 0) {
      throw new Error('Invalid AppImage embedded blockmap');
    }
    await writeFile(`${file}.blockmap`, compressed);
    return length;
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/extract-appimage-blockmap.mjs FILE');
  const length = await extractAppImageBlockmap(process.argv[2]);
  process.stdout.write(`Extracted ${length} bytes of embedded AppImage blockmap\n`);
}
