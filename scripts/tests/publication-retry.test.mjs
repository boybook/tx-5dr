import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPublicationRetry } from '../verify-publication-retry.mjs';

const run = { path: '.github/workflows/release.yml', repository: { full_name: 'boybook/tx-5dr' }, event: 'push', status: 'completed', head_branch: 'v1.0.0', head_sha: 'a'.repeat(40) };
const names = ['verify', 'docker / build', 'android / Build Android Runtime (Linux arm64)', ...['arm64','amd64'].map(arch=>`server / Build Server Package (Linux ${arch})`),
  'electron / build (windows-2022, win32, x64, tx-5dr-windows-x64)', 'electron / build (macos-latest, darwin, arm64, tx-5dr-macos-arm64)', 'electron / build (macos-15-intel, darwin, x64, tx-5dr-macos-x64)', 'electron / build (ubuntu-24.04, linux, x64, tx-5dr-linux-x64)', 'electron / build (ubuntu-24.04-arm, linux, arm64, tx-5dr-linux-arm64)'];
const jobs=names.map(name=>({name,conclusion:'success'}));
test('allows failed publication only when every original product gate passed',()=>{
  assert.deepEqual(verifyPublicationRetry(run,[...jobs,{name:'publish',conclusion:'failure'}],'boybook/tx-5dr'),{sha:run.head_sha,tag:'v1.0.0'});
  assert.throws(()=>verifyPublicationRetry(run,jobs.slice(1),'boybook/tx-5dr'));
  assert.throws(()=>verifyPublicationRetry(run,jobs.map((j,i)=>i?j:{...j,conclusion:'failure'}),'boybook/tx-5dr'));
  assert.throws(()=>verifyPublicationRetry({...run,event:'pull_request'},jobs,'boybook/tx-5dr'));
  assert.throws(()=>verifyPublicationRetry({...run,head_branch:'main'},jobs,'boybook/tx-5dr'));
  assert.throws(()=>verifyPublicationRetry(run,jobs,'other/repository'));
});
