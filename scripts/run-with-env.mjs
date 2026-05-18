#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const env = { ...process.env };
let commandIndex = 0;

function setEnvAssignment(assignment) {
  const equalsIndex = assignment.indexOf('=');
  if (equalsIndex <= 0) {
    console.error(`Invalid --env assignment: ${assignment}`);
    process.exit(1);
  }
  env[assignment.slice(0, equalsIndex)] = assignment.slice(equalsIndex + 1);
}


function readOptionValue(option, index) {
  const equalsIndex = option.indexOf('=');
  if (equalsIndex !== -1) {
    return { value: option.slice(equalsIndex + 1), nextIndex: index + 1 };
  }
  return { value: args[index + 1], nextIndex: index + 2 };
}

while (commandIndex < args.length) {
  const arg = args[commandIndex];
  if (arg === '--') {
    commandIndex += 1;
    break;
  }
  if (arg === '--env' || arg.startsWith('--env=')) {
    const { value, nextIndex } = readOptionValue(arg, commandIndex);
    if (!value) {
      console.error('Missing value for --env');
      process.exit(1);
    }
    setEnvAssignment(value);
    commandIndex = nextIndex;
    continue;
  }
  if (arg === '--node-env' || arg.startsWith('--node-env=')) {
    const { value, nextIndex } = readOptionValue(arg, commandIndex);
    if (!value) {
      console.error('Missing value for --node-env');
      process.exit(1);
    }
    env.NODE_ENV = value;
    commandIndex = nextIndex;
    continue;
  }
  break;
}

const [command, ...commandArgs] = args.slice(commandIndex);
if (!command) {
  console.error('Usage: node scripts/run-with-env.mjs [--env KEY=value] [--node-env=value] <command> [...]');
  process.exit(1);
}

const child = spawn(command, commandArgs, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
