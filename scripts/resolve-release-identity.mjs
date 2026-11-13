import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { commitBuildStamp, resolveHostVersion } from './host-version.mjs';

export function validateReleaseVersion(ref, sourceVersion) {
  const tag = ref.replace(/^refs\/tags\//, '');
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) throw new Error('Formal releases require vX.Y.Z');
  if (tag.slice(1) !== sourceVersion) throw new Error('Tag and source version differ');
  return tag;
}

// Paths whose changes can break a packaged product without failing source verification.
const PACKAGING_PATHS = [
  /^\.github\//,
  /^scripts\//,
  /^linux\//,
  /^docker\//,
  /^resources\//,
  /^Dockerfile$/,
  /^docker-compose\.yml$/,
  /^electron-builder\.config\.cjs$/,
  /^yarn\.lock$/,
  /^\.yarnrc\.yml$/,
  /^\.nvmrc$/,
  /(^|\/)package\.json$/,
];

export function touchesPackaging(changedFiles) {
  return changedFiles.some((file) => PACKAGING_PATHS.some((pattern) => pattern.test(file)));
}

/**
 * Decide what one coordinator run does.
 *
 * - verify: run source verification (build, lint, tests).
 * - build: build every Host product.
 * - smoke: build only the Linux Server package, as a packaging check.
 * - publish: promote the built products to their channel.
 *
 * Branch pushes and pull requests verify the source; they build a product only
 * when packaging inputs changed. Nightly publication belongs to the schedule
 * and to an explicit manual dispatch, formal publication to a `vX.Y.Z` tag.
 */
export function planRelease({ eventName, isTag, isCurrentMain, publishRequested, nightlyPublished, packagingChanged }) {
  if (eventName === 'schedule') {
    const due = isCurrentMain && !nightlyPublished;
    return { verify: due, build: due, smoke: false, publish: due };
  }
  if (eventName === 'workflow_dispatch') {
    return { verify: true, build: true, smoke: false, publish: Boolean(publishRequested) && (isTag || isCurrentMain) };
  }
  if (eventName === 'push' && isTag) {
    return { verify: true, build: true, smoke: false, publish: true };
  }
  return { verify: true, build: false, smoke: Boolean(packagingChanged), publish: false };
}

if (process.argv[1]?.endsWith('/resolve-release-identity.mjs') || process.argv[1] === 'scripts/resolve-release-identity.mjs') {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const ref = process.env.REQUEST_REF || 'HEAD';
  const eventName = process.env.EVENT_NAME || '';
  const sha = git('rev-parse', 'HEAD');
  const sourceVersion = JSON.parse(fs.readFileSync('package.json')).version;
  let version = '';
  if (ref.startsWith('refs/tags/') || /^v\d/.test(ref)) {
    version = validateReleaseVersion(ref, sourceVersion);
    if (git('rev-parse', `${version}^{commit}`) !== sha) throw new Error('Release tag does not identify this checkout');
  }
  const isCurrentMain = ['main', 'refs/heads/main', sha].includes(ref) && git('rev-parse', 'origin/main') === sha;

  // The publisher tags each nightly `build-<version>`; the version is a pure function of the commit.
  const nightlyTag = `build-${resolveHostVersion({ sourceVersion, channel: 'nightly', buildStamp: commitBuildStamp(sha), commit: sha })}`;
  const nightlyPublished = git('ls-remote', '--tags', 'origin', `refs/tags/${nightlyTag}`) !== '';

  // An unknown base (new branch, shallow history, manual run) counts as a packaging change.
  let packagingChanged = true;
  const base = process.env.BASE_SHA || '';
  if (/^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)) {
    try {
      packagingChanged = touchesPackaging(git('diff', '--name-only', base, sha).split('\n').filter(Boolean));
    } catch {
      packagingChanged = true;
    }
  }

  const plan = planRelease({
    eventName,
    isTag: Boolean(version),
    isCurrentMain,
    publishRequested: process.env.PUBLISH_REQUEST === 'true',
    nightlyPublished,
    packagingChanged,
  });
  process.stdout.write(`sha=${sha}\nversion=${version}\nverify=${plan.verify}\nbuild=${plan.build}\nsmoke=${plan.smoke}\npublish=${plan.publish}\n`);
}
