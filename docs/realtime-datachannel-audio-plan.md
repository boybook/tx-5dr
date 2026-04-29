# rtc-data-audio Removal/Deployment Progress

## Goal

TX-5DR realtime voice now uses only two public transports:

- `rtc-data-audio`: default low-latency WebRTC DataChannel audio path.
- `ws-compat`: guaranteed TCP fallback and force-compatible mode.

The previous external realtime media stack is removed from product features, API contracts, UI settings, dependencies, startup scripts, and packaging. A small one-time legacy cleanup remains only in Linux upgrade scripts to stop TX-5DR-managed old services/files when they are detected.

## Current Scope

- Public transport kinds: `rtc-data-audio`, `ws-compat`.
- Default auto order for radio voice sessions: `rtc-data-audio -> ws-compat`.
- `force-compat` returns only `ws-compat`.
- OpenWebRX preview remains on buffered monitor / compatible playback in v1.
- Audio codec negotiation is per session. The default preference is `auto`: Opus is selected when both browser WebCodecs and the server native codec are available; otherwise the same transport falls back to PCM s16le.
- Opus frames carry source sample rate, codec sample rate, timestamps, sequence, duration, and encoded payload metadata. PCM frames keep the existing compatible frame format.
- Radio RX Opus publishers encode the native source rate directly when it is an Opus-supported rate (`48k/24k/16k/12k/8k`) and the browser advertises that decode rate. If the browser only supports a subset, the server pins the Opus codec rate to a supported value and uses the streaming resampler. They never use the PCM decimator.
- PCM fallback publishers still apply transport-edge direct integer decimation for high-rate PCM, so 48 kHz native soundcard frames are sent as 24 kHz without touching the native source or digital decode ring buffer.
- TURN is not bundled in v1; STUN/direct ICE is used first.
- Default server media UDP uses a single fixed port, `50110`, via `RTC_DATA_AUDIO_UDP_PORT` and ICE UDP mux.

## Architecture Decisions

- `RealtimeRxAudioRouter` remains the single source selector.
- `NativeRadioRxSource` is the only radio monitor source for both voice and digital modes.
- `BufferedPreviewRxSource` remains only for OpenWebRX/buffered preview paths.
- `rtc-data-audio` reuses the existing browser AudioWorklet playback/capture implementation and swaps only the transport.
- `@discordjs/opus` is dynamically loaded on the server as a degradable native codec. If unavailable, sessions resolve to PCM and realtime transport availability is unaffected.
- Browser Opus uses native WebCodecs only; v1 intentionally has no WASM Opus fallback.
- `node-datachannel` is dynamically loaded and capability-gated. If unavailable on a platform, the server removes `rtc-data-audio` from offers and falls back to `ws-compat`.
- `ws-compat` keeps stale-frame dropping and no-prefill recovery behavior so TCP fallback does not accumulate unbounded latency.
- Browser playback/capture runtime is prepared once inside the user gesture and shared across fallback attempts.

## Progress

| Phase | Status | Notes |
| --- | --- | --- |
| Documentation baseline | done | Architecture docs updated for the two-transport design. |
| Contracts/protocol | done | Transport schemas only accept `rtc-data-audio` and `ws-compat`; codec preference/capability negotiation supports `auto`, `opus`, and `pcm`; generic PCM frame aliases remain compatible with WS exports. |
| Server transport | done | DataChannel manager, signaling route, source router, codec-aware RX/TX bridge, and fallback offers are implemented. |
| Web transport | done | Browser DataChannel client uses shared playback/capture AudioWorklets, negotiates codec capability, and falls back to WS without recreating audio runtime. |
| Packaging/platform | done | Docker, Electron, and Linux server use embedded `node-datachannel`, retain/sign Opus native `.node` binaries, and degrade to PCM/WS when realtime native modules are unavailable. |
| FRP public UDP settings | done | Admin host/port settings append public ICE candidates while keeping local candidates. |
| Legacy removal | done | Runtime bindings, docs, dependencies, startup scripts, and packaging paths are removed; only one-time legacy cleanup logic remains. |
| Transport-edge PCM decimation | done | RTC Data and WS publishers share a direct integer decimator; 48 kHz soundcard input becomes 24 kHz, while 24 kHz/16 kHz/12 kHz sources stay unchanged. |
| Opus codec negotiation | done | RX and TX support Opus over both rtc-data-audio and ws-compat; unavailable clients/servers resolve to PCM on the same transport. |

## Implementation Checklist

