# Notification Sounds

Source: [Kenney Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds)
by Kenney. Downloaded September 8, 2026 from the author's distribution:
https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip

License: CC0 1.0. See the accompanying original `License.txt`.

| Bundled file | Original file | Applied gain |
| --- | --- | --- |
| glass.wav | Audio/glass_001.ogg | -4.0 dB |
| glass-long.wav | Audio/glass_004.ogg | -6.0 dB |
| pluck.wav | Audio/pluck_001.ogg | -3.6 dB |
| pluck-alt.wav | Audio/pluck_002.ogg | -2.5 dB |
| confirmation.wav | Audio/confirmation_001.ogg | -12.7 dB |
| confirmation-alt.wav | Audio/confirmation_002.ogg | -9.1 dB |
| bong.wav | Audio/bong_001.ogg | -7.8 dB |
| question.wav | Audio/question_001.ogg | -12.2 dB |

Converted with FFmpeg to mono, 44.1 kHz, signed 16-bit PCM WAV for browser
compatibility. Several sounds are shorter than the 400 ms loudness measurement
window, so normalization uses FFmpeg `volumedetect` mean volume instead of LUFS.
The applied gains target approximately -24 dBFS RMS with sample peaks at or below
-3 dBFS. Pluck 2 uses an additional 0.2 dB attenuation to meet the peak ceiling:

```sh
ffmpeg -i INPUT.ogg -af volume=GAINdB -ar 44100 -ac 1 -c:a pcm_s16le OUTPUT.wav
```

Only these eight derived files are shipped. Playback uses local bundled assets;
no runtime requests are made to the source site.
