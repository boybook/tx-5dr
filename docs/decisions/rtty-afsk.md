# RTTY over AFSK

Status: accepted

## Decision

RTTY is an engine mode (`rtty`) owned by the Host. Transmit and receive use
software AFSK through the existing audio paths (soundcard, ICOM WLAN, TCI); the
radio runs in its data mode (LSB-D/USB-D, PKTLSB/PKTUSB, DIGL/DIGU). Hamlib,
CI-V and TCI expose no generic "send RTTY text" command, so radio-native RTTY
keyers (Elecraft `KY`, Yaesu memory transmit) and true FSK keying are not used.
`RttyService` keeps a single transmit-backend boundary so such backends can be
added later without changing the session lifecycle.

The modem lives in the first-party `rasterwave` crate (`rtty` module) and is
exposed by `rasterwave-node`. TX-5DR owns sessions, leases, audio routing and
presentation only; protocol and DSP behaviour belongs to the crate.

## Conventions

- Tones are an audio centre plus shift. Mark is the RF-higher tone: on LSB the
  mark is the lower audio tone, on USB the higher one; `reverse` swaps them on
  purpose. The default is 45.45 baud, 170 Hz, 1.5 stop bits, LSB, centre
  2210 Hz (mark 2125 Hz, space 2295 Hz).
- The sideband selects the radio data mode through the `digital` operating
  intent; switching sideband in RTTY mode re-applies the radio mode.
- `{RX}` in operator text or a stored message ends the transmission after the
  text. Message slots share the CW panel format, stored under `rtty-keyer`.

## Safety

RTTY transmission fails closed. The owning client disconnecting, the radio
disconnecting or changing frequency, a transmission-coordinator interruption,
leaving RTTY mode, a playback failure or the configured maximum duration stops
the transmission immediately and force-interrupts the physical lease. Stopping
is always permitted to operators.

## Not a plugin

The Plugin API cannot register engine modes or access transmit/receive audio,
by design, so RTTY is Host functionality. Plugins can contribute panels to the
`rtty-left-top` and `rtty-right-top` slots and can declare RTTY simulation
peers.
