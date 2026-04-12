#!/usr/bin/env node

/**
 * create-tx5dr-plugin — scaffolds a new TX-5DR plugin project.
 *
 * Usage:
 *   npx create-tx5dr-plugin                              # Interactive
 *   npx create-tx5dr-plugin my-plugin                    # Name only, prompts for rest
 *   npx create-tx5dr-plugin my-plugin --type utility     # Non-interactive
 *   npx create-tx5dr-plugin my-plugin --template ui-react
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// ===== Types =====

type PluginType = 'utility' | 'strategy';
type Language = 'ts' | 'js';
type Template = 'basic' | 'ui-vanilla' | 'ui-react' | 'ui-vue';

const VALID_TEMPLATES: Template[] = ['basic', 'ui-vanilla', 'ui-react', 'ui-vue'];

interface PluginConfig {
  name: string;
  type: PluginType;
  lang: Language;
  template: Template;
}

// ===== CLI argument parsing =====

function parseArgs(): Partial<PluginConfig> {
  const args = process.argv.slice(2);
  const config: Partial<PluginConfig> = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--type' && i + 1 < args.length) {
      const value = args[++i];
      if (value === 'utility' || value === 'strategy') {
        config.type = value;
      }
    } else if (arg === '--lang' && i + 1 < args.length) {
      const value = args[++i];
      if (value === 'ts' || value === 'js') {
        config.lang = value;
      }
    } else if (arg === '--template' && i + 1 < args.length) {
      const value = args[++i] as Template;
      if (VALID_TEMPLATES.includes(value)) {
        config.template = value;
      }
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-') && !config.name) {
      config.name = arg;
    }
    i++;
  }

  return config;
}

function printUsage(): void {
  console.log(`
  create-tx5dr-plugin — Scaffold a new TX-5DR plugin project

  Usage:
    npx create-tx5dr-plugin [name] [options]

  Options:
    --type <utility|strategy>                        Plugin type (default: utility)
    --lang <ts|js>                                   Language (default: ts)
    --template <basic|ui-vanilla|ui-react|ui-vue>    Template (default: basic)
    --help, -h                                       Show this help message

  Templates:
    basic        Server-side plugin only (no UI)
    ui-vanilla   Plugin with vanilla HTML/JS/CSS UI page
    ui-react     Plugin with React + Vite UI page
    ui-vue       Plugin with Vue + Vite UI page

  Examples:
    npx create-tx5dr-plugin my-plugin
    npx create-tx5dr-plugin my-plugin --type strategy
    npx create-tx5dr-plugin my-plugin --template ui-react
    npx create-tx5dr-plugin my-plugin --template ui-vue --type utility
  `);
}

// ===== Interactive prompts =====

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function promptConfig(partial: Partial<PluginConfig>): Promise<PluginConfig> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const name = partial.name || await prompt(rl, 'Plugin name: ');
    if (!name) {
      console.error('Plugin name is required.');
      process.exit(1);
    }

    let type = partial.type;
    if (!type) {
      const answer = await prompt(rl, 'Plugin type (utility/strategy) [utility]: ');
      type = answer === 'strategy' ? 'strategy' : 'utility';
    }

    let lang = partial.lang;
    if (!lang) {
      const answer = await prompt(rl, 'Language (ts/js) [ts]: ');
      lang = answer === 'js' ? 'js' : 'ts';
    }

    let template = partial.template;
    if (!template) {
      const answer = await prompt(rl, 'Template (basic/ui-vanilla/ui-react/ui-vue) [basic]: ');
      template = VALID_TEMPLATES.includes(answer as Template) ? answer as Template : 'basic';
    }

    return { name, type, lang, template };
  } finally {
    rl.close();
  }
}

// ===== Helpers =====

function hasUI(config: PluginConfig): boolean {
  return config.template !== 'basic';
}

function hasVite(config: PluginConfig): boolean {
  return config.template === 'ui-react' || config.template === 'ui-vue';
}

// ===== Core template generation =====

function generatePackageJson(config: PluginConfig): string {
  const devDeps: Record<string, string> = {
    '@tx5dr/plugin-api': 'latest',
  };

  if (config.lang === 'ts') {
    devDeps['typescript'] = '^5.0.0';
    devDeps['vitest'] = '^1.0.0';
  }

  if (hasVite(config)) {
    devDeps['vite'] = '^6.0.0';
    if (config.template === 'ui-react') {
      devDeps['react'] = '^19.0.0';
      devDeps['react-dom'] = '^19.0.0';
      devDeps['@vitejs/plugin-react'] = '^4.0.0';
      devDeps['@types/react'] = '^19.0.0';
      devDeps['@types/react-dom'] = '^19.0.0';
    } else if (config.template === 'ui-vue') {
      devDeps['vue'] = '^3.5.0';
      devDeps['@vitejs/plugin-vue'] = '^5.0.0';
    }
  }

  const scripts: Record<string, string> = {};
  if (config.lang === 'ts') {
    if (hasVite(config)) {
      scripts['build'] = 'tsc && npm run build:ui';
      scripts['build:ui'] = 'vite build --config ui/vite.config.ts';
      scripts['dev:server'] = 'tsc --watch';
      scripts['dev:ui'] = 'vite build --watch --config ui/vite.config.ts';
    } else {
      scripts['build'] = 'tsc';
      scripts['dev'] = 'tsc --watch';
    }
    scripts['test'] = 'vitest run';
    scripts['link'] = 'node scripts/link.mjs';
  }

  const pkg: Record<string, unknown> = {
    name: config.name,
    version: '0.1.0',
    type: 'module',
    ...(config.lang === 'ts'
      ? { main: 'dist/index.js', types: 'dist/index.d.ts' }
      : { main: 'index.js' }),
    scripts,
    devDependencies: devDeps,
  };

  return JSON.stringify(pkg, null, 2) + '\n';
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2021',
      module: 'ESNext',
      moduleResolution: 'bundler',
      outDir: 'dist',
      rootDir: 'src',
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src'],
  }, null, 2) + '\n';
}

function generateGitignore(): string {
  return `node_modules/
dist/
*.tsbuildinfo
`;
}

function generateLocaleZh(config: PluginConfig): string {
  return JSON.stringify({
    pluginDescription: `${config.name} plugin`,
  }, null, 2) + '\n';
}

function generateLocaleEn(config: PluginConfig): string {
  return JSON.stringify({
    pluginDescription: `${config.name} plugin`,
  }, null, 2) + '\n';
}

// ===== Server-side plugin definition templates =====

function generateTsUtilityPlugin(config: PluginConfig): string {
  return `import type {
  PluginDefinition,
  PluginContext,
  ParsedFT8Message,
  SlotInfo,
} from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

export const plugin: PluginDefinition = {
  name: '${config.name}',
  version: '0.1.0',
  type: 'utility',
  description: 'pluginDescription',

  settings: {
    // Define your plugin settings here
    // enabled: {
    //   type: 'boolean',
    //   default: true,
    //   label: 'enabled',
    //   description: 'enabledDesc',
    //   scope: 'operator',
    // },
  },

  hooks: {
    onSlotStart(slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContext): void {
      ctx.log.debug('Slot started', { slotId: slotInfo.id, messageCount: messages.length });
    },

    onDecode(messages: ParsedFT8Message[], ctx: PluginContext): void {
      // Process decoded messages
      for (const msg of messages) {
        ctx.log.debug('Decoded message', { raw: msg.rawMessage, snr: msg.snr });
      }
    },
  },
};

export const locales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};

export default plugin;
`;
}

function generateTsStrategyPlugin(config: PluginConfig): string {
  return `import type {
  PluginDefinition,
  PluginContext,
  StrategyRuntime,
  StrategyRuntimeSnapshot,
  StrategyRuntimeSlot,
  StrategyRuntimeSlotContentUpdate,
  StrategyRuntimeContext,
  ParsedFT8Message,
  StrategyDecision,
  StrategyDecisionMeta,
  FrameMessage,
  SlotInfo,
} from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

class PluginRuntime implements StrategyRuntime {
  private state: StrategyRuntimeSlot = 'TX6';
  private slots: Partial<Record<StrategyRuntimeSlot, string>> = {};
  private context: StrategyRuntimeContext = {};

  constructor(private ctx: PluginContext) {}

  decide(messages: ParsedFT8Message[], meta?: StrategyDecisionMeta): StrategyDecision {
    // Implement your QSO strategy logic here
    return {};
  }

  getTransmitText(): string | null {
    return this.slots[this.state] ?? null;
  }

  requestCall(callsign: string, lastMessage?: { message: FrameMessage; slotInfo: SlotInfo }): void {
    this.context.targetCallsign = callsign;
    this.state = 'TX1';
    this.ctx.log.info('Call requested', { callsign });
  }

  getSnapshot(): StrategyRuntimeSnapshot {
    return {
      currentState: this.state,
      slots: { ...this.slots },
      context: { ...this.context },
      availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6'],
    };
  }

  patchContext(patch: Partial<StrategyRuntimeContext>): void {
    Object.assign(this.context, patch);
  }

  setState(state: StrategyRuntimeSlot): void {
    this.state = state;
  }

  setSlotContent(update: StrategyRuntimeSlotContentUpdate): void {
    this.slots[update.slot] = update.content;
  }

  reset(reason?: string): void {
    this.state = 'TX6';
    this.slots = {};
    this.context = {};
    this.ctx.log.info('Strategy reset', { reason });
  }
}

export const plugin: PluginDefinition = {
  name: '${config.name}',
  version: '0.1.0',
  type: 'strategy',
  description: 'pluginDescription',

  settings: {},

  createStrategyRuntime(ctx: PluginContext): StrategyRuntime {
    return new PluginRuntime(ctx);
  },

  hooks: {
    onSlotStart(slotInfo, messages, ctx): void {
      ctx.log.debug('Slot started', { slotId: slotInfo.id });
    },
  },
};

export const locales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};

export default plugin;
`;
}

function generateTsUtilityPluginWithUI(config: PluginConfig): string {
  return `import type {
  PluginDefinition,
  PluginContext,
  ParsedFT8Message,
  SlotInfo,
} from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

export const plugin: PluginDefinition = {
  name: '${config.name}',
  version: '0.1.0',
  type: 'utility',
  description: 'pluginDescription',

  settings: {
    // Define your plugin settings here
  },

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'settings',
        entry: 'settings.html',
        title: 'settingsPage',
        accessScope: 'admin',
      },
    ],
  },

  onLoad(ctx: PluginContext): void {
    ctx.ui.registerPageHandler({
      async onMessage(pageId, action, data) {
        if (action === 'getSettings') {
          return {
            message: ctx.store.global.get<string>('message', ''),
          };
        }
        if (action === 'saveSettings') {
          const { message } = data as { message: string };
          ctx.store.global.set('message', message);
          ctx.log.info('Settings saved', { message });
          return { ok: true };
        }
        return null;
      },
    });
  },

  hooks: {
    onSlotStart(slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContext): void {
      ctx.log.debug('Slot started', { slotId: slotInfo.id, messageCount: messages.length });
    },

    onDecode(messages: ParsedFT8Message[], ctx: PluginContext): void {
      for (const msg of messages) {
        ctx.log.debug('Decoded message', { raw: msg.rawMessage, snr: msg.snr });
      }
    },
  },
};

export const locales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};

export default plugin;
`;
}

function generateJsUtilityPlugin(config: PluginConfig): string {
  return `/** @type {import('@tx5dr/plugin-api').PluginDefinition} */
