# @tx5dr/plugin-api

Public plugin API for the [TX-5DR](https://github.com/boybook/tx-5dr) digital radio engine.

Plugin authors should import from this package instead of reaching into internal monorepo packages. It provides TypeScript types for plugin definitions, runtime helpers, logbook sync providers, and the iframe Bridge SDK.

## Installation

```bash
npm install --save-dev @tx5dr/plugin-api
```

## Quick Start

### TypeScript

```typescript
import type { PluginDefinition, PluginContext } from '@tx5dr/plugin-api';

const plugin: PluginDefinition = {
  name: 'my-plugin',
  version: '1.0.0',
  type: 'utility',
  hooks: {
    onDecode(messages, ctx) {
      for (const msg of messages) {
        ctx.log.debug('Decoded', { raw: msg.rawMessage });
      }
    },
  },
};

export default plugin;
```

### JavaScript (with JSDoc types)

```javascript
/** @type {import('@tx5dr/plugin-api').PluginDefinition} */
export default {
  name: 'my-plugin',
  version: '1.0.0',
  type: 'utility',
  hooks: {
    onDecode(messages, ctx) {
      for (const msg of messages) {
        ctx.log.debug('Decoded', { raw: msg.rawMessage });
      }
    },
  },
};
```

## Exports

| Subpath | Description |
|---------|-------------|
| `@tx5dr/plugin-api` | Core types: `PluginDefinition`, `PluginContext`, `PluginHooks`, helper interfaces, radio/message types |
| `@tx5dr/plugin-api/testing` | Mock factories for unit testing: `createMockContext()`, `createMockSlotInfo()`, `createMockParsedMessage()` |
| `@tx5dr/plugin-api/bridge` | Ambient type declarations for the iframe Bridge SDK (`window.tx5dr`) |

## Radio Permissions

Server-side plugins can use `ctx.radio` to inspect negotiated radio capabilities and, when explicitly permitted, control radio capabilities or physical power:

```ts
permissions: ['radio:read', 'radio:control', 'radio:power']
```

- `radio:read` enables `ctx.radio.capabilities.getSnapshot()` and `ctx.radio.power.getSupport()`.
- `radio:control` enables `ctx.radio.setFrequency()` and `ctx.radio.capabilities.write()`.
- `radio:power` enables `ctx.radio.power.set('on' | 'off' | 'standby' | 'operate')`.

These APIs are not exposed directly to iframe pages; custom UI should call a server-side page handler.

## Host Settings Permissions

Server-side plugins can use `ctx.settings` to read or update a safe whitelist of host settings when the manifest declares the matching permission. Each settings namespace uses one read/write permission:

| Namespace | Permission | Methods |
|-----------|------------|---------|
| `ctx.settings.ft8` | `settings:ft8` | `get()`, `update(patch)` |
| `ctx.settings.decodeWindows` | `settings:decode-windows` | `get()`, `update(settings)` |
| `ctx.settings.realtime` | `settings:realtime` | `get()`, `update(settings)` |
| `ctx.settings.frequencyPresets` | `settings:frequency-presets` | `get()`, `update(presets)`, `reset()` |
| `ctx.settings.station` | `settings:station` | `get()`, `update(patch)` |
| `ctx.settings.pskReporter` | `settings:psk-reporter` | `get()`, `update(patch)` |
| `ctx.settings.ntp` | `settings:ntp` | `get()`, `update({ servers })` |

```ts
import type { PluginDefinition } from '@tx5dr/plugin-api';

const plugin: PluginDefinition = {
  name: 'station-policy',
  version: '1.0.0',
  type: 'utility',
  permissions: ['settings:ft8', 'settings:station'],
  hooks: {
    async onLoad(ctx) {
      await ctx.settings.ft8.update({ maxSameTransmissionCount: 0 });
      await ctx.settings.station.update({ callsign: 'W1AW' });
    },
  },
};

export default plugin;
```

The whitelist intentionally excludes authentication tokens, operator CRUD, hardware radio connection settings, audio devices, rigctld, OpenWebRX, profiles, and server host/port settings. These APIs are not exposed directly to iframe pages; custom UI should call a server-side page handler with `window.tx5dr.invoke()`.

## Bridge SDK Types

Plugin iframe pages communicate with the host via the Bridge SDK (`window.tx5dr`), which is automatically injected by the host. To get IDE autocomplete for the Bridge SDK, add the type reference to your project:

**tsconfig.json / jsconfig.json:**

```json
{
  "compilerOptions": {
    "types": ["@tx5dr/plugin-api/bridge"]
  }
}
```

**Or per-file:**

```javascript
/// <reference types="@tx5dr/plugin-api/bridge" />

tx5dr.invoke('getState').then(function(state) {
  // Full autocomplete for tx5dr methods
});
```

## CSS Design Tokens

The host injects CSS custom properties (`--tx5dr-*`) into every iframe page. A reference copy is included in this package at `tokens.css` — copy it into your project for CSS autocomplete in your IDE:

```bash
cp node_modules/@tx5dr/plugin-api/tokens.css ./ui/
```

Then use the tokens in your plugin CSS:

```css
.container {
  background: var(--tx5dr-bg-content);
  color: var(--tx5dr-text);
  border-radius: var(--tx5dr-radius-md);
  padding: var(--tx5dr-spacing-md);
  font-family: var(--tx5dr-font);
}
```

## Testing

```typescript
import { describe, it, expect } from 'vitest';
import {
  createMockContext,
  createMockSlotInfo,
  createMockParsedMessage,
} from '@tx5dr/plugin-api/testing';
import plugin from './index.js';

describe('my-plugin', () => {
  it('processes decoded messages', () => {
    const ctx = createMockContext();
    const messages = [createMockParsedMessage({ rawMessage: 'CQ W1AW FN31' })];

    plugin.hooks!.onDecode!(messages, ctx);

    expect(ctx.log._calls.some(c => c.level === 'debug')).toBe(true);
  });
});
```

## Documentation

For the full plugin system guide, see [docs/plugin-system.md](https://github.com/boybook/tx-5dr/blob/main/docs/plugin-system.md).

## License

MIT
