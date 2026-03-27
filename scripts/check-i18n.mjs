#!/usr/bin/env node
/**
 * check-i18n.mjs — TX-5DR 代码规范检查脚本
 *
 * 用法：node scripts/check-i18n.mjs [--strict]
 *
 * 检查项：
 *  1. 前端 .tsx/.ts 硬编码 CJK 字符串（排除注释、locale 文件、t() 调用）
 *  2. 前端模块级 CJK 常量（应改为 getXxx(t) 工厂函数）
 *  3. 前端入口文件 i18n 导入检查
 *  4. 后端/core/electron 裸 console.* 调用（应使用 createLogger）
 *  5. 后端/core/electron 源码中的 CJK 字符串（日志消息必须为英文）
 *
 * 退出码：0=全部通过，1=有违规
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const STRICT = process.argv.includes('--strict');

// ─── ANSI 颜色 ───────────────────────────────────────────────────────────────
const R = '\x1b[31m'; // red
const Y = '\x1b[33m'; // yellow
const G = '\x1b[32m'; // green
const C = '\x1b[36m'; // cyan
const D = '\x1b[2m';  // dim
const B = '\x1b[1m';  // bold
const X = '\x1b[0m';  // reset

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function walk(dir, exts, excludeDirs = []) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!excludeDirs.some(ex => full.includes(ex))) {
        results.push(...walk(full, exts, excludeDirs));
      }
    } else if (exts.includes(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

function rel(p) {
  return relative(ROOT, p);
}

// CJK 统一汉字范围（不含日韩假名，避免误报）
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

// 剥除行尾内联 // 注释（粗略处理，避免误删字符串内的 //）
function stripInlineComment(line) {
  let inSingle = false, inDouble = false, inTemplate = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i], n = line[i + 1];
    if (c === '\\' && (inSingle || inDouble || inTemplate)) { i++; continue; }
    if (c === "'" && !inDouble && !inTemplate) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle && !inTemplate) { inDouble = !inDouble; continue; }
    if (c === '`' && !inSingle && !inDouble) { inTemplate = !inTemplate; continue; }
    if (!inSingle && !inDouble && !inTemplate && c === '/' && n === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

// 判断某行是否是"安全" CJK（仅允许注释、翻译调用、locale 文件）
function isFrontendSafeLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  if (trimmed.startsWith('{/*') || /^\s*\{\/\*/.test(line)) return true;
  if (/\{\/\*[^*]*\*\/\}/.test(line) && !/<[A-Za-z]/.test(line) && !/['"]/.test(line)) return true;
  if (trimmed.startsWith('/**')) return true;
  // 已经是翻译调用：t('...') 或 i18n.t('...')
  if (/\bi18n\.t\(/.test(line) || /\bt\(/.test(line)) return true;
  // import 语句
  if (/^\s*import\s/.test(line)) return true;
  // JSON 字符串（locale 文件本身）
  if (/^\s*"[^"]*":\s*"/.test(line)) return true;
  // 去除内联注释后检查
  const strippedLine = stripInlineComment(line);
  if (!CJK_RE.test(strippedLine)) return true;
  return false;
}

// 判断后端行是否安全（仅允许注释）
function isBackendSafeLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  if (trimmed.startsWith('/**')) return true;
  // 去除内联注释后检查
  const strippedLine = stripInlineComment(line);
  if (!CJK_RE.test(strippedLine)) return true;
  return false;
}

// ─── 检查项 1：前端硬编码 CJK ─────────────────────────────────────────────────
function checkFrontendHardcodedCJK() {
  const srcDir = join(ROOT, 'packages/web/src');
  const excludeDirs = [join(srcDir, 'i18n', 'locales')];
  const files = walk(srcDir, ['.tsx', '.ts'], excludeDirs);

  const violations = [];

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const fileViolations = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!CJK_RE.test(line)) continue;
      if (isFrontendSafeLine(line)) continue;
      fileViolations.push({ line: i + 1, content: line.trimEnd(), severity: 'error' });
    }

    if (fileViolations.length > 0) {
      violations.push({ file, issues: fileViolations });
    }
  }

  return violations;
}

