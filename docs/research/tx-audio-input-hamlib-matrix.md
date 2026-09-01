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
| Kenwood TS-990S | `MS P1 P2 P3 P4 P5` | MIC/ACC2/USB-Audio/Optical and documented combinations | implemented; ordered composite CAT + readback |
| Kenwood TS-590SG | `EX0690000` DATA modulation line | ACC2 or USB (DATA mode only) | unsupported for normal TX source |
| Yaesu FTDX10 | composite MOD SOURCE + REAR SELECT | MIC/REAR + DATA/USB pair | implemented; ordered raw CAT + readback |
| Yaesu FT-991A | `EX070` + `EX072` (DATA), `EX106` + `EX109` (SSB) | two-stage route | implemented; ordered raw CAT + readback |
| Yaesu FTDX101D / FTDX101MP | likely composite, but not assumed equal to FTDX10 | model/revision-specific | unsupported; no shared profile inference |
| Yaesu FT-891 | MIC/REAR only; no internal USB audio | model-specific | unsupported until exact CAT selector is verified; USB is never advertised |
| TCI/SunSDR | `Mic/VAC` stream source | per-PTT/session selection, not persistent | unsupported by this capability |
| Elecraft K3/K4 | CAT mode/data controls | no persistent input-source selector found | unsupported |
| Xiegu G90/X6100 | CAT/CI-V-like controls | no authoritative persistent input-source definition found | unsupported |

The Yaesu rig files expose an additional value `3=AUTO`; the current shared
contract has no `auto` value, so AUTO is intentionally not advertised or
returned as a normalized source. Kenwood TS-590SG only exposes a DATA1 input
extension in the checked-in definition; it is not included because this
feature is explicitly about the physical voice/audio source, not DATA mode.

The composite Yaesu rows are implemented independently from the FT-710
provider: a normalized `usb` write is represented as two ordered menu writes,
and a partial write could leave the radio selecting the wrong physical input.
FTDX10 and FT-991A are enabled only because their exact command bytes, value
meanings, and readback format are documented in the official CAT references.

Other ICOM models also have model-specific `1A 05` extensions (and in several
cases different sub-addresses). They are included only where the checked-in
model definition provides a complete normal-input value table.

## Official CAT references consulted

- [FTDX10 CAT Operation Reference (Yaesu)](https://www.yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FTDX10_CAT_OM_ENG_2308-F.pdf)
  defines SSB `EX010113` (MOD SOURCE) + `EX010114` (REAR SELECT), AM
  `EX010213` + `EX010215`, FM `EX010313` + `EX010314`, and DATA `EX010415`
  + `EX010416`. MOD SOURCE values are MIC/REAR; REAR SELECT values are
  DATA/USB.
- [FT-991A CAT Operation Reference (Yaesu)](https://www.yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FT-991A_CAT_OM_ENG_1711-D.pdf)
  defines DATA IN/PORT as `EX070`/`EX072` and SSB MIC/PORT as `EX106`/`EX109`;
  each is a two-register route and must be implemented as one serialized
  transaction.
- [FT-710 CAT Operation Reference (Yaesu)](https://www.yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FT-710_CAT_OM_ENG_2306-C.pdf)
  confirms the already implemented single-register per-mode `EX` selectors.
- [FTDX101MP/FTDX101D CAT Operation Reference (Yaesu)](https://www.yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FTDX101MP_D_CAT_OM_ENG_2308-L.pdf)
  defines the distinct FTDX101 `EX010111/112`, `EX010211/213`,
  `EX010310/312`, and `EX010413/414` pairs.
- [FT-891 CAT Operation Reference (Yaesu)](https://www.yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FT-891_CAT_OM_ENG_1909-C.pdf)
  exposes only MIC SELECT (MIC/REAR) per mode; no USB input selector exists.
- [TS-590S/SG PC Control Command Reference (Kenwood)](https://www.kenwood.com/i/products/info/amateur/pdf/ts590_g_pc_command_en_rev3.pdf)
  documents `EX069` as DATA modulation line ACC2/USB and explicitly scopes it
  to DATA operation.
- [TS-990S PC Control Command Reference (Kenwood)](https://www.kenwood.com/i/products/info/amateur/pdf/ts990_pc_command_en_rev2.pdf)
  documents the `MS` five-field transmission audio-entry source and its
  ACC2/USB mutual exclusion rules.
- [TCI Protocol](https://raw.githubusercontent.com/ExpertSDR3/TCI/main/TCI%20Protocol.pdf)
  describes microphone/audio streaming and per-transmit source selection; it
  does not define a persistent radio menu input route.
- [Elecraft K3/K3S/KX3 Programmer's Reference](https://ftp.elecraft.com/K3S/Manuals%20Downloads/archive/K3S%26K3%26KX3%20Pgmrs%20Ref%2C%20F2.pdf)
  contains mode/data commands but no persistent MIC/USB input selector.

## Runtime invariants

- All raw CAT/CI-V I/O is executed inside `HamlibConnection`'s serialized
  `RadioIoQueue`; writes are marked critical.
- A capability is advertised only when the exact Hamlib model metadata matches
  a provider. A write is followed by a readback and fails closed on mismatch.
- Provider failures make the dynamic capability unavailable but do not block
  PTT or other operating-state operations.
- No live transmission is part of the validation; real-radio validation should
  query, set, and read back while the radio is in receive state.
