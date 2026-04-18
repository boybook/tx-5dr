# @tx5dr/rigctld-server

A pure-TypeScript Hamlib **rigctld** protocol emulation server. Speaks the NET
rigctl (model 2) TCP protocol used by N1MM Logger+, WSJT-X, JTDX, fldigi, and
other amateur-radio logger / digital-mode software.

The server does **not** control any hardware itself. You pass in a
`RadioController` implementation and it translates incoming wire commands into
calls on your controller.

## Install

```sh
npm install @tx5dr/rigctld-server
```

Runtime dependencies: **none** (only the Node.js standard library).

## Usage

```ts
import { RigctldServer, type RadioController } from '@tx5dr/rigctld-server';

const controller: RadioController = {
  async getFrequency() { return 14_074_000; },
  async setFrequency(hz) { /* call your rig */ },
  async getMode() { return { mode: 'USB', bandwidthHz: 2400 }; },
  async setMode(mode, bw) { /* ... */ },
  async getPTT() { return false; },
  async setPTT(on) { /* ... */ },
};

const server = new RigctldServer({
  controller,
  host: '0.0.0.0',
  port: 4532,
});

await server.listen();
// Later:
// await server.close();
```

Point any NET rigctl client at `127.0.0.1:4532`:

```
rigctl -m 2 -r 127.0.0.1:4532 f
rigctl -m 2 -r 127.0.0.1:4532 F 14074000
rigctl -m 2 -r 127.0.0.1:4532 \dump_state
```

## Supported commands

| Short | Long | Purpose |
|-------|------|---------|
| `f` / `F` | `get_freq` / `set_freq` | VFO frequency in Hz |
| `m` / `M` | `get_mode` / `set_mode` | Mode + passband |
| `v` / `V` | `get_vfo` / `set_vfo` | Active VFO (optional) |
| `t` / `T` | `get_ptt` / `set_ptt` | Transmit on/off |
| `s` / `S` | `get_split_vfo` / `set_split_vfo` | Split on/off + TX VFO |
| `i` / `I` | `get_split_freq` / `set_split_freq` | Split TX frequency |
| `x` / `X` | `get_split_mode` / `set_split_mode` | Split TX mode |
| `l` / `L` | `get_level` / `set_level` | `RFPOWER`, `AF`, `SQL`, `STRENGTH` |
| `1` | `chk_vfo` | VFO-in-args capability check |
| — | `dump_state` | Capability discovery payload |
| — | `get_info` | Free-form identity string |
| — | `get_powerstat` / `set_powerstat` | Rig power |
| `q` | `quit` | Close session |

Commands the controller does not implement return `RPRT -11` (`RIG_ENIMPL`).
Unknown commands also return `RPRT -11`.

Extended response mode (leading `+` or `;`) is supported — WSJT-X uses this by
default.

## Error handling

Controller methods that throw are mapped to `RPRT -5` (`RIG_EIO`). Throw
`RigctldProtocolError(code, message)` to emit a specific error code:

```ts
import { RigctldProtocolError, RigErr } from '@tx5dr/rigctld-server';

async setFrequency(hz) {
  if (hz < 1_800_000) throw new RigctldProtocolError(RigErr.EINVAL, 'below 160m');
  // ...
}
```

## License

MIT.