export const plugin = {
  name: '${config.name}',
  version: '0.1.0',
  type: 'utility',
  description: 'pluginDescription',

  settings: {
    // Define your plugin settings here
  },

  hooks: {
    onSlotStart(slotInfo, messages, ctx) {
      ctx.log.debug('Slot started', { slotId: slotInfo.id, messageCount: messages.length });
    },

    onDecode(messages, ctx) {
      for (const msg of messages) {
        ctx.log.debug('Decoded message', { raw: msg.rawMessage, snr: msg.snr });
      }
    },
  },
};

export default plugin;
`;
}

function generateJsUtilityPluginWithUI(config: PluginConfig): string {
  return `/** @type {import('@tx5dr/plugin-api').PluginDefinition} */
export const plugin = {
  name: '${config.name}',
  version: '0.1.0',
  type: 'utility',
  description: 'pluginDescription',

  settings: {},

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'settings',
        entry: 'settings.html',
        title: 'settingsPage',
        accessScope: 'admin',
      },
    ],
  },

  onLoad(ctx) {
    ctx.ui.registerPageHandler({
      async onMessage(pageId, action, data) {
        if (action === 'getSettings') {
          return {
            message: ctx.store.global.get('message', ''),
          };
        }
        if (action === 'saveSettings') {
          ctx.store.global.set('message', data.message);
          ctx.log.info('Settings saved', { message: data.message });
          return { ok: true };
        }
        return null;
      },
    });
  },

  hooks: {
    onSlotStart(slotInfo, messages, ctx) {
      ctx.log.debug('Slot started', { slotId: slotInfo.id, messageCount: messages.length });
    },

    onDecode(messages, ctx) {
      for (const msg of messages) {
        ctx.log.debug('Decoded message', { raw: msg.rawMessage, snr: msg.snr });
      }
    },
  },
};

