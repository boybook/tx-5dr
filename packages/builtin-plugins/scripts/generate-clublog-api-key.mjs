#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, '..', 'src', 'clublog-sync', 'generated', 'api-key.ts');
const apiKey = process.env.TX5DR_CLUBLOG_API_KEY || '';

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `export const BUILTIN_CLUBLOG_API_KEY = ${JSON.stringify(apiKey)};\n`, 'utf8');

console.log(apiKey ? 'Generated Club Log API key module.' : 'Generated empty Club Log API key module.');
