#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const NAUDIODON_INDEX_PATH = path.join(__dirname, '../node_modules/naudiodon2/index.js');

function applyFix() {
  if (!fs.existsSync(NAUDIODON_INDEX_PATH)) {
    console.log('naudiodon2 not found, skipping fix...');
    return;
  }

  let content = fs.readFileSync(NAUDIODON_INDEX_PATH, 'utf8');
  
  // 检查是否已经应用了修复
  if (content.includes('segfault-handler not available')) {
    console.log('naudiodon2 fix already applied');
    return;
  }

  // 应用修复
  const originalCode = `var SegfaultHandler = require('segfault-handler');
SegfaultHandler.registerHandler("crash.log");`;

  const fixedCode = `try {
  var SegfaultHandler = require('segfault-handler');
  SegfaultHandler.registerHandler("crash.log");
} catch (err) {
  console.warn('segfault-handler not available, continuing without crash logging:', err.message);
}`;

  if (content.includes(originalCode)) {
    content = content.replace(originalCode, fixedCode);
    fs.writeFileSync(NAUDIODON_INDEX_PATH, content, 'utf8');
    console.log('✅ Applied naudiodon2 segfault-handler fix');
  } else {
    console.log('⚠️  Could not find expected code pattern in naudiodon2/index.js');
  }
}

try {
  applyFix();
} catch (error) {
  console.error('❌ Failed to apply naudiodon2 fix:', error.message);
} 