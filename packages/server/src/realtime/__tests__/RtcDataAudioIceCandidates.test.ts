import { describe, expect, it } from 'vitest';
import {
  appendPublicIceCandidatesToSdp,
  createPublicIceCandidateVariants,
  resolvePublicCandidateEndpoints,
} from '../RtcDataAudioIceCandidates.js';

describe('RtcDataAudioIceCandidates', () => {
  it('appends public variants for UDP host trickle candidates and deduplicates per mid', () => {
    const seen = new Set<string>();
    const candidate = 'candidate:1 1 udp 2122260223 192.168.1.23 50110 typ host generation 0';
    const first = createPublicIceCandidateVariants(candidate, [{ ip: '203.0.113.10', port: 50110 }], {
      localUdpPort: 50110,
      mid: '0',
      seen,
    });
    const second = createPublicIceCandidateVariants(candidate, [{ ip: '203.0.113.10', port: 50110 }], {
      localUdpPort: 50110,
      mid: '0',
      seen,
    });

    expect(first).toEqual(['candidate:pub1 1 udp 2122260223 203.0.113.10 50110 typ host generation 0']);
    expect(second).toEqual([]);
  });

  it('ignores non-UDP, non-host, or unrelated-port candidates', () => {
    expect(createPublicIceCandidateVariants(
      'candidate:1 1 tcp 2122260223 192.168.1.23 9 typ host tcptype active',
      [{ ip: '203.0.113.10', port: 50110 }],
      { localUdpPort: 50110 },
    )).toEqual([]);
    expect(createPublicIceCandidateVariants(
      'candidate:2 1 udp 1686052607 198.51.100.50 62000 typ srflx raddr 192.168.1.23 rport 50110',
      [{ ip: '203.0.113.10', port: 50110 }],
      { localUdpPort: 50110 },
    )).toEqual([]);
    expect(createPublicIceCandidateVariants(
      'candidate:3 1 udp 2122260223 192.168.1.23 62000 typ host generation 0',
      [{ ip: '203.0.113.10', port: 50110 }],
      { localUdpPort: 50110 },
    )).toEqual([]);
  });

  it('appends public candidate lines to inline SDP candidates', () => {
    const sdp = [
      'v=0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'a=mid:data',
      'a=candidate:1 1 udp 2122260223 192.168.1.23 50110 typ host generation 0',
      'a=end-of-candidates',
      '',
    ].join('\r\n');

    const rewritten = appendPublicIceCandidatesToSdp(sdp, [{ ip: '203.0.113.10', port: 40000 }], {
      localUdpPort: 50110,
      seen: new Set<string>(),
    });

    expect(rewritten).toContain('a=candidate:1 1 udp 2122260223 192.168.1.23 50110 typ host generation 0');
    expect(rewritten).toContain('a=candidate:pub1 1 udp 2122260223 203.0.113.10 40000 typ host generation 0');
  });

  it('resolves literal public IPs without DNS', async () => {
    await expect(resolvePublicCandidateEndpoints('203.0.113.10', 50110)).resolves.toEqual([
      { ip: '203.0.113.10', port: 50110 },
    ]);
  });
});
