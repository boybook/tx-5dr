# TX audio input routing: Hamlib-side research

Status: implemented for the first verified provider set (2026-09-01)

## Evidence and scope

Hamlib exposes CAT primitives and `sendRaw`, but no model-neutral TX audio
input selector. The adapter therefore uses Hamlib's selected rig metadata
(`mfgName` + `modelName`) as the identity key and applies only an explicit
provider entry. Unknown models remain unsupported; no command is guessed.

The command/value rows below were cross-checked against the checked-in
Hamlib/wfview rig definitions and the ICOM CI-V profile implementation:

| Manufacturer / models | Protocol command | Values used by provider | Status |
| --- | --- | --- | --- |
| ICOM IC-705, IC-905 | CI-V `1A 05 01 19` | `0 MIC`, `1 ACC`, `2 USB`, `3 WLAN` | implemented; raw frame + readback |
| Yaesu FT-710, FTX-1 | New CAT `EX010114`, `EX010214`, `EX010313`, `EX010414` | `0 MIC`, `1 USB`, `2 REAR` (normalized `accessory`) | implemented; command selected by current mode |
| Kenwood TS-890S | `MS0` (normal voice modulation source) | `0 MIC`, `1 ACC2`, `2 USB`, `3 LAN` | implemented; raw CAT + readback |

The Yaesu rig files expose an additional value `3=AUTO`; the current shared
contract has no `auto` value, so AUTO is intentionally not advertised or
returned as a normalized source. Kenwood TS-590SG only exposes a DATA1 input
extension in the checked-in definition; it is not included because this
feature is explicitly about the physical voice/audio source, not DATA mode.

Other ICOM models have model-specific `1A 05` extensions (and in several cases
different sub-addresses). They are deliberately left out until each command
and value table is verified against a model-specific source and hardware or
protocol fixture. This avoids treating a DATA-mode register as a universal
voice-input selector.

## Runtime invariants

- All raw CAT/CI-V I/O is executed inside `HamlibConnection`'s serialized
  `RadioIoQueue`; writes are marked critical.
- A capability is advertised only when the exact Hamlib model metadata matches
  a provider. A write is followed by a readback and fails closed on mismatch.
- Provider failures make the dynamic capability unavailable but do not block
  PTT or other operating-state operations.
- No live transmission is part of the validation; real-radio validation should
  query, set, and read back while the radio is in receive state.

