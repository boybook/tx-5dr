import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Decides what to do with one SDK package. A version that is already on the
 * registry is skipped only when it holds the bytes this run would publish, so a
 * rerun after a partial publication resumes instead of failing, and never
 * hides a different build under a released version.
 */
export function decideNpmPublication({ name, version, publishedIntegrity, localIntegrity }) {
  if (!publishedIntegrity) return 'publish';
  if (publishedIntegrity === localIntegrity) return 'skip';
  throw new Error(
    `${name}@${version} is already published with different contents `
    + `(registry ${publishedIntegrity}, local ${localIntegrity}); bump the SDK version`,
  );
}

export async function fetchPublishedIntegrity(name, version, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { cache: 'no-store', signal: AbortSignal.timeout(15000) },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Cannot read ${name}@${version} from the registry: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.version !== version || typeof metadata.dist?.integrity !== 'string') {
    throw new Error(`Registry returned unexpected metadata for ${name}@${version}`);
  }
  return metadata.dist.integrity;
}

function localIntegrity(packageDir) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: packageDir, encoding: 'utf8' });
  return JSON.parse(output)[0].integrity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [packageDir, version] = process.argv.slice(2);
  if (!packageDir || !version) throw new Error('Usage: node scripts/publish-npm-once.mjs PACKAGE_DIR VERSION');
  const { name, version: sourceVersion } = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (sourceVersion !== version) throw new Error(`${name} source version is ${sourceVersion}; expected ${version}`);

  const publishedIntegrity = await fetchPublishedIntegrity(name, version);
  const decision = decideNpmPublication({
    name, version, publishedIntegrity,
    localIntegrity: publishedIntegrity ? localIntegrity(packageDir) : undefined,
  });
  if (decision === 'skip') {
    process.stdout.write(`${name}@${version} is already published with identical contents; skipping\n`);
  } else {
    execFileSync('npm', ['publish', '--access', 'public'], { cwd: packageDir, stdio: 'inherit' });
  }
}