export default plugin;
`;
}

// ===== Test templates =====

function generateTsTest(config: PluginConfig): string {
  if (config.type === 'strategy') {
    return `import { describe, it, expect } from 'vitest';
import { createMockContext, createMockSlotInfo, createMockParsedMessage } from '@tx5dr/plugin-api/testing';
import { plugin } from '../index.js';

describe('${config.name}', () => {
  it('creates a strategy runtime', () => {
    const ctx = createMockContext();
    const runtime = plugin.createStrategyRuntime!(ctx);
    expect(runtime).toBeDefined();
  });

  it('starts in TX6 idle state', () => {
    const ctx = createMockContext();
    const runtime = plugin.createStrategyRuntime!(ctx);
    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX6');
  });

  it('transitions to TX1 on requestCall', () => {
    const ctx = createMockContext();
    const runtime = plugin.createStrategyRuntime!(ctx);
    runtime.requestCall('W1AW');
    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX1');
    expect(snapshot.context?.targetCallsign).toBe('W1AW');
  });

  it('resets to idle state', () => {
    const ctx = createMockContext();
    const runtime = plugin.createStrategyRuntime!(ctx);
    runtime.requestCall('W1AW');
    runtime.reset('test');
    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX6');
    expect(snapshot.context?.targetCallsign).toBeUndefined();
  });
});
`;
  }

  return `import { describe, it, expect } from 'vitest';
