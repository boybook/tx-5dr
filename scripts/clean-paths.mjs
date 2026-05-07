#!/usr/bin/env node
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const patterns = process.argv.slice(2);

if (patterns.length === 0) {
  console.error('Usage: node scripts/clean-paths.mjs <path-or-glob> [...]');
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function segmentPatternToRegExp(segment) {
  const source = segment.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`);
}

async function expandSegments(baseDir, segments) {
  if (segments.length === 0) {
    return [baseDir];
  }

  const [segment, ...rest] = segments;
  if (!segment.includes('*')) {
    return expandSegments(path.join(baseDir, segment), rest);
  }

  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const matcher = segmentPatternToRegExp(segment);
  const matches = entries.filter((entry) => matcher.test(entry.name));
  const expanded = await Promise.all(
    matches.map((entry) => expandSegments(path.join(baseDir, entry.name), rest)),
  );
  return expanded.flat();
}

async function expandPattern(pattern) {
  if (!pattern.includes('*')) {
    return [path.resolve(process.cwd(), pattern)];
  }

  const normalized = path.normalize(pattern);
  const parsed = path.parse(normalized);
  const relative = normalized.slice(parsed.root.length);
  const segments = relative.split(path.sep).filter(Boolean);
  const baseDir = parsed.root ? parsed.root : process.cwd();
  return expandSegments(baseDir, segments);
}

const targets = new Set();
for (const pattern of patterns) {
  const expanded = await expandPattern(pattern);
  for (const target of expanded) {
    targets.add(target);
  }
}

await Promise.all(
  Array.from(targets).map((target) => rm(target, { recursive: true, force: true })),
);
