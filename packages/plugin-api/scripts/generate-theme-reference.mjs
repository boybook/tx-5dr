import { writeFile } from 'node:fs/promises';
import { getPluginThemeCss } from '../dist/ui/theme.js';
await writeFile(new URL('../tokens.css', import.meta.url), '/* Generated reference for IDE autocomplete. Host injects runtime tokens; do not import this file. */\n' + getPluginThemeCss('dark'));
