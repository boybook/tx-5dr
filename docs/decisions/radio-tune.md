# Manual tune: radio-owned TUNE before audio tone

Status: accepted

## Decision

`TuneToneController` owns manual tune. When the connection provides its own tune
function (`supportsRadioTune()`), the radio generates the carrier at its tune
power; otherwise TX-5DR keys PTT and transmits a sine tone at the normal drive.
`TuneToneStatus.method` reports the method in use, or the next one while idle.

Only TCI implements it (`TUNE`; tune power is the `tune_power` capability over
`TUNE_DRIVE`). `tuner_tune` remains the one-shot ATU match.

## Invariants

- A TCI session offers the radio tune only if its startup state reported `TUNE`
  for the configured TRX and the device is not receive-only.
- The radio tune holds a self-keyed physical TX lease (`assertPtt: false`); it is
  active after the radio confirms ON, and the lease interrupt switches it OFF.
- Both methods stop after the maximum duration. The radio reporting `TUNE` OFF
  ends the session.
- An unconfirmed `TUNE` write poisons the session like an unconfirmed `TRX`. OFF
  stays permitted and ignores the stale cached state. A carrier this client
  started is switched OFF before a deliberate disconnect.
- An active radio tune counts as transmitting for idle-only TCI parameters.

## Evidence

ExpertSDR3 TCI 1.7–2.1 define `TUNE`/`TUNE_DRIVE` as broadcast bidirectional
controls. Thetis does not stop TUNE when a client disconnects; WSJT-X and JTDX
never send `TUNE`. Behaviour of real ExpertSDR3 hardware during TUNE is not yet
confirmed.
