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
import { definePlugin } from '@tx5dr/plugin-api';

const plugin = definePlugin({
  apiVersion: 2,
  name: 'my-plugin',
  version: '1.0.0',
  type: 'utility',
  permissions: [],
  hooks: {
    onDecode(messages, ctx) {
      for (const msg of messages) {
        ctx.log.debug('Decoded', { raw: msg.rawMessage });
      }
    },
  },
});

export default plugin;
```

### JavaScript (with JSDoc types)

```javascript
import { definePlugin } from '@tx5dr/plugin-api';

export default definePlugin({
  apiVersion: 2,
  name: 'my-plugin',
  version: '1.0.0',
  type: 'utility',
  permissions: [],
  hooks: {
    onDecode(messages, ctx) {
      for (const msg of messages) {
        ctx.log.debug('Decoded', { raw: msg.rawMessage });
      }
    },
  },
});
```

## Exports

| Subpath | Description |
|---------|-------------|
| `@tx5dr/plugin-api` | `definePlugin()`, capability-derived contexts, hooks, structured command ports, and radio/message types |
| `@tx5dr/plugin-api/testing` | Mock factories for unit testing: `createMockContext()`, `createMockSlotInfo()`, `createMockParsedMessage()`, `createMockEventBus()` |
| `@tx5dr/plugin-api/bridge` | Ambient type declarations for the iframe Bridge SDK (`window.tx5dr`) |

## Capability Model

Privileged Host APIs use an allowlist model. A plugin must declare every
capability in `permissions`; the Host then projects only those properties into
that plugin's context. Undeclared properties are absent from both the inferred
TypeScript type and the runtime object. Use `definePlugin()` without manually
widening callbacks to `PluginContext`, otherwise TypeScript cannot preserve the
literal permission tuple.

Capabilities grant structured Host ports, not physical device ownership. The
capability-derived context does not directly expose raw PTT, audio playback,
the mixer, encoder, physical frame lease, arbitrary radio capability writes,
or global emergency stop. Strategy runtimes receive a narrower speculative
context and return declarative decisions; they never receive command ports.

For a strategy plugin, `type: 'strategy'` plus `apiVersion: 2` is the explicit
declaration that it may produce RF decisions when selected by an operator. It
does not need `operator:transmit-control`. That permission is reserved for
utility plugins that need the imperative, Host-coordinated
`ctx.operatorCommands` port.

API v2 is required for strategy plugins and any plugin requesting a mutation
capability. The Host validates and freezes the loaded definition so permissions
cannot be expanded after load.

This is a Host API contract, not a sandbox for hostile Node.js code. Third-party
plugins currently execute in the server process; process isolation is a
separate security boundary.

## Data Ownership and Callback Lifetime

Configuration, hook arguments, query results and messages cross the Host boundary by value. Plugins may modify their local copies, but changes are not persisted until they call an explicit API such as `ctx.updateConfig()`, `store.set()` or a command port. UI/config/KV channels accept JSON-compatible values; hooks, strategy results and EventBus payloads accept structured-clone-compatible values. Functions, cycles, Host handles and other unsupported values are rejected with `PLUGIN_DATA_NOT_SERIALIZABLE`.

Host capabilities such as `ctx.ui`, `ctx.logbook`, radio command ports, network sockets and native `Response` objects are live handles. Use them only before the current Host callback settles. A handle retained past timeout, reload or unload rejects with `PLUGIN_INVOCATION_EXPIRED`; use Host timers and callbacks for later work instead of detached continuations.

## Operator Transmit Control

Utility plugins that need to submit operator commands must declare
`operator:transmit-control` and submit one of the high-level commands accepted
by `ctx.operatorCommands`. The permission grants API access; it does not by
itself classify the plugin as an automatic caller.

Automatic calling plugins implement `isAutoCallEnabled()`. This both gates the
command port and opts the plugin into the operator auto-call indicator and pause
controls:

```ts
const plugin = definePlugin({
  apiVersion: 2,
  name: 'scheduled-caller',
  version: '1.0.0',
  type: 'utility',
  permissions: ['operator:transmit-control'],
  isAutoCallEnabled: (ctx) => ctx.config.enabled === true,
  hooks: {
    async onTimer(_timerId, ctx) {
      await ctx.operatorCommands.submit({
        type: 'request-call',
        callsign: 'W1AW',
      });
    },
  },
});
```

Integrations such as remote-control protocol bridges that may submit occasional
commands but do not autonomously originate calls implement
`isTransmitControlEnabled()` instead. They receive the same guarded command
port but are not shown or paused as auto-call plugins.

The Host allocates an operator command epoch and routes the request through the
operator/frame coordinators. Plugins cannot directly key or unkey the radio.

## Radio Permissions

`ctx.radio` always exposes a small read-only operating snapshot. Additional
radio capabilities require explicit declarations:

```ts
permissions: ['radio:read', 'radio:control', 'radio:tuner-control', 'radio:power']
```

- `radio:read` exposes `ctx.radioCapabilities` and the read-only `ctx.radioPower` view.
- `radio:control` exposes Host-arbitrated `set-frequency` and `switch-band` commands.
- `switch-band` can include `autoTune: true` when `radio:tuner-control` is also declared; the Host keeps the complete operation inside one physical-idle fence.
- `radio:tuner-control` exposes only `set-enabled` and `start-manual-tune` through `ctx.radioTunerCommands`.
- Radio writes reject while Digital, Voice, CW, Tune or manual PTT owns the physical transmitter; they never interrupt that transmission.
- `radio:power` exposes `ctx.radioPowerCommands.submit({ type: 'set-power', state })`.
- `ctx.radio.mode` remains read-only and uses ADIF `MODE`/`SUBMODE` semantics.

These APIs are not exposed directly to iframe pages; custom UI should call a server-side page handler.

## Logbook Permissions

- `logbook:read` exposes only query and worked-status methods on `ctx.logbook`.
- `logbook:write` exposes durable `addQSO()`/`updateQSO()` mutations in addition to reads.
- `logbook:sync` exposes `ctx.logbookSync` for registering a Host-managed sync provider.

Write completion means the Host logbook durability contract has completed.
Logbook APIs never grant PTT or frame lifecycle control.

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
import { definePlugin } from '@tx5dr/plugin-api';

const plugin = definePlugin({
  apiVersion: 2,
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
});

export default plugin;
```

