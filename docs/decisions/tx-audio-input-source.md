# TX audio input source capability

## Current availability

The source contains the model-specific `tx_audio_input_source` capability and
providers, but the capability is disabled for all models by
`TEMPORARILY_DISABLED_CAPABILITIES` in
`packages/server/src/radio/capabilities/definitions.ts`.
`PhysicalRadioManager.applyTxAudioInputSourcePolicy()` also exits at that gate.
The application must not advertise, dispatch or automatically apply this route
while the gate is present. Adapter implementation alone is not feature availability.

The quarantine addresses asynchronous scope frames and raw CAT replies sharing
the Hamlib/CI-V serial stream. Re-enabling requires protocol-level transaction
isolation and matching regression/hardware evidence; removing a UI gate alone
is insufficient. This document does not authorize re-enabling it.

## Retained design

TX input routing is model-specific and is not implied by DATA mode or generic
PTT/level support. Providers translate normalized sources such as `mic`, `usb`,
`network` and `accessory` using an exact model route table. Unknown models remain
unsupported. Compound menu selectors require one serialized write/readback
transaction so partial changes cannot be mistaken for a confirmed input route.

Hamlib provider selection and command/value tables live in
`packages/server/src/radio/txAudioInput/TxAudioInputProvider.ts`, with adjacent
unit tests. `HamlibConnection` executes their raw I/O through its serialized
queue. `IcomWlanConnection` adapts the protocol library's model-specific source
API. Neither path may guess commands from another radio's identity.

Profiles retain `txAudioInputSource` for format compatibility: `auto`,
`unchanged`, or a normalized source. Behind the disabled gate, `auto` is defined
to choose `network` for ICOM WLAN and leave other backends unchanged. Failures
use capability availability/warning projection rather than changing PTT policy.
Those semantics describe retained code, not a currently active control.

## Guards

`packages/server/src/radio/__tests__/CapabilityDefinitions.test.ts` guards the
disabled capability. Manager/capability tests must continue to prevent automatic
writes and dispatch while it is quarantined. Provider tests prove byte mapping
and readback behavior only; they do not establish live model compatibility.
