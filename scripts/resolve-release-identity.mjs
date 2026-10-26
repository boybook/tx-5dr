import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function validateReleaseVersion(ref, sourceVersion) {
  const tag = ref.replace(/^refs\/tags\//, '');
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) throw new Error('Formal releases require vX.Y.Z');
  if (tag.slice(1) !== sourceVersion) throw new Error('Tag and source version differ');
  return tag;
}

if (process.argv[1]?.endsWith('/resolve-release-identity.mjs') || process.argv[1] === 'scripts/resolve-release-identity.mjs') {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const ref = process.env.REQUEST_REF || 'HEAD';
  const sha = git('rev-parse', 'HEAD');
  let version = '';
  if (ref.startsWith('refs/tags/') || /^v\d/.test(ref)) {
    version = validateReleaseVersion(ref, JSON.parse(fs.readFileSync('package.json')).version);
    if (git('rev-parse', `${version}^{commit}`) !== sha) throw new Error('Release tag does not identify this checkout');
  }
  const publish = process.env.PUBLISH_REQUEST === 'true' && process.env.EVENT_NAME !== 'pull_request' &&
    (Boolean(version) || ['main', 'refs/heads/main', sha].includes(ref) && git('rev-parse', 'origin/main') === sha);
  process.stdout.write(`sha=${sha}\nversion=${version}\npublish=${publish}\n`);
}
