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
