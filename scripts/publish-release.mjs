import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveHostVersion } from './host-version.mjs';
import { validateReleaseVersion } from './resolve-release-identity.mjs';

async function sha256(stream) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.SOURCE_SHA;
const tagInput = process.env.RELEASE_VERSION || '';
const channel = tagInput ? 'release' : 'nightly';
for (const name of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_ENDPOINT', 'OSS_BASE_URL', 'GH_TOKEN', 'SOURCE_SHA', 'GITHUB_REPOSITORY']) {
  if (!process.env[name]) throw new Error(`Missing publication configuration: ${name}`);
}
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Full source SHA required');
if (run('git', ['rev-parse', 'HEAD']) !== sha) throw new Error('Checkout identity mismatch');
const root = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (tagInput) {
  validateReleaseVersion(tagInput, root.version);
  if (run('git', ['rev-parse', `${tagInput}^{commit}`]) !== sha) throw new Error('Tag mismatch');
} else {
  const remoteHead = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  if (remoteHead !== sha) { process.stdout.write('Superseded nightly: publication skipped.\n'); process.exit(0); }
}
const date = run('git', ['show', '-s', '--format=%cI', sha]);
const stamp = new Date(date).toISOString().replace(/[-:T]/g, '').slice(0, 12);
const version = resolveHostVersion({ sourceVersion: root.version, channel, releaseVersion: tagInput, buildStamp: stamp, commit: sha });
const tag = tagInput || `build-${version}`;
const base = process.env.OSS_BASE_URL.replace(/\/+$/, '');
const bucket = process.env.OSS_BUCKET;
const region = process.env.OSS_REGION || /oss-([a-z0-9-]+)\.aliyuncs\.com/.exec(process.env.OSS_ENDPOINT)?.[1];
if (!region) throw new Error('Missing OSS region');
const staging = path.resolve('release-staging');
await fs.mkdir(staging, { recursive: true });
const config = path.join(process.env.RUNNER_TEMP || staging, 'tx5dr-oss.conf');
await fs.writeFile(config, `[Credentials]\nlanguage=EN\nregion=${region}\nendpoint=${process.env.OSS_ENDPOINT}\naccessKeyID=${process.env.OSS_ACCESS_KEY_ID}\naccessKeySecret=${process.env.OSS_ACCESS_KEY_SECRET}\n`, { mode: 0o600 });
const oss = (...args) => run('ossutil', [...args, '-c', config]);
async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}
const products = { app: {}, server: {}, 'android-runtime': {}, docker: {} };
const notes = channel === 'release' ? await fs.readFile(`release-notes/${version}.md`, 'utf8') : `Nightly ${version}\n\n${run('git', ['log', '-10', '--format=%h %s', sha])}`;
const inputFiles = await files('release-inputs');
for (const product of Object.keys(products)) await fs.mkdir(path.join(staging, product), { recursive: true });
for (const file of inputFiles) {
  const name = path.basename(file);
  const bundle = path.relative('release-inputs', file).split(path.sep)[0];
  const product = /^tx5dr-server-linux-(amd64|arm64)$/.test(bundle) ? 'server'
    : bundle === 'tx5dr-android-runtime-linux-arm64' ? 'android-runtime'
    : bundle === 'tx5dr-docker' ? 'docker'
    : /^tx-5dr-(windows-x64|macos-arm64|macos-x64|linux-x64|linux-arm64)$/.test(bundle) ? 'app' : null;
  if (!product) throw new Error(`Unexpected artifact bundle: ${bundle}`);
  if (name === 'latest.json' && product === 'android-runtime') continue;
  const allowed = product === 'docker' ? name === 'docker.json'
    : product === 'android-runtime' ? name.endsWith('.tar.gz')
    : product === 'server' ? /\.(deb|rpm)$/.test(name)
    : /\.(dmg|zip|deb|rpm|7z|exe|AppImage|blockmap)$/.test(name);
  if (!allowed) throw new Error(`Unexpected distributable: ${name}`);
  await fs.copyFile(file, path.join(staging, product, name));
}
run('bash', ['scripts/build-install-script.sh']);
await fs.writeFile(path.join(staging, 'server', 'install-online.sh'), (await fs.readFile('dist/install-online.sh', 'utf8')).replaceAll('TX5DR_UPDATE_CHANNEL:-nightly', `TX5DR_UPDATE_CHANNEL:-${channel}`));
for (const product of Object.keys(products)) {
  const directory = path.join(staging, product);
  const output = path.join(staging, `${product}-manifest.json`);
  const args = ['scripts/generate-oss-manifest.mjs', '--product', product, '--channel', channel, '--tag', tag, '--version', version, '--commit', sha, '--published-at', date, '--base-url', base, '--object-prefix', `tx-5dr/${product}/builds/${version}`, '--github-base-url', 'https://github.com', '--github-object-prefix', `${repo}/releases/download/${tag}`, '--release-notes', notes, '--output', output];
  if (product !== 'docker') args.push('--assets-dir', directory);
  else {
    const image = JSON.parse(await fs.readFile(path.join(directory, 'docker.json')));
    if (!/^sha256:[a-f0-9]{64}$/.test(image.digest)) throw new Error('Missing image digest');
    const imageIndex = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', `${image.image}@${image.digest}`, '--raw']));
    for (const architecture of ['amd64', 'arm64']) {
      if (!imageIndex.manifests?.some(item => item.platform?.os === 'linux' && item.platform.architecture === architecture)) throw new Error(`Missing Docker architecture: ${architecture}`);
    }
    if (channel === 'release') {
      try {
        const existingImage = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', `${image.image}:${version}`, '--format', '{{json .Manifest}}']));
        if (existingImage.digest !== image.digest) throw new Error('Immutable Docker version tag conflict');
      } catch (error) {
        if (!/not found|manifest unknown|no such manifest/i.test(String(error.stderr || error.message))) throw error;
      }
    }
    args.push('--docker-image', image.image, '--docker-digest', image.digest);
  }
  run('node', args);
  const manifest = JSON.parse(await fs.readFile(output));
  manifest.schema_version = 1;
  if (product === 'android-runtime') {
    for (const asset of manifest.assets) Object.assign(asset, { platform: 'android', arch: 'arm64', package_type: 'tar.gz' });
  }
  const required = product === 'app' ? [...['exe','zip','7z'].map(type => ['windows','x64',type]), ...['arm64','x64'].flatMap(arch => ['dmg','zip'].map(type => ['macos',arch,type])), ...['arm64','x64'].flatMap(arch => ['deb','rpm','AppImage','zip'].map(type => ['linux',arch,type]))] : product === 'server' ? [['linux','amd64','deb'], ['linux','arm64','deb'], ['linux','amd64','rpm'], ['linux','arm64','rpm']] : product === 'android-runtime' ? [['android','arm64','tar.gz']] : [];
  for (const [platform, arch, type] of required) if (!manifest.assets.some(asset => asset.platform === platform && asset.arch === arch && asset.package_type === type)) throw new Error(`Missing ${product}/${platform}/${arch}/${type}`);
  for (const asset of manifest.assets) if (!asset.sha256 || !asset.size) throw new Error('Incomplete artifact integrity metadata');
  products[product] = manifest;
  await fs.writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
}
const catalog = { schema_version: 1, version, commit: sha, channel, products };
await fs.writeFile(path.join(staging, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
const productDownloads = Object.entries(products).map(([product, manifest]) => {
  const links = manifest.assets.map(asset => `- [${asset.name}](${asset.url_github || asset.url})`);
  if (product === 'docker') links.push(`- Image: \`${manifest.docker_image}@${manifest.docker_digest}\``);
  return `### ${product}\n\n${links.join('\n')}`;
}).join('\n\n');
await fs.writeFile(path.join(staging, 'notes.md'), `${notes}\n\nSource: [${sha}](https://github.com/${repo}/commit/${sha})\n\n${productDownloads}\n\nAndroid APK is released independently: https://github.com/boybook/tx5dr-android-bridge/releases\n`);
let existing;
try { existing = JSON.parse(run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets'])); }
catch (error) {
  if (!String(error.stderr || '').includes('release not found')) throw error;
}
if (!existing) run('gh', ['release', 'create', tag, '--repo', repo, '--target', sha, '--draft', '--title', `TX-5DR ${version}`, '--notes-file', path.join(staging, 'notes.md'), ...(channel === 'nightly' ? ['--prerelease'] : [])]);
const uploadFiles = [];
for (const product of Object.keys(products)) {
  if (product !== 'docker') uploadFiles.push(...await files(path.join(staging, product)));
  uploadFiles.push(path.join(staging, `${product}-manifest.json`));
}
uploadFiles.push(path.join(staging, 'catalog.json'));
// Existing assets must be byte-identical. Never overwrite a released version.
for (const file of uploadFiles) {
  const name = path.basename(file);
  if (existing?.assets.some(asset => asset.name === name)) {
    const downloaded = path.join(staging, 'existing'); await fs.mkdir(downloaded, { recursive: true });
    run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', downloaded, '--clobber']);
    if (!(await fs.readFile(file)).equals(await fs.readFile(path.join(downloaded, name)))) throw new Error(`Immutable asset conflict: ${name}`);
  } else run('gh', ['release', 'upload', tag, file, '--repo', repo]);
}
const githubRelease = JSON.parse(run('gh', ['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]));
for (const file of uploadFiles) {
  const asset = githubRelease.assets.find(item => item.name === path.basename(file));
  const expectedHash = await sha256(createReadStream(file));
  if (!asset || asset.size !== (await fs.stat(file)).size) throw new Error(`GitHub asset size mismatch: ${file}`);
  if (asset.digest) {
    if (asset.digest !== `sha256:${expectedHash}`) throw new Error(`GitHub asset digest mismatch: ${file}`);
  } else {
    const verifyDir = path.join(staging, 'github-verify'); await fs.mkdir(verifyDir, { recursive: true });
    run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', path.basename(file), '--dir', verifyDir, '--clobber']);
    if (await sha256(createReadStream(path.join(verifyDir, path.basename(file)))) !== expectedHash) throw new Error(`GitHub asset verification failed: ${file}`);
  }
}
for (const [product, manifest] of Object.entries(products)) {
  const localFiles = product === 'docker' ? [] : await files(path.join(staging, product));
  for (const file of localFiles) {
    const name = path.basename(file);
    const asset = manifest.assets.find(item => item.name === name) ?? { name, sha256: await sha256(createReadStream(file)) };
    const object = `tx-5dr/${product}/builds/${version}/${asset.name}`;
    // A previously uploaded object's content is checked before any write.
    const remote = await fetch(`${base}/${object}`);
    if (remote.ok) {
      const hash = await sha256(remote.body);
      if (hash !== asset.sha256) throw new Error(`Immutable OSS conflict: ${object}`);
    } else if (remote.status === 404) oss('cp', path.join(staging, product, asset.name), `oss://${bucket}/${object}`);
    else throw new Error(`OSS preflight HTTP ${remote.status}`);
    const verify = await fetch(`${base}/${object}`);
    if (!verify.ok || await sha256(verify.body) !== asset.sha256) throw new Error(`CDN verification failed: ${object}`);
  }
  oss('cp', path.join(staging, `${product}-manifest.json`), `oss://${bucket}/tx-5dr/${product}/builds/${version}/latest.json`, '--force');
}
// Re-check the remote identity immediately before any user-visible channel promotion.
if (channel === 'nightly') {
  if (run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0] !== sha) {
    process.stdout.write('Superseded nightly: immutable candidate retained; channel promotion skipped.\n');
    await fs.rm(config); process.exit(0);
  }
} else {
  const refs = run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split('\n').map(line => line.split(/\s+/));
  const remoteTag = refs.find(([, ref]) => ref.endsWith('^{}')) || refs.find(([, ref]) => ref === `refs/tags/${tag}`);
  if (remoteTag?.[0] !== sha) throw new Error('Remote formal tag changed; refusing promotion');
}
// All immutable assets now exist. Expose the release before moving mutable channels.
run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', ...(channel === 'release' ? ['--latest'] : ['--prerelease', '--latest=false'])]);
for (const [product, manifest] of Object.entries(products)) {
  const local = path.join(staging, `${product}-manifest.json`);
  oss('cp', local, `oss://${bucket}/tx-5dr/${product}/${channel}/latest.json`, '--force');
  if (product === 'server') oss('cp', path.join(staging, 'server', 'install-online.sh'), `oss://${bucket}/tx-5dr/server/${channel}/install-online.sh`, '--force');
  if (channel === 'nightly') {
    const rolling = `nightly-${product}`;
    let found = true;
    try { run('gh', ['release', 'view', rolling, '--repo', repo]); } catch { found = false; }
    if (!found) run('gh', ['release', 'create', rolling, '--repo', repo, '--target', sha, '--prerelease', '--title', `Nightly — ${product}`, '--notes-file', path.join(staging, 'notes.md')]);
    run('gh', ['release', 'edit', rolling, '--repo', repo, '--title', `Nightly — ${product}`, '--notes-file', path.join(staging, 'notes.md'), '--prerelease', '--latest=false']);
    const legacy = path.join(staging, product, product === 'docker' ? 'docker-manifest.json' : 'latest.json');
    await fs.copyFile(local, legacy);
    const legacyAssets = product === 'docker' ? [] : (await files(path.join(staging, product))).filter(file => path.basename(file) !== 'latest.json');
    run('gh', ['release', 'upload', rolling, legacy, ...legacyAssets, '--repo', repo, '--clobber']);
    if (product === 'app' || product === 'server') {
      for (const file of [...legacyAssets, legacy]) oss('cp', file, `oss://${bucket}/tx-5dr/${product}/${rolling}/${path.basename(file)}`, '--force');
    }
    if (product === 'server') {
      oss('cp', local, `oss://${bucket}/tx-5dr/server/latest.json`, '--force');
      oss('cp', path.join(staging, 'server', 'install-online.sh'), `oss://${bucket}/tx-5dr/server/latest/install-online.sh`, '--force');
    }
    if (product === 'docker') oss('cp', local, `oss://${bucket}/tx-5dr/docker/latest.json`, '--force');
  }
  if (product === 'docker') {
    const aliases = channel === 'release' ? ['stable', 'latest', version] : ['nightly'];
    run('docker', ['buildx', 'imagetools', 'create', ...aliases.flatMap(alias => ['--tag', `${manifest.docker_image}:${alias}`]), `${manifest.docker_image}@${manifest.docker_digest}`]);
  }
}
oss('cp', path.join(staging, 'catalog.json'), `oss://${bucket}/tx-5dr/${channel}/catalog.json`, '--force');
for (const product of Object.keys(products)) {
  const response = await fetch(`${base}/tx-5dr/${product}/${channel}/latest.json`);
  if (!response.ok || (await response.json()).commit !== sha) throw new Error(`Live channel verification failed: ${product}`);
}
await fs.rm(config);
process.stdout.write(`Published ${version} from ${sha}; GitHub, assets and channel metadata verified.\n`);
