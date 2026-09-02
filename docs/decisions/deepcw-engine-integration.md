# DeepCW engine integration

## Decision

TX-5DR uses the model and metadata published by
[`e04/deepcw-engine`](https://github.com/e04/deepcw-engine), pinned to commit
`8e264d2`. The model is distributed under `AGPL-3.0-only` and is accompanied by
the upstream license and attribution notice in `resources/licenses`.

The audio stream remains owned by `AudioStreamManager` at its configured source
rate (the CW processing stream is normally 9600 Hz). The CW decoder boundary
resamples each input chunk to the model's required 3200 Hz rate before buffering
or dispatching worker jobs. This keeps realtime audio ownership unchanged while
making the model preprocessing contract explicit.

## Model contract

`resources/models/deepcw/model.onnx.json` is shipped beside the model and records
the upstream preprocessing contract: mono PCM at 3200 Hz, FFT length 256, hop
length 48, Hann window, reflection padding, log1p magnitude, and 65 bins from
400 to 1200 Hz. The model currently provides one English vocabulary and one
model variant; legacy `modelSize` and `language` fields are normalized to the
supported values for wire compatibility.

## Distribution

Release artifacts must include the model metadata, AGPL-3.0-only text, source
link, and corresponding-source offer required by the upstream license. Any
future model update must record its upstream commit and SHA-256 values and must
pass the CW decoder smoke test before packaging.
