import { lookup } from 'dns/promises';
import { isIP } from 'net';

const DNS_LOOKUP_TIMEOUT_MS = 1000;

export interface RtcDataAudioPublicCandidateEndpoint {
  ip: string;
  port: number;
}

export interface RtcDataAudioCandidateRewriteOptions {
  localUdpPort?: number;
  mid?: string | null;
  seen?: Set<string>;
}

function splitCandidatePrefix(candidate: string): { prefix: string; body: string } {
  if (candidate.startsWith('a=candidate:')) {
    return { prefix: 'a=', body: candidate.slice(2) };
  }
  return { prefix: '', body: candidate };
}

function buildDedupeKey(endpoint: RtcDataAudioPublicCandidateEndpoint, mid?: string | null): string {
  return `${endpoint.ip}:${endpoint.port}:${mid ?? '0'}`;
}

function shouldRewriteCandidate(fields: string[], localUdpPort?: number): boolean {
  if (fields.length < 8 || !fields[0]?.startsWith('candidate:')) {
    return false;
  }
  const protocol = fields[2]?.toLowerCase();
  const port = Number.parseInt(fields[5] ?? '', 10);
  const typeMarker = fields[6]?.toLowerCase();
  const candidateType = fields[7]?.toLowerCase();
  if (protocol !== 'udp' || typeMarker !== 'typ' || candidateType !== 'host' || !Number.isFinite(port)) {
    return false;
  }
  return !localUdpPort || port === localUdpPort;
}

export function createPublicIceCandidateVariants(
  candidate: string,
  endpoints: RtcDataAudioPublicCandidateEndpoint[],
  options: RtcDataAudioCandidateRewriteOptions = {},
): string[] {
  if (endpoints.length === 0) {
    return [];
  }

  const { prefix, body } = splitCandidatePrefix(candidate.trim());
  const fields = body.split(/\s+/);
  if (!shouldRewriteCandidate(fields, options.localUdpPort)) {
    return [];
  }

  const variants: string[] = [];
  for (const endpoint of endpoints) {
    const key = buildDedupeKey(endpoint, options.mid);
    if (options.seen?.has(key)) {
      continue;
    }
    options.seen?.add(key);

    const nextFields = [...fields];
    const originalFoundation = nextFields[0]!.slice('candidate:'.length) || 'host';
    nextFields[0] = `candidate:pub${originalFoundation}`;
    nextFields[4] = endpoint.ip;
    nextFields[5] = String(endpoint.port);
    variants.push(`${prefix}${nextFields.join(' ')}`);
  }

  return variants;
}

export function appendPublicIceCandidatesToSdp(
  sdp: string,
  endpoints: RtcDataAudioPublicCandidateEndpoint[],
  options: Pick<RtcDataAudioCandidateRewriteOptions, 'localUdpPort' | 'seen'> = {},
): string {
  if (!sdp || endpoints.length === 0) {
    return sdp;
  }

  const newline = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const output: string[] = [];
  let currentMid: string | null = null;

  for (const line of lines) {
    if (line.startsWith('a=mid:')) {
      currentMid = line.slice('a=mid:'.length).trim() || null;
    }
    output.push(line);
    if (line.startsWith('a=candidate:')) {
      output.push(...createPublicIceCandidateVariants(line, endpoints, {
        localUdpPort: options.localUdpPort,
        mid: currentMid,
        seen: options.seen,
      }));
    }
  }

  return output.join(newline);
}

export async function resolvePublicCandidateEndpoints(
  publicHost: string | null | undefined,
  publicUdpPort: number,
  timeoutMs = DNS_LOOKUP_TIMEOUT_MS,
): Promise<RtcDataAudioPublicCandidateEndpoint[]> {
  const host = publicHost?.trim();
  if (!host) {
    return [];
  }

  if (isIP(host)) {
    return [{ ip: host, port: publicUdpPort }];
  }

  const records = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`DNS lookup timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);

  const uniqueIps = Array.from(new Set(records.map((record) => record.address).filter(Boolean)));
  return uniqueIps.map((ip) => ({ ip, port: publicUdpPort }));
}