// ─── 检查项 2：模块级 CJK 常量（非工厂函数）─────────────────────────────────
function checkModuleLevelCJKConstants() {
  const srcDir = join(ROOT, 'packages/web/src');
  const files = walk(srcDir, ['.tsx', '.ts'], [join(srcDir, 'i18n')]);
  const violations = [];
  const MODULE_CONST_RE = /^const\s+[A-Z_]+\s*[=:]/;

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let braceDepth = 0;
    const fileViolations = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      braceDepth = Math.max(0, braceDepth);

      if (braceDepth === 0 && MODULE_CONST_RE.test(line.trim()) && CJK_RE.test(stripInlineComment(line))) {
        fileViolations.push({ line: i + 1, content: line.trimEnd(), severity: 'error' });
      }
    }

    if (fileViolations.length > 0) {
      violations.push({ file, issues: fileViolations });
    }
  }

  return violations;
}

// ─── 检查项 3：入口文件 i18n 导入 ─────────────────────────────────────────────
function checkEntryImports() {
  const entries = [
    { file: join(ROOT, 'packages/web/src/main.tsx'), desc: 'main.tsx' },
    { file: join(ROOT, 'packages/web/src/spectrum-main.tsx'), desc: 'spectrum-main.tsx' },
  ];

  const violations = [];

  for (const { file, desc } of entries) {
    try {
      const firstFewLines = readFileSync(file, 'utf8').split('\n').slice(0, 5).join('\n');
      if (!firstFewLines.includes('i18n')) {
        violations.push({
          file,
          issues: [{ line: 1, content: `Entry file missing i18n import in first 5 lines`, severity: 'error' }],
        });
      }
    } catch {
      violations.push({
        file,
        issues: [{ line: 0, content: `File not found: ${desc}`, severity: 'error' }],
      });
    }
  }

  // logbook.html 特殊检查（内联脚本入口）
  try {
    const logbookHtml = readFileSync(join(ROOT, 'packages/web/logbook.html'), 'utf8');
    if (!logbookHtml.includes('i18n')) {
      violations.push({
        file: join(ROOT, 'packages/web/logbook.html'),
        issues: [{ line: 0, content: 'logbook.html inline script missing i18n import', severity: 'error' }],
      });
    }
  } catch {}

  return violations;
}

// ─── 检查项 4：后端/core/electron 裸 console.* 调用 ──────────────────────────
// 这些文件由于特殊原因允许直接使用 console.*
const BACKEND_CONSOLE_ALLOWED = new Set([
  'utils/logger.ts',
  'utils/console-logger.ts',
]);

// 仅检查 .js（AudioWorklet 无法使用模块系统，只能用 console，已改为英文）
const BACKEND_CONSOLE_ALLOWED_FILES = new Set([
  'public/audio-monitor-worklet.js',
]);

function isConsoleLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
  return /console\.(log|warn|error|debug|info)\s*\(/.test(line);
}

function checkBackendConsoleCalls() {
  const packages = [
    join(ROOT, 'packages/server/src'),
    join(ROOT, 'packages/core/src'),
    join(ROOT, 'packages/electron-main/src'),
  ];

  const violations = [];

  for (const pkgDir of packages) {
    let files;
    try {
      files = walk(pkgDir, ['.ts']);
    } catch {
      continue;
    }

    for (const file of files) {
      // 允许列表：相对于包目录的路径结尾匹配
      const relToSrc = relative(pkgDir, file).replace(/\\/g, '/');
      if ([...BACKEND_CONSOLE_ALLOWED].some(allowed => relToSrc.endsWith(allowed))) continue;

      const lines = readFileSync(file, 'utf8').split('\n');
      const fileViolations = [];

      for (let i = 0; i < lines.length; i++) {
        if (isConsoleLine(lines[i])) {
          fileViolations.push({ line: i + 1, content: lines[i].trimEnd(), severity: 'error' });
        }
      }

      if (fileViolations.length > 0) {
        violations.push({ file, issues: fileViolations });
      }
    }
  }

  return violations;
}