- [x] Add `node-datachannel@0.32.3` runtime dependency to `@tx5dr/server`.
- [x] Add `rtc-data-audio` to contract schemas and display types.
- [x] Remove the old realtime media transport from public schemas and overrides.
- [x] Generalize the WS PCM protocol without breaking existing exports.
- [x] Add server DataChannel capability detection.
- [x] Add `/api/realtime/rtc-data-audio` signaling WebSocket.
- [x] Add RX publisher with age/backpressure dropping.
- [x] Add TX receiver that feeds `VoiceSessionManager`.
- [x] Add browser `RtcDataAudioClient`.
- [x] Extend playback and voice capture session flows.
- [x] Remove old UI settings, diagnostics, token/room concepts, and package dependencies.
- [x] Update package cleanup/native check for `node-datachannel`.
- [x] Add admin-configurable rtc-data-audio public UDP host/port for FRP/static NAT.
- [x] Append public ICE candidates while keeping local candidates for LAN/direct access.
- [x] Reuse one playback/capture AudioContext + AudioWorklet runtime across `rtc-data-audio -> ws-compat` fallback.
- [x] Re-run dependency install to remove stale lockfile entries.
- [x] Re-run focused tests/builds after the final removal pass.
- [x] Re-run global grep gate.
- [x] Add low-cost transport-edge PCM decimation to reduce 48 kHz stream bandwidth.
- [x] Add codec-aware frame protocol for Opus while keeping PCM frame compatibility.
- [x] Add `@discordjs/opus` as a degradable server optional dependency and native check target.
- [x] Add browser WebCodecs Opus capability probing, RX decode, and TX encode.
- [x] Add UI codec preference (`自动 / Opus / PCM`) plus actual codec/sample-rate/bitrate display.
- [x] Preserve, clean, and sign Opus native binaries in Electron, Docker, and Linux server packaging flows.

## Deployment Notes

- Docker compose exposes `8076/tcp`, `8443/tcp`, and `50110/udp` by default.
- Docker runtime installs `libopus0`; Linux deb/rpm packages declare `libopus0` / `opus`; Electron macOS signs bundled `.node` addons including `@discordjs/opus`.
- Electron starts the embedded server directly and passes `RTC_DATA_AUDIO_UDP_PORT` / `RTC_DATA_AUDIO_ICE_UDP_MUX` into the server process.
- Linux server packages install only `tx5dr` and nginx; `tx5dr doctor --fix` can prepare HTTP/HTTPS and the configured UDP firewall rule.
- For FRP/static NAT, map the chosen public UDP port to the server UDP port, then set the public endpoint in Settings -> Realtime Audio.
- A failed UDP connection should fail fast into `ws-compat`; it must not recreate the AudioContext, AudioWorklet, or microphone stream.
- Opus adds no ports and does not change the FRP/UDP deployment model. If `@discordjs/opus` or browser WebCodecs is unavailable, users continue on PCM.

## Validation Log

- 2026-04-28: `yarn workspace @tx5dr/server build`
- 2026-04-28: `yarn workspace @tx5dr/web build`
- 2026-04-28 final: fixed rtc-data-audio to a single UDP port only, disabled ICE TCP candidates, and wired browser PeerConnection ICE servers from the server runtime hints.
- 2026-04-28 final: `bash -n linux/lib/common.sh linux/lib/checks.sh linux/install.sh linux/postinstall.sh linux/tx5dr-cli.sh scripts/package-linux.sh docker/entrypoint.sh scripts/dev-runtime.js`
- 2026-04-28 final: `node --check forge.config.js && node --check scripts/dev-runtime.js && node --check packages/client-tools/src/proxy.js`
- 2026-04-28 final: `yarn workspace @tx5dr/contracts test`
- 2026-04-28 final: `yarn workspace @tx5dr/server test src/realtime/__tests__/RealtimeTransportManager.test.ts src/realtime/__tests__/RtcDataAudioManager.test.ts src/realtime/__tests__/RtcDataAudioIceCandidates.test.ts src/realtime/__tests__/RealtimeRxAudioRouter.test.ts src/realtime/__tests__/StreamingAudioResampler.test.ts src/audio/__tests__/BufferedPreviewAudioService.test.ts src/audio/__tests__/AudioStreamManager.icom-wlan.test.ts src/voice/__tests__/VoiceTxDiagnostics.test.ts`
- 2026-04-28 final: `yarn workspace @tx5dr/web test`
- 2026-04-28 final: `yarn build`
- 2026-04-28 final: `yarn workspace @tx5dr/server dev:check-native`
- 2026-04-28 final: removed-transport grep gate passed; targeted room/old-port grep gate passed outside checksum-only lockfile matches; `git diff --check` passed.
- 2026-04-28 final review: removed stale release-workflow references to the old media stack and re-ran the tracked/hidden removed-transport grep gate; no source/docs/startup references remain outside deleted files and ignored local caches.
- 2026-04-29: Opus realtime codec pass added. Validation: `yarn workspace @tx5dr/contracts build && yarn workspace @tx5dr/core build && yarn workspace @tx5dr/server build && yarn workspace @tx5dr/web build`; focused contracts/core/server/web realtime tests passed.

