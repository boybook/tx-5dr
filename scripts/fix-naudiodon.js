#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const NAUDIODON_INDEX_PATH = path.join(__dirname, '../node_modules/naudiodon2/index.js');
const NAUDIODON_SRC_DIR = path.join(__dirname, '../node_modules/naudiodon2/src');

function applySegfaultFix() {
  if (!fs.existsSync(NAUDIODON_INDEX_PATH)) {
    console.log('naudiodon2 not found, skipping fix...');
    return;
  }

  let content = fs.readFileSync(NAUDIODON_INDEX_PATH, 'utf8');
  
  // 检查是否已经应用了修复
  if (content.includes('segfault-handler not available')) {
    console.log('naudiodon2 segfault-handler fix already applied');
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

function applyLinuxCompatibilityFixes() {
  if (os.platform() !== 'linux') {
    return;
  }

  if (!fs.existsSync(NAUDIODON_SRC_DIR)) {
    console.log('naudiodon2 src directory not found, skipping Linux compatibility fixes...');
    return;
  }

  console.log('Applying naudiodon2 Linux compatibility fixes...');
  
  function fixFileRecursively(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        fixFileRecursively(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.h') || entry.name.endsWith('.cpp') || entry.name.endsWith('.cc'))) {
        fixCppFile(fullPath);
      }
    }
  }
  
  function fixCppFile(filePath) {
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      let modified = false;
      
      // Fix missing #include <string> for std::string usage
      if (content.includes('std::string') && !content.includes('#include <string>')) {
        const lines = content.split('\n');
        let insertIndex = -1;
        
        // Find the best position to insert #include <string>
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].match(/^#include\s*<[^>]+>$/)) {
            // Found a system include, keep looking for the last one
            insertIndex = i + 1;
          } else if (lines[i].match(/^#include\s*"[^"]+"/)) {
            // Found a local include, insert before it if we haven't found a good spot
            if (insertIndex === -1) {
              insertIndex = i;
            }
            break;
          } else if (lines[i].trim() !== '' && !lines[i].startsWith('#') && insertIndex !== -1) {
            // Found non-include, non-empty line
            break;
          }
        }
        
        if (insertIndex > -1) {
          lines.splice(insertIndex, 0, '#include <string>');
          content = lines.join('\n');
          modified = true;
        }
      }
      
      // Fix other common Linux compilation issues
      if (content.includes('std::thread') && !content.includes('#include <thread>')) {
        const lines = content.split('\n');
        let insertIndex = -1;
        
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].match(/^#include\s*<[^>]+>$/)) {
            insertIndex = i + 1;
          } else if (lines[i].trim() !== '' && !lines[i].startsWith('#') && insertIndex !== -1) {
            break;
          }
        }
        
        if (insertIndex > -1) {
          lines.splice(insertIndex, 0, '#include <thread>');
          content = lines.join('\n');
          modified = true;
        }
      }
      
      if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`✅ Fixed C++ includes in ${path.relative(NAUDIODON_SRC_DIR, filePath)}`);
      }
    } catch (error) {
      console.log(`⚠️  Could not fix ${filePath}: ${error.message}`);
    }
  }
  
  fixFileRecursively(NAUDIODON_SRC_DIR);
}

function applyFixes() {
  applySegfaultFix();
  applyLinuxCompatibilityFixes();
}

try {
  applyFixes();
} catch (error) {
  console.error('❌ Failed to apply naudiodon2 fixes:', error.message);
} 