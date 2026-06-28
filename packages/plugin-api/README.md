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
| `@tx5dr/plugin-api/testing` | Mock factories for unit testing: `createMockContext()`, `createMockSlotInfo()`, `createMockParsedMessage()`, `createMockEventBus()` |
| `@tx5dr/plugin-api/bridge` | Ambient type declarations for the iframe Bridge SDK (`window.tx5dr`) |

## Radio Permissions

Server-side plugins can use `ctx.radio` to inspect negotiated radio capabilities and, when explicitly permitted, control radio capabilities or physical power:

```ts
permissions: ['radio:read', 'radio:control', 'radio:power']
```

- `radio:read` enables `ctx.radio.capabilities.getSnapshot()` and `ctx.radio.power.getSupport()`.
- `radio:control` enables `ctx.radio.setFrequency()` and `ctx.radio.capabilities.write()`.
- `radio:power` enables `ctx.radio.power.set('on' | 'off' | 'standby' | 'operate')`.
- `ctx.radio.mode` is always readable and exposes the current best-known operating mode using ADIF `MODE`/`SUBMODE` semantics, for example `SSB` + `USB` in voice USB.

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

## Plugin Event Bus

Server-side plugins can exchange in-process messages through `ctx.eventBus`, a topic-based pub/sub bus scoped to the host process. This enables loose coupling between plugins without shared state.

### Permission

Declare `plugin:event-bus` in the manifest to enable the bus:

```ts
permissions: ['plugin:event-bus']
```

`ctx.eventBus` is optional and should be feature-detected before use.

### API Summary

| Method | Description |
|--------|-------------|
| `publish(topic, payload?)` | Fire-and-forget message to all current subscribers of the exact topic. |
| `subscribe(topic, handler)` | Registers a handler; returns an unsubscribe function. |

Every message received by a subscriber is a `PluginEventBusMessage`:

```ts
interface PluginEventBusMessage {
  topic: string;           // The topic this message was published to
  payload: unknown;        // Arbitrary data set by the publisher
  timestamp: number;       // Epoch ms when the host dispatched the message
  publisher: {
    pluginName: string;    // Publishing plugin's name
    instanceScope: 'operator' | 'global';
    operatorId?: string;   // Present when the publisher is operator-scoped
  };
}
```

### Topic Naming Convention

Use dot-separated, plugin-prefixed names to avoid collisions between plugins:

```
<plugin-name>.<domain>.<event>
```

Examples:
- `psk-reporter.spot.sent` — a spot was uploaded to PSK Reporter
- `callsign-filter.match.found` — a callsign matched a filter rule
- `logbook-sync.upload.complete` — a logbook sync finished

Avoid generic names like `update` or `message` — they will collide.

### Basic Usage

```ts
import type { PluginDefinition } from '@tx5dr/plugin-api';

// Publisher plugin
const publisher: PluginDefinition = {
  name: 'spot-monitor',
  version: '1.0.0',
  type: 'utility',
  permissions: ['plugin:event-bus'],
  hooks: {
    onDecode(messages, ctx) {
      for (const msg of messages) {
        ctx.eventBus?.publish('spot-monitor.new-spot', {
          callsign: msg.callsign,
          frequency: msg.frequencyHz,
        });
      }
    },
  },
};

// Subscriber plugin
const subscriber: PluginDefinition = {
  name: 'spot-logger',
  version: '1.0.0',
  type: 'utility',
  permissions: ['plugin:event-bus'],
  hooks: {
    onLoad(ctx) {
      ctx.eventBus?.subscribe('spot-monitor.new-spot', (message) => {
        ctx.log.info('received spot', {
          from: message.publisher.pluginName,
          callsign: (message.payload as any).callsign,
        });
      });
    },
  },
};
```

### Cross-Operator Communication

Operator-scoped plugins can communicate across operators on the same host. The `publisher` metadata lets subscribers identify which operator sent the message:

```ts
ctx.eventBus?.subscribe('qso-monitor.qso-complete', (message) => {
  const { callsign, band } = message.payload as any;
  ctx.log.info('QSO completed by another operator', {
    operator: message.publisher.operatorId,
    callsign,
    band,
  });
});
```

### Lifecycle and Error Handling

- **Auto-cleanup**: the host removes all subscriptions when a plugin instance unloads. No manual cleanup required.
- **Manual unsubscribe**: call the function returned by `subscribe()` to cancel a single subscription early.
- **Error isolation**: subscriber exceptions (sync or async) are captured and logged by the host. They never propagate back to the publisher.
- **Delivery order**: subscribers receive messages in registration order. Async handlers are awaited, but the publisher does not wait for completion.

### Testing

Use `createMockEventBus()` from `@tx5dr/plugin-api/testing` to test plugin event bus logic in isolation:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createMockEventBus } from '@tx5dr/plugin-api/testing';

it('publishes spot data', () => {
  const bus = createMockEventBus({ owner: { pluginName: 'spot-monitor' } });
  const handler = vi.fn();

  bus.subscribe('spot-monitor.new-spot', handler);
  bus.publish('spot-monitor.new-spot', { callsign: 'W1AW', frequency: 14074000 });

  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({
    topic: 'spot-monitor.new-spot',
    payload: { callsign: 'W1AW', frequency: 14074000 },
    publisher: expect.objectContaining({ pluginName: 'spot-monitor' }),
  }));
});

it('tracks published messages', () => {
  const bus = createMockEventBus();

  bus.publish('topic-a', { value: 1 });
  bus.publish('topic-b', { value: 2 });

  expect(bus._published).toHaveLength(2);
  expect(bus._published[0].topic).toBe('topic-a');
});

it('unsubscribe prevents further delivery', () => {
  const bus = createMockEventBus();
  const handler = vi.fn();

  const unsub = bus.subscribe('topic', handler);
  bus.publish('topic', 'first');
  unsub();
  bus.publish('topic', 'second');

  expect(handler).toHaveBeenCalledTimes(1);
});
```

The mock records all published messages in `_published` and exposes the internal `_subscriptions` map for advanced inspection.

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
