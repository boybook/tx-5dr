# DeepCW engine model

This directory contains the model and metadata published by
https://github.com/e04/deepcw-engine at commit `8e264d2`.

The model is licensed under AGPL-3.0-only. The complete license text and
corresponding-source obligations are included in
`resources/licenses/deepcw-engine-AGPL-3.0-only-LICENSE`.

`model.onnx.json` is authoritative for preprocessing. The pinned model expects
3200 Hz mono PCM and a log1p magnitude spectrogram with FFT length 256, hop
length 48, and 65 frequency bins covering 400-1200 Hz.

SHA-256:

```text
model.onnx      ef120799457bca042d4690944f0faf93268eb4654e7f50f28784ad63bdc1fe02
model.onnx.json b4342157b90229ee7380e165f3d8036179b80d1e6ae02f2557388b7fcd558c01
```

You can override the bundled model path with `TX5DR_DEEPCW_MODEL_PATH`.

## Runtime acceleration

TX-5DR uses `onnxruntime-node` for DeepCW inference. CPU is always available.
macOS can use CoreML, and Linux x64 can expose CUDA or experimental WebGPU
execution providers when the host GPU stack is already installed.

Linux GPU acceleration is intentionally self-managed: TX-5DR packages do not
install NVIDIA drivers, CUDA, cuDNN, or other system GPU libraries. For CUDA,
install the NVIDIA driver and CUDA v12 runtime required by `onnxruntime-node`;
if provider initialization fails, switch the CW decoder runtime back to CPU.
