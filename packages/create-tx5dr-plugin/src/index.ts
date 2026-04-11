#!/usr/bin/env node

/**
 * create-tx5dr-plugin — scaffolds a new TX-5DR plugin project.
 *
 * Usage:
 *   npx create-tx5dr-plugin                              # Interactive
 *   npx create-tx5dr-plugin my-plugin                    # Name only, prompts for rest
 *   npx create-tx5dr-plugin my-plugin --type utility     # Non-interactive
 *   npx create-tx5dr-plugin my-plugin --type strategy --lang js
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// ===== Types =====

type PluginType = 'utility' | 'strategy';
type Language = 'ts' | 'js';

interface PluginConfig {
  name: string;
  type: PluginType;
  lang: Language;
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
    --type <utility|strategy>   Plugin type (default: utility)
    --lang <ts|js>              Language (default: ts)
    --help, -h                  Show this help message

  Examples:
    npx create-tx5dr-plugin my-cool-plugin
    npx create-tx5dr-plugin my-cool-plugin --type strategy
    npx create-tx5dr-plugin my-cool-plugin --type utility --lang js
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

    return { name, type, lang };
  } finally {
    rl.close();
  }
}

// ===== Template generation =====

function generatePackageJson(config: PluginConfig): string {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {
    '@tx5dr/plugin-api': 'latest',
  };

  if (config.lang === 'ts') {
    devDeps['typescript'] = '^5.0.0';
    devDeps['vitest'] = '^1.0.0';
    devDeps['@tx5dr/plugin-api'] = 'latest';
  }

  const scripts: Record<string, string> = {};
  if (config.lang === 'ts') {
    scripts['build'] = 'tsc';
    scripts['dev'] = 'tsc --watch';
    scripts['test'] = 'vitest run';
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

  if (Object.keys(deps).length > 0) {
    pkg.dependencies = deps;
  }

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

// ===== File generation =====

function generateFiles(config: PluginConfig): Map<string, string> {
  const files = new Map<string, string>();

  files.set('package.json', generatePackageJson(config));
  files.set('.gitignore', generateGitignore());

  if (config.lang === 'ts') {
    files.set('tsconfig.json', generateTsConfig());

    if (config.type === 'strategy') {
      files.set('src/index.ts', generateTsStrategyPlugin(config));
    } else {
      files.set('src/index.ts', generateTsUtilityPlugin(config));
    }

    files.set('src/locales/zh.json', generateLocaleZh(config));
    files.set('src/locales/en.json', generateLocaleEn(config));
    files.set('src/__tests__/plugin.test.ts', generateTsTest(config));
  } else {
    files.set('index.js', generateJsUtilityPlugin(config));
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
  console.log('Then copy the built plugin into your TX-5DR data/plugins/ directory.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
