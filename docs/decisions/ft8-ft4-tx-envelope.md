# FT8/FT4 transmission audio envelope

Status: accepted (2026-09-01)

## Boundary

FT8 and FT4 encoded audio opts into the `ft8-ft4` transmission envelope at
the `AudioStreamManager.playAudio()` boundary. `AudioMixer` remains responsible
only for resampling, multi-track mixing, and static level calibration.

The same enveloped PCM is used by ICOM WLAN, TCI, RtAudio, and Android output
routes. The encoder and radio protocol adapters do not own envelope policy.

## Policy

- shape: raised cosine;
- attack: 10 ms;
- release: 10 ms;
- forced-stop tail: at most 10 ms;
- profile is explicit and is not inferred from a generic playback kind.

The envelope does not change the logical FT8/FT4 waveform duration or slot
cursor. It only changes boundary amplitudes. Other playback modes remain
opted out.

## Lifecycle

Normal completion applies the release envelope before the final PCM is sent and
waits for the selected output path to drain before releasing PTT. A forced stop
or digital frame replacement fences new producer output, emits one bounded
release tail from the last submitted sample, waits for bounded drain, and then
releases PTT. Device errors or drain timeouts take the existing safety/unknown
release path without waiting indefinitely.

Each replacement generation receives its own attack envelope. Existing lease,
epoch, and stale-callback fences remain authoritative.