import { createMockContext, createMockSlotInfo, createMockParsedMessage } from '@tx5dr/plugin-api/testing';
import { plugin } from '../index.js';

describe('${config.name}', () => {
  it('has correct metadata', () => {
    expect(plugin.name).toBe('${config.name}');
    expect(plugin.type).toBe('utility');
  });

  it('onSlotStart logs message count', () => {
    const ctx = createMockContext();
    const slotInfo = createMockSlotInfo();
    const messages = [createMockParsedMessage()];

    plugin.hooks!.onSlotStart!(slotInfo, messages, ctx);
    expect(ctx.log._calls.some(c => c.level === 'debug')).toBe(true);
  });

  it('onDecode processes each message', () => {
    const ctx = createMockContext();
    const messages = [
      createMockParsedMessage({ rawMessage: 'CQ W1AW FN31' }),
      createMockParsedMessage({ rawMessage: 'CQ JA1ABC PM95' }),
    ];

    plugin.hooks!.onDecode!(messages, ctx);
    const debugCalls = ctx.log._calls.filter(c => c.level === 'debug');
    expect(debugCalls.length).toBeGreaterThanOrEqual(2);
  });
});
`;
}

// ===== Vanilla UI templates =====

function generateVanillaUIHtml(config: PluginConfig): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="settings.css">
</head>
<body>
  <div class="container">
    <h2 class="title">${config.name} Settings</h2>

    <div class="section">
      <label class="label">Message</label>
      <input type="text" class="input" id="messageInput" placeholder="Enter a message">
    </div>

    <div class="section">
      <button class="btn btn-primary" id="saveBtn">Save</button>
      <span class="status" id="status"></span>
    </div>

    <div class="section">
      <p class="text-secondary" id="currentValue"></p>
    </div>
  </div>
  <script src="settings.js"></script>
</body>
</html>
`;
}

