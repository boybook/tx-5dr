import { ReleaseManifestSchema, type ReleaseManifest, type SystemUpdateChannel, type UpdateSelection } from '@tx5dr/contracts';

/** SemVer precedence, including prereleases; build metadata never affects ordering. */
export function compareUpdateVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error('invalid_update_version');
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
  };
  const a = parse(left); const b = parse(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]; const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function updateOperation(current: { channel: SystemUpdateChannel; version: string; commit?: string | null }, target: Pick<ReleaseManifest, 'channel' | 'version' | 'commit'>): NonNullable<UpdateSelection['operation']> {
  const order = compareUpdateVersions(target.version, current.version);
  if (current.channel !== target.channel) return order < 0 ? 'downgrade' : 'switch';
  if (order > 0) return 'upgrade';
  if (order < 0) return 'none';
  const sameCommit = current.commit && (target.commit.startsWith(current.commit) || current.commit.startsWith(target.commit));
  return target.channel === 'nightly' && current.commit && !sameCommit ? 'reinstall' : 'none';
}

export function releaseIdentity(manifest: Pick<ReleaseManifest, 'product' | 'channel' | 'version' | 'commit'>): string {
  return `${manifest.product}:${manifest.channel}:${manifest.version}:${manifest.commit}`;
}

export class EmptyReleaseChannelError extends Error {
  constructor() { super('update_channel_empty'); }
}

export async function fetchChannelManifest(product: ReleaseManifest['product'], channel: SystemUpdateChannel, baseUrl = 'https://dl.tx5dr.com', version?: string): Promise<{ manifest: ReleaseManifest; source: 'oss' | 'github' }> {
  if (version) compareUpdateVersions(version, version);
  const requests: Array<{ url: string; source: 'oss' | 'github'; directory?: boolean }> = [
    { url: `${baseUrl.replace(/\/+$/, '')}/tx-5dr/${product}/${version ? `builds/${encodeURIComponent(version)}` : channel}/latest.json`, source: 'oss' },
    version ? { url: `https://github.com/boybook/tx-5dr/releases/download/${encodeURIComponent(channel === 'release' ? `v${version}` : `build-${version}`)}/${product}-manifest.json`, source: 'github' } : channel === 'nightly'
      ? { url: `https://github.com/boybook/tx-5dr/releases/download/nightly-${product}/${product === 'app' || product === 'server' || product === 'android-runtime' ? 'latest.json' : 'docker-manifest.json'}`, source: 'github' }
      : { url: `https://github.com/boybook/tx-5dr/releases/latest/download/${product}-manifest.json`, source: 'github' },
  ];
  let missing = 0; let lastError: unknown;
  for (const request of requests) {
    try {
      const response = await fetch(request.url, { signal: AbortSignal.timeout(8000) });
      if (response.status === 404) { missing++; continue; }
      if (!response.ok) throw new Error(`request_failed:${response.status}`);
      const manifest = ReleaseManifestSchema.parse(await response.json());
      if (manifest.product !== product || manifest.channel !== channel || (version && manifest.version !== version)) throw new Error('update_manifest_target_mismatch');
      return { manifest, source: request.source };
    } catch (error) { lastError = error; }
  }
  if (missing === requests.length) throw new EmptyReleaseChannelError();
  throw lastError ?? new Error('update_manifest_unavailable');
}
