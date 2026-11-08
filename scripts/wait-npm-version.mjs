import { pathToFileURL } from 'node:url';

/** Do not publish a dependent package before its exact dependency is downloadable. */
export async function waitForNpmVersion(name, version, {
  fetchImpl = fetch, now = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 600000, intervalMs = 10000,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastStatus = 'not observed';
  while (now() < deadline) {
    try {
      const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
        cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now()))),
      });
      if (response.status === 401 || response.status === 403) throw new Error(`Registry access denied: ${response.status}`);
      lastStatus = `registry HTTP ${response.status}`;
      if (response.ok) {
        const metadata = await response.json();
        if (metadata.name === name && metadata.version === version && typeof metadata.dist?.tarball === 'string') {
          const archive = await fetchImpl(metadata.dist.tarball, {
            method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now()))),
          });
          lastStatus = `tarball HTTP ${archive.status}`;
          if (archive.ok) return metadata;
        } else lastStatus = 'registry identity mismatch';
      }
    } catch (error) {
      if (error.message.startsWith('Registry access denied:')) throw error;
      lastStatus = error.message;
    }
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(intervalMs, remaining));
  }
  throw new Error(`Timed out waiting for ${name}@${version}: ${lastStatus}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name, version] = process.argv.slice(2);
  if (!name || !version) throw new Error('Usage: node scripts/wait-npm-version.mjs PACKAGE VERSION');
  await waitForNpmVersion(name, version);
  process.stdout.write(`${name}@${version} is available from the registry and tarball endpoint\n`);
}