function generateVanillaUIJs(): string {
  return `/// <reference types="@tx5dr/plugin-api/bridge" />
(function () {
  'use strict';

  var bridge = window.tx5dr;
  var messageInput = document.getElementById('messageInput');
  var saveBtn = document.getElementById('saveBtn');
  var status = document.getElementById('status');
  var currentValue = document.getElementById('currentValue');

  // Load saved value on page open
  bridge.invoke('getSettings').then(function (settings) {
    if (settings && settings.message) {
      messageInput.value = settings.message;
      currentValue.textContent = 'Current: ' + settings.message;
    }
  }).catch(function () {
    // Use defaults
  });

  // Save button handler
  saveBtn.addEventListener('click', function () {
    var message = messageInput.value.trim();
    if (!message) return;

    saveBtn.disabled = true;
    status.textContent = 'Saving...';

    bridge.invoke('saveSettings', { message: message }).then(function () {
      status.textContent = 'Saved!';
      currentValue.textContent = 'Current: ' + message;
      setTimeout(function () { status.textContent = ''; }, 2000);
    }).catch(function (err) {
      status.textContent = 'Error: ' + err.message;
    }).finally(function () {
      saveBtn.disabled = false;
    });
  });

  // Listen for server push updates
  bridge.onPush('settingsUpdated', function (data) {
    if (data && data.message) {
      messageInput.value = data.message;
      currentValue.textContent = 'Current: ' + data.message;
    }
  });

  // Auto-resize iframe
  var resizeObserver = new ResizeObserver(function () {
    var h = document.body.scrollHeight;
    if (h > 0) bridge.resize(h);
  });
  resizeObserver.observe(document.body);
  bridge.resize(document.body.scrollHeight);
})();
`;
}

function generateUICss(): string {
  return `/* Plugin UI styles — using TX-5DR Design Tokens */
.container {
  padding: var(--tx5dr-spacing-lg);
  font-family: var(--tx5dr-font);
  color: var(--tx5dr-text);
}

.title {
  font-size: var(--tx5dr-font-size-lg);
  font-weight: 600;
  margin-bottom: var(--tx5dr-spacing-lg);
}

.section {
  margin-bottom: var(--tx5dr-spacing-md);
  display: flex;
  align-items: center;
  gap: var(--tx5dr-spacing-sm);
}

.label {
  font-size: var(--tx5dr-font-size-sm);
  color: var(--tx5dr-text-secondary);
  min-width: 70px;
}

.input {
  flex: 1;
  padding: var(--tx5dr-spacing-sm) var(--tx5dr-spacing-md);
  background: var(--tx5dr-bg-content);
  border: 1px solid var(--tx5dr-border);
  border-radius: var(--tx5dr-radius-sm);
  color: var(--tx5dr-text);
  font-size: var(--tx5dr-font-size-md);
  font-family: var(--tx5dr-font);
  outline: none;
  transition: border-color 0.2s;
}

.input:focus {
  border-color: var(--tx5dr-primary);
  box-shadow: 0 0 0 2px var(--tx5dr-focus-ring);
}

.btn {
  padding: var(--tx5dr-spacing-sm) var(--tx5dr-spacing-lg);
  border: 1px solid var(--tx5dr-border);
  border-radius: var(--tx5dr-radius-sm);
  background: var(--tx5dr-bg-content);
  color: var(--tx5dr-text);
  font-size: var(--tx5dr-font-size-sm);
  font-family: var(--tx5dr-font);
  cursor: pointer;
  transition: background 0.15s;
}

.btn:hover {
  background: var(--tx5dr-bg-hover);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--tx5dr-primary);
  border-color: var(--tx5dr-primary);
  color: #fff;
}

.btn-primary:hover {
  background: var(--tx5dr-primary-hover);
}

.status {
  font-size: var(--tx5dr-font-size-sm);
  color: var(--tx5dr-text-secondary);
}

.text-secondary {
  font-size: var(--tx5dr-font-size-sm);
  color: var(--tx5dr-text-secondary);
}
`;
}

function generateVanillaJsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      types: ['@tx5dr/plugin-api/bridge'],
    },
  }, null, 2) + '\n';
}

// ===== Vite-based UI templates (React / Vue) =====

function generateViteConfig(config: PluginConfig): string {
  const pluginImport = config.template === 'ui-react'
    ? "import react from '@vitejs/plugin-react';"
    : "import vue from '@vitejs/plugin-vue';";
  const pluginUsage = config.template === 'ui-react' ? 'react()' : 'vue()';

  return `import { defineConfig } from 'vite';
${pluginImport}
import { resolve } from 'path';

export default defineConfig({
  plugins: [${pluginUsage}],
  root: import.meta.dirname,
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        settings: resolve(import.meta.dirname, 'settings.html'),
        // Add more entries here for multi-page plugins:
        // dashboard: resolve(import.meta.dirname, 'dashboard.html'),
      },
    },
  },
});
`;
}

function generateUITsConfig(config: PluginConfig): string {
  const jsx = config.template === 'ui-react' ? { jsx: 'react-jsx' as const } : {};
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2021',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ['@tx5dr/plugin-api/bridge'],
      ...jsx,
    },
    include: ['src'],
  }, null, 2) + '\n';
}

function generateFrameworkEntryHtml(config: PluginConfig): string {
  const ext = config.template === 'ui-react' ? 'tsx' : 'ts';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./src/main.${ext}"></script>
</body>
</html>
`;
}

function generateReactMain(): string {
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = createRoot(document.getElementById('app')!);
root.render(<App />);

// Auto-resize iframe to fit content
const observer = new ResizeObserver(() => {
  const h = document.body.scrollHeight;
  if (h > 0) tx5dr.resize(h);
});
observer.observe(document.body);
`;
}

function generateReactApp(config: PluginConfig): string {
  return `import React, { useCallback, useEffect, useState } from 'react';
import './App.css';

export function App() {
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    tx5dr.invoke('getSettings').then((settings: any) => {
      if (settings?.message) {
        setMessage(settings.message);
        setSaved(settings.message);
      }
    });

    // Listen for push updates from the server
    const handleUpdate = (data: any) => {
      if (data?.message) {
        setMessage(data.message);
        setSaved(data.message);
      }
    };
    tx5dr.onPush('settingsUpdated', handleUpdate);
    return () => tx5dr.offPush('settingsUpdated', handleUpdate);
  }, []);

  const handleSave = useCallback(async () => {
    if (!message.trim()) return;
    setStatus('Saving...');
    try {
      await tx5dr.invoke('saveSettings', { message });
      setSaved(message);
      setStatus('Saved!');
      setTimeout(() => setStatus(''), 2000);
    } catch (err: any) {
      setStatus('Error: ' + err.message);
    }
  }, [message]);

  return (
    <div className="container">
      <h2 className="title">${config.name} Settings</h2>

      <div className="section">
        <label className="label">Message</label>
        <input
          className="input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Enter a message"
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        />
      </div>

      <div className="section">
        <button className="btn btn-primary" onClick={handleSave}>
          Save
        </button>
        {status && <span className="status">{status}</span>}
      </div>

      {saved && (
        <div className="section">
          <p className="text-secondary">Current: {saved}</p>
        </div>
      )}
    </div>
  );
}
`;
}

function generateVueMain(): string {
  return `import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');

// Auto-resize iframe to fit content
const observer = new ResizeObserver(() => {
  const h = document.body.scrollHeight;
  if (h > 0) tx5dr.resize(h);
});
observer.observe(document.body);
`;
}