// ─── 检查项 5：后端/core/electron 源码中的 CJK 字符串 ─────────────────────────
// callsign.ts 包含 COUNTRY_ZH_MAP / PROVINCE_EN_MAP / AREA_MAP / REGION_INFO
// 这些是面向中文用户的本地化数据，不是日志消息，允许包含中文
// i18n.ts 是 electron-main 的多语言字符串模块，允许包含中文
const BACKEND_CJK_ALLOWED_FILES = new Set([
  'callsign/callsign.ts',
  'i18n.ts',
]);

function checkBackendCJK() {
  const packages = [
    join(ROOT, 'packages/server/src'),
    join(ROOT, 'packages/core/src'),
    join(ROOT, 'packages/electron-main/src'),
  ];

  const violations = [];

  for (const pkgDir of packages) {
    let files;
    try {
      files = walk(pkgDir, ['.ts']);
    } catch {
      continue;
    }

    for (const file of files) {
      // 允许列表：包含中文本地化数据的文件
      const relToSrc = relative(pkgDir, file).replace(/\\/g, '/');
      if ([...BACKEND_CJK_ALLOWED_FILES].some(allowed => relToSrc.endsWith(allowed))) continue;

      const lines = readFileSync(file, 'utf8').split('\n');
      const fileViolations = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!CJK_RE.test(line)) continue;
        if (isBackendSafeLine(line)) continue;
        fileViolations.push({ line: i + 1, content: line.trimEnd(), severity: 'error' });
      }

      if (fileViolations.length > 0) {
        violations.push({ file, issues: fileViolations });
      }
    }
  }

  return violations;
}

// ─── 汇总输出 ─────────────────────────────────────────────────────────────────
function printViolations(title, violations, icon, countAsErrors = true) {
  if (violations.length === 0) {
    console.log(`${G}✓${X} ${title}`);
    return 0;
  }

  let errorCount = 0;
  let warnCount = 0;

  console.log(`\n${B}${icon} ${title}${X}`);

  for (const { file, issues } of violations) {
    console.log(`  ${C}${rel(file)}${X}`);
    for (const { line, content, severity } of issues) {
      const color = severity === 'error' ? R : Y;
      const tag = severity === 'error' ? 'ERR ' : 'WARN';
      const truncated = content.length > 100 ? content.slice(0, 97) + '...' : content;
      console.log(`    ${color}[${tag}]${X} ${D}L${line}:${X} ${truncated}`);
      if (severity === 'error') errorCount++;
      else warnCount++;
    }
  }

  return countAsErrors ? errorCount : 0;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
console.log(`\n${B}TX-5DR 代码规范检查${X}  ${D}(--strict: ${STRICT})${X}\n`);

let totalErrors = 0;

// 1. 前端硬编码 CJK
totalErrors += printViolations(
  '前端硬编码 CJK（应通过 t() 国际化）',
  checkFrontendHardcodedCJK(),
  '🔍'
);

// 2. 模块级 CJK 常量
totalErrors += printViolations(
  '模块级 CJK 常量（应改为 getXxx(t) 工厂函数）',
  checkModuleLevelCJKConstants(),
  '🏭'
);

// 3. 入口文件 i18n 导入
totalErrors += printViolations(
  '入口文件 i18n 导入',
  checkEntryImports(),
  '📦'
);

// 4. 后端裸 console.* 调用（应使用 createLogger）
totalErrors += printViolations(
  '后端/core/electron 裸 console.* 调用（应使用 createLogger）',
  checkBackendConsoleCalls(),
  '📋'
);

// 5. 后端 CJK 字符串（日志消息必须为英文）
totalErrors += printViolations(
  '后端/core/electron CJK 字符串（日志消息必须为英文）',
  checkBackendCJK(),
  '🌐'
);

// ─── 统计 ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));

if (totalErrors === 0) {
  console.log(`\n${G}${B}✓ 全部检查通过！${X}\n`);
  process.exit(0);
} else {
  console.log(`\n${R}${B}✗ 发现 ${totalErrors} 处违规，请修复后重试。${X}`);
  console.log(`\n${D}提示：运行 node scripts/check-i18n.mjs 可随时检查合规状态${X}\n`);
  process.exit(1);
}
