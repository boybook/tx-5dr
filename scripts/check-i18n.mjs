#!/usr/bin/env node
/**
 * check-i18n.mjs — TX-5DR i18n 合规性检查脚本
 *
 * 用法：node scripts/check-i18n.mjs [--strict]
 *
 * 检查项：
 *  1. 前端 .tsx/.ts 源码中的硬编码 CJK 字符串（排除注释、locale 文件、t() 调用内容）
 *  2. 模块级常量中的硬编码 CJK（应改为 getXxx(t) 工厂函数）
 *  3. 入口文件是否在首行引入 i18n
 *  4. 后端 server 源码中的裸 console.log（高频路径应使用 createLogger）
 *
 * 退出码：0=全部通过，1=有违规
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';

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

// ─── 工具函数 ──────────────────────────────────────────────────────────────
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

// 判断某行是否是"合规的" CJK 出现（注释、t() 调用、i18n.t()、日志等）
function isSafeLine(line) {
  const trimmed = line.trim();
  // 普通注释行
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  // JSX 注释 {/* ... */}
  if (trimmed.startsWith('{/*') || /^\s*\{\/\*/.test(line)) return true;
  // 行内 JSX 注释（只有注释内容）
  if (/\{\/\*[^*]*\*\/\}/.test(line) && !/<[A-Za-z]/.test(line) && !/['"]/.test(line)) return true;
  // JSDoc
  if (trimmed.startsWith('/**')) return true;
  // 已经是翻译调用：t('...') 或 i18n.t('...')
  if (/\bi18n\.t\(/.test(line) || /\bt\(/.test(line)) return true;
  // 纯 console.error/warn（后端关键错误保留中文）
  if (/console\.(error|warn)\(/.test(line)) return true;
  // import 语句
  if (/^\s*import\s/.test(line)) return true;
  // JSON 字符串（locale 文件本身）
  if (/^\s*"[^"]*":\s*"/.test(line)) return true;
  // 行尾内联注释：去掉 // 之后的内容再检查是否仍有 CJK
  // 去除字符串内的内联注释（简单处理：找到非字符串内的 // 位置）
  const strippedLine = stripInlineComment(line);
  if (!CJK_RE.test(strippedLine)) return true;
  return false;
}

// 剥除行尾内联 // 注释（粗略处理，避免误删字符串内的 //）
function stripInlineComment(line) {
  // 用状态机跳过字符串，找到代码部分的 //
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

// ─── 检查项 1：前端硬编码 CJK ───────────────────────────────────────────────
function checkFrontendHardcodedCJK() {
  const srcDir = join(ROOT, 'packages/web/src');
  const excludeDirs = [
    join(srcDir, 'i18n', 'locales'),
  ];
  const files = walk(srcDir, ['.tsx', '.ts'], excludeDirs);

  const violations = [];

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const fileViolations = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!CJK_RE.test(line)) continue;
      if (isSafeLine(line)) continue;

      // 额外排除：纯 console.log（后端不需要，前端 debug 日志允许中文）
      // 对前端，console.log 带中文也应国际化，但不强制（warn 级别）
      const isConsoleLog = /console\.log\(/.test(line);
      fileViolations.push({
        line: i + 1,
        content: line.trimEnd(),
        severity: isConsoleLog ? 'warn' : 'error',
      });
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

  // 检测：const FOO = { ...'中文'... } 或 const FOO = ['中文', ...]
  // 在组件函数外（即文件顶层）
  const MODULE_CONST_RE = /^const\s+[A-Z_]+\s*[=:]/;

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let inFunctionOrClass = false;
    let braceDepth = 0;
    const fileViolations = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 简单跟踪花括号深度来判断是否在函数/类内
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      braceDepth = Math.max(0, braceDepth);

      // 仅检查模块级（花括号深度 0 时出现的 const），去掉行内注释后检查
      if (braceDepth === 0 && MODULE_CONST_RE.test(line.trim()) && CJK_RE.test(stripInlineComment(line))) {
        fileViolations.push({
          line: i + 1,
          content: line.trimEnd(),
          severity: 'error',
        });
      }
    }

    if (fileViolations.length > 0) {
      violations.push({ file, issues: fileViolations });
    }
  }

  return violations;
}

// ─── 检查项 3：入口文件 i18n 导入 ───────────────────────────────────────────
function checkEntryImports() {
  const entries = [
    { file: join(ROOT, 'packages/web/src/main.tsx'), desc: 'main.tsx' },
    { file: join(ROOT, 'packages/web/src/spectrum-main.tsx'), desc: 'spectrum-main.tsx' },
  ];

  const violations = [];

  for (const { file, desc } of entries) {
    try {
      const content = readFileSync(file, 'utf8');
      const firstFewLines = content.split('\n').slice(0, 5).join('\n');
      if (!firstFewLines.includes("i18n")) {
        violations.push({
          file,
          issues: [{
            line: 1,
            content: `入口文件未在前 5 行引入 i18n`,
            severity: 'error',
          }],
        });
      }
    } catch {
      violations.push({
        file,
        issues: [{ line: 0, content: `文件不存在: ${desc}`, severity: 'error' }],
      });
    }
  }

  // logbook.html 特殊检查
  try {
    const logbookHtml = readFileSync(join(ROOT, 'packages/web/logbook.html'), 'utf8');
    if (!logbookHtml.includes('i18n')) {
      violations.push({
        file: join(ROOT, 'packages/web/logbook.html'),
        issues: [{ line: 0, content: 'logbook.html 内联脚本未引入 i18n', severity: 'error' }],
      });
    }
  } catch {}

  return violations;
}

// ─── 检查项 4：后端裸 console.log（高频路径）────────────────────────────────
const SERVER_HIGH_FREQ_FILES = [
  'websocket/WSServer.ts',
  'audio/AudioStreamManager.ts',
  'radio/PhysicalRadioManager.ts',
  'operator/RadioOperatorManager.ts',
  'subsystems/EngineLifecycle.ts',
  'subsystems/TransmissionPipeline.ts',
];

function checkServerConsoleLogs() {
  const violations = [];

  for (const relPath of SERVER_HIGH_FREQ_FILES) {
    const file = join(ROOT, 'packages/server/src', relPath);
    let lines;
    try {
      lines = readFileSync(file, 'utf8').split('\n');
    } catch {
      continue; // 文件不存在则跳过
    }

    const fileViolations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/console\.log\(/.test(line) && !line.trim().startsWith('//')) {
        fileViolations.push({
          line: i + 1,
          content: line.trimEnd(),
          severity: 'warn',
        });
      }
    }

    if (fileViolations.length > 0) {
      violations.push({ file, issues: fileViolations });
    }
  }

  return violations;
}

// ─── 汇总输出 ─────────────────────────────────────────────────────────────
function printViolations(title, violations, icon) {
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
      const tag = severity === 'error' ? 'ERR' : 'WARN';
      const truncated = content.length > 100 ? content.slice(0, 97) + '...' : content;
      console.log(`    ${color}[${tag}]${X} ${D}L${line}:${X} ${truncated}`);
      if (severity === 'error') errorCount++;
      else warnCount++;
    }
  }

  return errorCount;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
console.log(`\n${B}TX-5DR i18n 合规性检查${X}  ${D}(--strict 模式: ${STRICT})${X}\n`);

let totalErrors = 0;

// 1. 前端硬编码 CJK
const cjkViolations = checkFrontendHardcodedCJK();
totalErrors += printViolations(
  '前端硬编码 CJK 字符串',
  cjkViolations,
  '🔍'
);

// 2. 模块级 CJK 常量
const constViolations = checkModuleLevelCJKConstants();
totalErrors += printViolations(
  '模块级 CJK 常量（应改为工厂函数）',
  constViolations,
  '🏭'
);

// 3. 入口文件 i18n 导入
const entryViolations = checkEntryImports();
totalErrors += printViolations(
  '入口文件 i18n 导入检查',
  entryViolations,
  '📦'
);

// 4. 后端高频路径 console.log（仅 warn，不计入 error）
const serverLogViolations = checkServerConsoleLogs();
printViolations(
  '后端高频路径 console.log（建议改用 logger.debug）',
  serverLogViolations,
  '📋'
);

// ─── 统计 ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));

const hasErrors = totalErrors > 0;
const hasWarns = cjkViolations.some(v => v.issues.some(i => i.severity === 'warn')) ||
                 serverLogViolations.length > 0;

if (!hasErrors) {
  console.log(`\n${G}${B}✓ 全部检查通过！${X}${hasWarns ? ` ${Y}(有警告，请关注)${X}` : ''}\n`);
  process.exit(0);
} else {
  console.log(`\n${R}${B}✗ 发现 ${totalErrors} 处 i18n 违规，请修复后重试。${X}`);
  console.log(`\n${D}提示：运行 node scripts/check-i18n.mjs 可随时检查合规状态${X}\n`);
  process.exit(1);
}
