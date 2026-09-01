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
| ICOM IC-7300 | CI-V `1A 05 00 66` (normal/Data-Off input) | `0 MIC`, `1 ACC`, `3 USB` | implemented; raw frame + readback |
| ICOM IC-7300MK2 | CI-V `1A 05 00 84` (normal/Data-Off input) | `0 MIC`, `1 USB`, `2 ACC`, `5 LAN` | implemented; raw frame + readback |
| ICOM IC-7610 | CI-V `1A 05 00 91` (normal/Data-Off input) | `0 MIC`, `1 ACC`, `3 USB`, `5 LAN` | implemented; raw frame + readback |
| ICOM IC-9700 | CI-V `1A 05 01 15` (normal/Data-Off input) | `0 MIC`, `1 ACC`, `3 USB`, `5 LAN` | implemented; raw frame + readback |
| ICOM IC-7760 | CI-V `1A 05 01 29` (normal/Data-Off input) | `0 MIC`, `3 ACC`, `1 USB`, `2 LINE`, `9 LAN` | implemented; raw frame + readback |
| Yaesu FT-710, FTX-1 | New CAT `EX010114`, `EX010214`, `EX010313`, `EX010414` | `0 MIC`, `1 USB`, `2 REAR` (normalized `accessory`) | implemented; command selected by current mode |
| Kenwood TS-890S | `MS0` (normal voice modulation source) | `0 MIC`, `1 ACC2`, `2 USB`, `3 LAN` | implemented; raw CAT + readback |
| Yaesu FTDX10 | composite MOD SOURCE + REAR SELECT | model-specific two-command transaction | unsupported pending manual byte/value verification |
| Yaesu FT-991A | `EX070` + `EX072` (DATA), `EX106` + `EX109` (SSB) | two-stage route | unsupported pending manual byte/value verification |
| Yaesu FTDX101D / FTDX101MP | likely composite, but not assumed equal to FTDX10 | model/revision-specific | unsupported; no shared profile inference |
| Yaesu FT-891 | MIC/REAR only; no internal USB audio | model-specific | unsupported until exact CAT selector is verified; USB is never advertised |

The Yaesu rig files expose an additional value `3=AUTO`; the current shared
contract has no `auto` value, so AUTO is intentionally not advertised or
returned as a normalized source. Kenwood TS-590SG only exposes a DATA1 input
extension in the checked-in definition; it is not included because this
feature is explicitly about the physical voice/audio source, not DATA mode.

The composite Yaesu rows are intentionally not implemented by reusing the
FT-710 provider: a normalized `usb` write may require two ordered menu writes,
and a partial write could leave the radio selecting the wrong physical input.
The implementation needs the exact command bytes, value meanings, readback
format, and failure semantics from the corresponding CAT reference manuals.

Other ICOM models also have model-specific `1A 05` extensions (and in several
cases different sub-addresses). They are included only where the checked-in
model definition provides a complete normal-input value table.

## Runtime invariants

- All raw CAT/CI-V I/O is executed inside `HamlibConnection`'s serialized
  `RadioIoQueue`; writes are marked critical.
- A capability is advertised only when the exact Hamlib model metadata matches
  a provider. A write is followed by a readback and fails closed on mismatch.
- Provider failures make the dynamic capability unavailable but do not block
  PTT or other operating-state operations.
- No live transmission is part of the validation; real-radio validation should
  query, set, and read back while the radio is in receive state.
