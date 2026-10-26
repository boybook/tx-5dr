import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifyPublicationRetry(run, jobs, repository) {
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.event, 'push');
  assert.equal(run.status, 'completed');
  assert.match(run.head_branch, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  const required = [
    'verify', 'docker / build', 'android / Build Android Runtime (Linux arm64)',
    'server / Build Server Package (Linux arm64)', 'server / Build Server Package (Linux amd64)',
    'electron / build (windows-2022, win32, x64, tx-5dr-windows-x64)',
    'electron / build (macos-latest, darwin, arm64, tx-5dr-macos-arm64)',
    'electron / build (macos-15-intel, darwin, x64, tx-5dr-macos-x64)',
    'electron / build (ubuntu-24.04, linux, x64, tx-5dr-linux-x64)',
    'electron / build (ubuntu-24.04-arm, linux, arm64, tx-5dr-linux-arm64)',
  ];
  for (const name of required) {
    const matches = jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `Missing or ambiguous required job: ${name}`);
    assert.equal(matches[0].conclusion, 'success', `Required job did not pass: ${name}`);
  }
  return { sha: run.head_sha, tag: run.head_branch };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.env.ORIGINAL_RUN;
  assert.match(id || '', /^\d+$/);
  const repository = process.env.GITHUB_REPOSITORY;
  const gh = args => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
  const run = gh(['api', `repos/${repository}/actions/runs/${id}`]);
  // gh run view consolidates the passed jobs retained from earlier attempts.
  const { jobs } = gh(['run', 'view', id, '--repo', repository, '--json', 'jobs']);
  const identity = verifyPublicationRetry(run, jobs, repository);
  for (const [key, value] of Object.entries(identity)) process.stdout.write(`${key}=${value}\n`);
}