The whitelist intentionally excludes authentication tokens, operator CRUD, hardware radio connection settings, audio devices, rigctld, OpenWebRX, profiles, and server host/port settings. These APIs are not exposed directly to iframe pages; custom UI should call a server-side page handler with `window.tx5dr.invoke()`.

## Plugin Event Bus

Server-side plugins can exchange in-process messages through `ctx.eventBus`, a topic-based pub/sub bus scoped to the host process. Payloads use structured-clone semantics and each subscriber receives an independent value, enabling loose coupling without shared mutable state. Functions, promises, weak collections, and host capability objects cannot be published.

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
  payload: unknown;        // Independent structured-clone value
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
import { definePlugin } from '@tx5dr/plugin-api';

// Publisher plugin
const publisher = definePlugin({
  apiVersion: 2,
  name: 'spot-monitor',
  version: '1.0.0',
  type: 'utility',
  permissions: ['plugin:event-bus'],
  hooks: {
    onDecode(messages, ctx) {
      for (const msg of messages) {
        ctx.eventBus.publish('spot-monitor.new-spot', {
          callsign: msg.callsign,
          frequency: msg.frequencyHz,
        });
      }
    },
  },
});

// Subscriber plugin
const subscriber = definePlugin({
  apiVersion: 2,
  name: 'spot-logger',
  version: '1.0.0',
  type: 'utility',
  permissions: ['plugin:event-bus'],
  hooks: {
    onLoad(ctx) {
      ctx.eventBus.subscribe('spot-monitor.new-spot', (message) => {
        ctx.log.info('received spot', {
          from: message.publisher.pluginName,
          callsign: (message.payload as any).callsign,
        });
      });
    },
  },
});
```

### Cross-Operator Communication

Operator-scoped plugins can communicate across operators on the same host. The `publisher` metadata lets subscribers identify which operator sent the message:

```ts
ctx.eventBus.subscribe('qso-monitor.qso-complete', (message) => {
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
