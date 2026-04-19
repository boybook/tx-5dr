#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

const ROOT_DIR = process.cwd();
const DEFAULT_BASE = 'packages/core/src/callsign/dxcc.json';
const DEFAULT_OUT = 'packages/core/src/callsign/dxcc.json';

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eqIndex = arg.indexOf('=');
    if (eqIndex === -1) {
      parsed[arg.slice(2)] = 'true';
      continue;
    }
    parsed[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
  }
  return parsed;
}

async function readText(input) {
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input, {
      headers: {
        'Accept': 'text/plain,text/html;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${input}: ${response.status}`);
    }
    return response.text();
  }

  const resolved = path.resolve(ROOT_DIR, input);
  return fs.readFile(resolved, 'utf8');
}

async function fileExists(input) {
  if (!input) return false;
  try {
    await fs.access(path.resolve(ROOT_DIR, input));
    return true;
  } catch {
    return false;
  }
}

async function resolveBigCTYInputs(args) {
  const ctyDir = args['cty-dir'];
  if (!ctyDir) {
    return {
      ctyDatPath: args.cty,
      ctyCsvPath: args['cty-csv'],
    };
  }

  const resolvedDir = path.resolve(ROOT_DIR, ctyDir);
  const ctyDatPath = path.join(resolvedDir, 'cty.dat');
  const ctyCsvPath = path.join(resolvedDir, 'cty.csv');

  return {
    ctyDatPath: await fileExists(ctyDatPath) ? ctyDatPath : undefined,
    ctyCsvPath: await fileExists(ctyCsvPath) ? ctyCsvPath : undefined,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePrefixToken(token) {
  let normalized = token.trim();
  if (!normalized) return null;

  normalized = normalized.replace(/;$/, '');
  if (normalized.startsWith('=')) {
    return null;
  }
  normalized = normalized.replace(/[[(<{~].*$/, '');
  normalized = normalized.replace(/^[*]+/, '');
  normalized = normalized.replace(/^[,\s]+|[,\s]+$/g, '');
  normalized = normalized.toUpperCase();

  if (!normalized || !/^[A-Z0-9/]+$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function buildPrefixRegex(prefixes) {
  if (prefixes.length === 0) {
    return '';
  }

  const sorted = [...prefixes].sort((left, right) => right.length - left.length);
  return `^(${sorted.map(escapeRegex).join('|')})[A-Z0-9/]*$`;
}

function parseARRLCurrentDeleted(text) {
  const lines = text.split(/\r?\n/);
  let section = null;
  let inTable = false;
  const entries = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.includes('CURRENT ENTITIES')) {
      section = 'current';
      inTable = false;
      continue;
    }

    if (line.includes('DELETED ENTITIES')) {
      section = 'deleted';
      inTable = false;
      continue;
    }

    if (!section) {
      continue;
    }

    if (line.includes('Prefix') && line.includes('Entity') && line.includes('Code')) {
      inTable = true;
      continue;
    }

    if (!inTable || !line.trim() || /^_+$/.test(line.trim())) {
      continue;
    }

    const match = line.match(/^\s*(.+?)\s{2,}(.+?)\s{2,}([A-Z,()]+)\s{2,}([0-9(),A-Z]+)\s{2,}([0-9(),A-Z]+)\s{2,}([0-9]{3})\s*$/);
    if (!match) {
      continue;
    }

    entries.push({
      prefixText: match[1].trim(),
      entityName: match[2].trim(),
      entityCode: Number(match[6]),
      deleted: section === 'deleted',
    });
  }

  return entries;
}

function validateAgainstARRL(entities, arrlEntries) {
  const entityByCode = new Map(entities.map((entity) => [entity.entityCode, entity]));
  const issues = [];

  for (const arrlEntry of arrlEntries) {
    const entity = entityByCode.get(arrlEntry.entityCode);
    if (!entity) {
      issues.push(`Missing DXCC entity for ARRL code ${arrlEntry.entityCode} (${arrlEntry.entityName})`);
      continue;
    }

    if (Boolean(entity.deleted) !== arrlEntry.deleted) {
      issues.push(
        `DXCC entity ${arrlEntry.entityCode} (${entity.name}) deleted mismatch: local=${Boolean(entity.deleted)} arrl=${arrlEntry.deleted}`
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(`ARRL validation failed:\n${issues.slice(0, 20).join('\n')}`);
  }
}

function parseCTYDat(text) {
  const lines = text.split(/\r?\n/);
  const entries = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#') || !line.endsWith(':')) {
      continue;
    }

    const fields = line.split(':').map((part) => part.trim());
    if (fields.length < 8) {
      continue;
    }

    const name = fields[0];
    const cqZone = Number(fields[1]);
    const ituZone = Number(fields[2]);
    const continent = fields[3] || undefined;
    const primaryPrefix = normalizePrefixToken(fields[7]);
    const prefixes = new Set();

    if (primaryPrefix) {
      prefixes.add(primaryPrefix);
    }

    const aliasLines = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1].trim();
      index += 1;
      if (!next || next.startsWith('#')) {
        continue;
      }

      aliasLines.push(next);
      if (next.endsWith(';')) {
        break;
      }
    }

    const aliasTokens = aliasLines.join(' ').split(',');
    for (const token of aliasTokens) {
      const normalized = normalizePrefixToken(token);
      if (normalized) {
        prefixes.add(normalized);
      }
    }

    entries.set(name, {
      cqZone: Number.isFinite(cqZone) ? cqZone : undefined,
      ituZone: Number.isFinite(ituZone) ? ituZone : undefined,
      continent: continent ? [continent] : undefined,
      prefixes: [...prefixes],
    });
  }

  return entries;
}

function parseCTYCsv(text) {
  const lines = text.split(/\r?\n/);
  const entries = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 10) continue;

    const primaryPrefix = normalizePrefixToken(parts[0]);
    const name = parts[1].trim();
    const entityCode = Number(parts[2]);
    const continent = parts[3].trim() || undefined;
    const cqZone = Number(parts[4]);
    const ituZone = Number(parts[5]);
    const aliasField = parts.slice(9).join(',').trim();
    const prefixes = new Set();

    if (primaryPrefix) {
      prefixes.add(primaryPrefix);
    }

    for (const token of aliasField.split(/\s+/)) {
      const normalized = normalizePrefixToken(token);
      if (normalized) {
        prefixes.add(normalized);
      }
    }

    if (!Number.isFinite(entityCode)) {
      continue;
    }

    entries.set(entityCode, {
      entityCode,
      name,
      cqZone: Number.isFinite(cqZone) ? cqZone : undefined,
      ituZone: Number.isFinite(ituZone) ? ituZone : undefined,
      continent: continent ? [continent] : undefined,
      prefixes: [...prefixes],
    });
  }

  return entries;
}

function mergeDXCCData(baseData, sources) {
  const currentNameCounts = new Map();
  for (const entity of baseData.dxcc) {
    if (entity.deleted) continue;
    currentNameCounts.set(entity.name, (currentNameCounts.get(entity.name) || 0) + 1);
  }

  const mergedEntities = baseData.dxcc.map((entity) => {
    const ctyEntry = entity.deleted
      ? null
      : sources.byCode?.get(entity.entityCode)
        || (currentNameCounts.get(entity.name) === 1 ? sources.byName?.get(entity.name) : null);
    const prefixes = ctyEntry?.prefixes?.length ? ctyEntry.prefixes : null;

    return {
      ...entity,
      prefix: prefixes ? prefixes.join(',') : entity.prefix,
      prefixRegex: prefixes ? buildPrefixRegex(prefixes) : entity.prefixRegex,
      cqZone: ctyEntry?.cqZone ?? entity.cqZone ?? entity.cq?.[0],
      ituZone: ctyEntry?.ituZone ?? entity.ituZone ?? entity.itu?.[0],
      continent: ctyEntry?.continent?.length ? ctyEntry.continent : entity.continent,
    };
  });

  return mergedEntities;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const basePath = args.base || DEFAULT_BASE;
  const outPath = args.out || DEFAULT_OUT;
  const version = args.version || new Date().toISOString().slice(0, 10);
  const { ctyDatPath, ctyCsvPath } = await resolveBigCTYInputs(args);
  const upstream = args.upstream || (args['cty-dir'] ? 'bigcty-dir' : (ctyCsvPath ? 'cty.csv' : (ctyDatPath ? 'cty.dat' : 'manual-seed')));
  const sourceVersion = args['source-version'] || version;

  const baseText = await readText(basePath);
  if (!baseText) {
    throw new Error(`Missing base DXCC data: ${basePath}`);
  }

  const baseData = JSON.parse(baseText);
  const ctyDatText = await readText(ctyDatPath);
  const ctyCsvText = await readText(ctyCsvPath);
  const ctySources = {
    byName: ctyDatText ? parseCTYDat(await ctyDatText) : null,
    byCode: ctyCsvText ? parseCTYCsv(await ctyCsvText) : null,
  };
  const mergedEntities = mergeDXCCData(baseData, ctySources);
  const arrlText = await readText(args.arrl);
  if (arrlText) {
    validateAgainstARRL(mergedEntities, parseARRLCurrentDeleted(arrlText));
  }

  const output = {
    version,
    source: {
      type: ctyCsvText ? 'cty-csv-merge' : (ctyDatText ? 'cty-dat-merge' : 'seed-json'),
      upstream,
      sourceVersion,
      generatedBy: 'scripts/generate-dxcc-data.mjs',
      generatedAt: new Date().toISOString(),
    },
    dxcc: mergedEntities,
  };

  const resolvedOut = path.resolve(ROOT_DIR, outPath);
  await fs.writeFile(`${resolvedOut}`, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${mergedEntities.length} DXCC entities to ${resolvedOut}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
