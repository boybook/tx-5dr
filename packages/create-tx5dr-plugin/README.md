# create-tx5dr-plugin

Scaffold a new [TX-5DR](https://github.com/boybook/tx-5dr) plugin project.

## Usage

```bash
npx create-tx5dr-plugin [name] [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--type <utility\|strategy>` | Plugin type | `utility` |
| `--lang <ts\|js>` | Language | `ts` |
| `--template <basic\|ui-vanilla\|ui-react\|ui-vue>` | Project template | `basic` |
| `--help, -h` | Show help | |

### Templates

| Template | Description |
|----------|-------------|
| `basic` | Server-side plugin only (no UI) |
| `ui-vanilla` | Plugin with vanilla HTML/JS/CSS UI page |
| `ui-react` | Plugin with React + Vite UI page |
| `ui-vue` | Plugin with Vue + Vite UI page |

### Examples

```bash
# Interactive mode (prompts for all options)
npx create-tx5dr-plugin

# Basic utility plugin
npx create-tx5dr-plugin my-plugin

# Strategy plugin
npx create-tx5dr-plugin my-strategy --type strategy

# Plugin with React UI
npx create-tx5dr-plugin my-plugin --template ui-react

# Plugin with Vue UI
npx create-tx5dr-plugin my-plugin --template ui-vue

# Vanilla UI (no build step for UI files)
npx create-tx5dr-plugin my-plugin --template ui-vanilla
```

## Generated Structure

### Basic (no UI)

```
my-plugin/
├── package.json
├── tsconfig.json
├── .gitignore
├── scripts/
│   └── link.mjs              # Symlink to TX-5DR plugins dir
└── src/
    ├── index.ts
    ├── locales/
    └── __tests__/
```

### React / Vue UI

```
my-plugin/
├── package.json               # Includes vite + framework deps
├── tsconfig.json              # Server-side TS config
├── scripts/
│   └── link.mjs
├── src/
│   ├── index.ts               # Plugin definition with UI pages
│   ├── locales/
│   └── __tests__/
├── ui/                        # Vite project
│   ├── vite.config.ts         # MPA build config
│   ├── tsconfig.json          # Frontend TS (includes bridge types)
│   ├── settings.html          # HTML entry
│   └── src/
│       ├── main.tsx / main.ts # Framework entry
│       ├── App.tsx / App.vue  # Main component
│       └── App.css            # Uses --tx5dr-* CSS tokens
└── dist/                      # Build output
    ├── index.js               # Server-side plugin
    └── ui/
        └── settings.html      # Built iframe page
```

## Development Workflow

```bash
cd my-plugin
npm install
npm run build        # Build everything (server + UI)
npm run link         # Symlink dist/ to TX-5DR plugins dir

# Development (two terminals):
npm run dev:server   # Watch server-side TypeScript
npm run dev:ui       # Watch UI with Vite (React/Vue only)
```

### How `npm run link` works

The `scripts/link.mjs` script:
1. Detects the TX-5DR data directory (platform-specific, or `TX5DR_DATA_DIR` env)
2. Creates a symlink from `dist/` to `{dataDir}/plugins/{plugin-name}`
3. Creates a `.hotreload` marker so TX-5DR dev server auto-reloads on changes

```bash
npm run link            # Create symlink
npm run link -- --unlink   # Remove symlink
```

### Hot Reload

In development mode (`NODE_ENV !== 'production'`), the TX-5DR server watches plugin directories that contain a `.hotreload` marker file. When files change, the plugin is automatically reloaded after a short debounce.

## Documentation

- [Plugin System Guide](https://github.com/boybook/tx-5dr/blob/main/docs/plugin-system.md)
- [@tx5dr/plugin-api](https://www.npmjs.com/package/@tx5dr/plugin-api) — TypeScript types and testing utilities

## License

MIT
