# Spectrum amplitude semantics

TX-5DR keeps spectrum transport and rendering shared while preserving each
source's amplitude reference. `SpectrumFrame.binaryData.format.scale` and
`offset` describe wire decoding only; `SpectrumFrame.meta.level` describes the
resulting level domain and display unit.

Supported radio SDR level domains are:

- `dbfs` / `dBFS`: TCI IQ FFT values referenced to digital full scale.
- `calibrated-db` / `dB`: Hamlib values mapped from the device-reported data
  level range to its signal-strength range.
- `raw` / `Level`: unsigned 8-bit display values without an absolute
  calibration, used by ICOM WLAN and Hamlib fallback frames.

The Web UI uses one shared spectrum component and interaction model, but range
defaults and persisted manual ranges are selected by the level domain. Missing
level metadata on legacy `radio-sdr` frames is interpreted as `raw` / `Level`.