function generateVueApp(config: PluginConfig): string {
  return `<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import './App.css';

const message = ref('');
const saved = ref('');
const status = ref('');

onMounted(async () => {
  const settings = await tx5dr.invoke('getSettings') as any;
  if (settings?.message) {
    message.value = settings.message;
    saved.value = settings.message;
  }

  tx5dr.onPush('settingsUpdated', handleUpdate);
});

onUnmounted(() => {
  tx5dr.offPush('settingsUpdated', handleUpdate);
});

function handleUpdate(data: any) {
  if (data?.message) {
    message.value = data.message;
    saved.value = data.message;
  }
}

async function handleSave() {
  if (!message.value.trim()) return;
  status.value = 'Saving...';
  try {
    await tx5dr.invoke('saveSettings', { message: message.value });
    saved.value = message.value;
    status.value = 'Saved!';
    setTimeout(() => { status.value = ''; }, 2000);
  } catch (err: any) {
    status.value = 'Error: ' + err.message;
  }
}
</script>

<template>
  <div class="container">
    <h2 class="title">${config.name} Settings</h2>

    <div class="section">
      <label class="label">Message</label>
      <input
        class="input"
        v-model="message"
        placeholder="Enter a message"
        @keydown.enter="handleSave"
      />
    </div>

    <div class="section">
      <button class="btn btn-primary" @click="handleSave">Save</button>
      <span v-if="status" class="status">{{ status }}</span>
    </div>

    <div v-if="saved" class="section">
      <p class="text-secondary">Current: {{ saved }}</p>
    </div>
  </div>
</template>
`;
}

// ===== Link script =====

function generateLinkScript(pluginName: string): string {
  return `#!/usr/bin/env node
// Symlink this plugin's dist/ to the TX-5DR plugins directory.
// Usage:  node scripts/link.mjs           (create link)
//         node scripts/link.mjs --unlink  (remove link)

import { symlinkSync, unlinkSync, existsSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';

const PLUGIN_NAME = '${pluginName}';

function getDataDir() {
  if (process.env.TX5DR_DATA_DIR) return process.env.TX5DR_DATA_DIR;
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'TX-5DR');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'TX-5DR');
    default:
      return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'TX-5DR');
  }
}

const unlink = process.argv.includes('--unlink');
const pluginsDir = join(getDataDir(), 'plugins');
const target = resolve('dist');
const linkPath = join(pluginsDir, PLUGIN_NAME);

if (unlink) {
  if (existsSync(linkPath)) {
    unlinkSync(linkPath);
    console.log('Unlinked: ' + linkPath);
  } else {
    console.log('No link found at: ' + linkPath);
  }
  process.exit(0);
}

if (!existsSync(target)) {
  console.error('Error: dist/ not found. Run "npm run build" first.');
  process.exit(1);
}

if (existsSync(linkPath)) {
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      console.log('Already linked: ' + linkPath + ' -> ' + target);
      process.exit(0);
    }
  } catch { /* continue */ }
  console.error('Error: ' + linkPath + ' already exists and is not a symlink.');
  process.exit(1);
}

mkdirSync(pluginsDir, { recursive: true });
symlinkSync(target, linkPath, 'junction');

// Create .hotreload marker so the TX-5DR dev server auto-reloads on changes.
const hotreloadPath = join(target, '.hotreload');
if (!existsSync(hotreloadPath)) {
  writeFileSync(hotreloadPath, '', 'utf-8');
}

console.log('Linked: ' + linkPath + ' -> ' + target);
console.log('Created .hotreload marker for dev auto-reload.');
`;
}

// ===== File generation =====

