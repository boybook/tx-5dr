# TX audio input source capability

Status: accepted (2026-09-01)

TX audio routing is model-specific and must not be inferred from DATA mode or
Hamlib's generic level/PTT APIs. TX-5DR exposes only the current effective
route through the dynamic `tx_audio_input_source` enum capability. Protocol
adapters (or a future sidecar provider) translate normalized values such as
`mic`, `usb`, `network`, and `accessory` to CI-V/CAT commands.

The capability is optional and is advertised only after a model/provider
reports a model-specific route table. Hamlib connections without an exact model
provider remain unsupported and are never sent guessed raw commands.

Profiles may set `txAudioInputSource` to `auto`, `unchanged`, or a normalized
source. `auto` currently selects `network` for ICOM WLAN; all other backends
leave their physical route unchanged until a provider is added. Applying the
policy is best effort: failures mark the capability unavailable and emit a
warning, but do not block PTT or other operating-state changes.