- 2026-04-28: `yarn install`
- 2026-04-28: `bash -n linux/lib/common.sh linux/lib/checks.sh linux/install.sh linux/postinstall.sh linux/tx5dr-cli.sh scripts/package-linux.sh docker/entrypoint.sh scripts/dev-runtime.js`
- 2026-04-28: `yarn workspace @tx5dr/electron-main build`
- 2026-04-28: global removed-transport grep gate passed for source, docs, dependency lockfile, Docker, Electron, and Linux startup paths
- 2026-04-28: `git diff --check`
- 2026-04-28: `yarn workspace @tx5dr/server dev:check-native`
- 2026-04-28: `yarn workspace @tx5dr/server test src/realtime/__tests__/RealtimeTransportManager.test.ts src/realtime/__tests__/RealtimeRxAudioRouter.test.ts src/realtime/__tests__/StreamingAudioResampler.test.ts src/audio/__tests__/BufferedPreviewAudioService.test.ts src/audio/__tests__/AudioStreamManager.icom-wlan.test.ts`
- 2026-04-28: `yarn workspace @tx5dr/core test src/realtime/__tests__/wsCompatProtocol.test.ts`
- 2026-04-28: `node --check forge.config.js`
- 2026-04-28: `node --check scripts/dev-runtime.js`
- 2026-04-28: `bash -n linux/lib/checks.sh`
- 2026-04-28: `bash -n scripts/package-linux.sh`
- 2026-04-28: `yarn build`
- 2026-04-28: `yarn workspace @tx5dr/contracts test src/schema/__tests__/realtime-settings.schema.test.ts`
- 2026-04-28: `yarn workspace @tx5dr/contracts test`
- 2026-04-28: `yarn workspace @tx5dr/server test src/realtime/__tests__/RtcDataAudioIceCandidates.test.ts`
- 2026-04-28: `yarn workspace @tx5dr/server test src/realtime/__tests__/RealtimeTransportManager.test.ts src/realtime/__tests__/RtcDataAudioIceCandidates.test.ts`
- 2026-04-28: `yarn workspace @tx5dr/contracts build`
- 2026-04-28: `yarn workspace @tx5dr/core build`
- 2026-04-28: `yarn workspace @tx5dr/server build`
- 2026-04-28: `yarn workspace @tx5dr/web build`

## Risks and Mitigations

- Native addon unavailable on a platform: dynamic import is optional and fallback remains `ws-compat`.
- Opus native codec unavailable on a platform: codec negotiation resolves to PCM on the same transport; only rtc-data-audio runtime/ICE failures trigger transport fallback.
- Browser WebCodecs Opus unavailable: client capability probe advertises PCM-only support and sessions resolve to PCM.
- ICE cannot connect on a deployment: offer fallback order includes `ws-compat`, and `force-compat` remains available.
- Fixed UDP port conflicts: change `RTC_DATA_AUDIO_UDP_PORT` or force `ws-compat`; DataChannel auto fallback remains available.
- TCP fallback still accumulates under severe loss: WS stale-frame and worklet no-prefill recovery behavior reduce this risk.
- Audio source regressions: radio publishers consume only `NativeRadioRxSource` via `RealtimeRxAudioRouter`; buffered preview code never becomes a hidden radio monitor path again.
- Voice keyer monitor regressions: TX monitor remains injected through `NativeRadioRxSource` and routed through the same current transport.
- FRP public UDP misconfiguration: rtc-data-audio connection attempts time out or fail fast, then the offer loop falls back to `ws-compat`; active sessions are not hot-updated by settings saves.

## Rollback

- Set transport policy to force `ws-compat`.
- If `node-datachannel` fails to load, `rtc-data-audio` is not offered.
- Leave the rtc-data-audio public host empty to stop publishing public ICE candidates; clients still receive local candidates and can fall back to `ws-compat`.