function generateFiles(config: PluginConfig): Map<string, string> {
  const files = new Map<string, string>();

  files.set('package.json', generatePackageJson(config));
  files.set('.gitignore', generateGitignore());

  if (config.lang === 'ts') {
    files.set('tsconfig.json', generateTsConfig());

    if (config.type === 'strategy') {
      files.set('src/index.ts', generateTsStrategyPlugin(config));
    } else if (hasUI(config)) {
      files.set('src/index.ts', generateTsUtilityPluginWithUI(config));
    } else {
      files.set('src/index.ts', generateTsUtilityPlugin(config));
    }

    files.set('src/locales/zh.json', generateLocaleZh(config));
    files.set('src/locales/en.json', generateLocaleEn(config));
    files.set('src/__tests__/plugin.test.ts', generateTsTest(config));
  } else {
    if (hasUI(config)) {
      files.set('index.js', generateJsUtilityPluginWithUI(config));
    } else {
      files.set('index.js', generateJsUtilityPlugin(config));
    }
  }

  // Vanilla UI template
  if (config.template === 'ui-vanilla') {
    files.set('ui/jsconfig.json', generateVanillaJsConfig());
    files.set('ui/settings.html', generateVanillaUIHtml(config));
    files.set('ui/settings.css', generateUICss());
    files.set('ui/settings.js', generateVanillaUIJs());
  }

  // React UI template
  if (config.template === 'ui-react') {
    files.set('ui/vite.config.ts', generateViteConfig(config));
    files.set('ui/tsconfig.json', generateUITsConfig(config));
    files.set('ui/settings.html', generateFrameworkEntryHtml(config));
    files.set('ui/src/main.tsx', generateReactMain());
    files.set('ui/src/App.tsx', generateReactApp(config));
    files.set('ui/src/App.css', generateUICss());
  }

  // Vue UI template
  if (config.template === 'ui-vue') {
    files.set('ui/vite.config.ts', generateViteConfig(config));
    files.set('ui/tsconfig.json', generateUITsConfig(config));
    files.set('ui/settings.html', generateFrameworkEntryHtml(config));
    files.set('ui/src/main.ts', generateVueMain());
    files.set('ui/src/App.vue', generateVueApp(config));
    files.set('ui/src/App.css', generateUICss());
  }

  // Link script for all templates with TS
  if (config.lang === 'ts') {
    files.set('scripts/link.mjs', generateLinkScript(config.name));
  }

  return files;
}

function writeFiles(dir: string, files: Map<string, string>): void {
  for (const [relativePath, content] of files) {
    const fullPath = join(dir, relativePath);
    const parentDir = join(fullPath, '..');
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }
}

// ===== Main =====

async function main(): Promise<void> {
  const partial = parseArgs();
  const config = await promptConfig(partial);

  const targetDir = resolve(process.cwd(), config.name);

  console.log();
  console.log(`Creating TX-5DR plugin: ${config.name}`);
  console.log(`  Type: ${config.type}`);
  console.log(`  Language: ${config.lang === 'ts' ? 'TypeScript' : 'JavaScript'}`);
  console.log(`  Template: ${config.template}`);
  console.log(`  Directory: ${targetDir}`);
  console.log();

  const files = generateFiles(config);
  mkdirSync(targetDir, { recursive: true });
  writeFiles(targetDir, files);

  console.log('Generated files:');
  for (const path of files.keys()) {
    console.log(`  ${path}`);
  }

  console.log();
  console.log('Next steps:');
  console.log(`  cd ${config.name}`);
  console.log('  npm install');
  if (config.lang === 'ts') {
    console.log('  npm run build');
    console.log('  npm test');
  }
  console.log();
  if (config.lang === 'ts') {
    console.log('Link to TX-5DR for development:');
    console.log('  npm run link');
    console.log();
  }
  if (hasVite(config)) {
    console.log('UI development (run in two terminals):');
    console.log('  npm run dev:server    # Watch server-side TypeScript');
    console.log('  npm run dev:ui        # Watch UI with Vite');
  } else if (hasUI(config)) {
    console.log('UI files are in the ui/ directory.');
    console.log('Edit HTML/JS/CSS directly — the Bridge SDK is auto-injected by the host.');
  }
  if (hasUI(config) || hasVite(config)) {
    console.log();
    console.log('Docs: https://github.com/boybook/tx-5dr/blob/main/docs/plugin-system.md');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
