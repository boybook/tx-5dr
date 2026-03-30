#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      continue;
    }

    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value || value === true) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

function joinUrl(base, pathname) {
  return `${base.replace(/\/$/, '')}${pathname}`;
}

function buildGiteeApiUrl(pathname, query = {}) {
  const url = new URL(joinUrl('https://gitee.com/api/v5', pathname));

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url;
}

function maskUrlForLogs(url) {
  const cloned = new URL(url.toString());
  if (cloned.searchParams.has('access_token')) {
    cloned.searchParams.set('access_token', '***');
  }
  return cloned.toString();
}

async function readResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const text = await response.text();
  return text;
}

async function githubRequest(pathname, token) {
  const url = joinUrl('https://api.github.com', pathname);
  console.log(`GitHub API URL: ${url}`);

  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'User-Agent': 'tx5dr-gitee-sync',
    },
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed (${response.status} ${response.statusText}): ${typeof body === 'string' ? body : JSON.stringify(body)}`
    );
  }

  return body;
}

async function giteeRequest({
  pathname,
  token,
  method = 'GET',
  query = {},
  body,
  allowNotFound = false,
}) {
  const url = buildGiteeApiUrl(pathname, query);

  const normalizedQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    normalizedQuery.set(key, String(value));
  }

  if (method === 'GET' || method === 'DELETE') {
    normalizedQuery.set('access_token', token);
  }

  url.search = normalizedQuery.toString();
  console.log(`Gitee API URL: ${maskUrlForLogs(url)}`);

  const requestInit = {
    method,
    headers: {
      'User-Agent': 'tx5dr-gitee-sync',
    },
  };

  if (body instanceof URLSearchParams || body instanceof FormData) {
    if (!body.has('access_token')) {
      body.append('access_token', token);
    }
    requestInit.body = body;
  }

  const response = await fetch(url, requestInit);

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (response.status === 204) {
    return null;
  }

  const responseBody = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `Gitee API request failed (${response.status} ${response.statusText}): ${typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)}`
    );
  }

  return responseBody;
}

function rewriteBody(body, { githubRepo, giteeOwner, giteeRepo }) {
  if (!body) {
    return '';
  }

  const githubBase = `https://github.com/${githubRepo}`;
  const giteeBase = `https://gitee.com/${giteeOwner}/${giteeRepo}`;

  return body.split(githubBase).join(giteeBase);
}

async function listAssetFiles(dirPath) {
  if (!dirPath) {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeAttachFiles(payload) {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.attach_files)) {
    return payload.attach_files;
  }
  if (Array.isArray(payload.attachFiles)) {
    return payload.attachFiles;
  }
  return [];
}

async function getGitHubReleaseByTag({ githubRepo, githubToken, tag }) {
  return githubRequest(`/repos/${githubRepo}/releases/tags/${encodeURIComponent(tag)}`, githubToken);
}

async function getGiteeReleaseByTag({ giteeOwner, giteeRepo, giteeToken, tag }) {
  return giteeRequest({
    pathname: `/repos/${encodeURIComponent(giteeOwner)}/${encodeURIComponent(giteeRepo)}/releases/tags/${encodeURIComponent(tag)}`,
    token: giteeToken,
    allowNotFound: true,
  });
}

async function createGiteeRelease({ giteeOwner, giteeRepo, giteeToken, githubRelease, rewrittenBody }) {
  const form = new URLSearchParams();
  form.set('tag_name', githubRelease.tag_name);
  form.set('name', githubRelease.name);
  form.set('body', rewrittenBody);
  form.set('prerelease', githubRelease.prerelease ? 'true' : 'false');
  form.set('target_commitish', githubRelease.target_commitish || 'main');

  return giteeRequest({
    pathname: `/repos/${encodeURIComponent(giteeOwner)}/${encodeURIComponent(giteeRepo)}/releases`,
    token: giteeToken,
    method: 'POST',
    body: form,
  });
}

async function updateGiteeRelease({ giteeOwner, giteeRepo, giteeToken, releaseId, githubRelease, rewrittenBody }) {
  const form = new URLSearchParams();
  form.set('tag_name', githubRelease.tag_name);
  form.set('name', githubRelease.name);
  form.set('body', rewrittenBody);
  form.set('prerelease', githubRelease.prerelease ? 'true' : 'false');

  return giteeRequest({
    pathname: `/repos/${encodeURIComponent(giteeOwner)}/${encodeURIComponent(giteeRepo)}/releases/${releaseId}`,
    token: giteeToken,
    method: 'PATCH',
    body: form,
  });
}

async function listGiteeAttachFiles({ giteeOwner, giteeRepo, giteeToken, releaseId }) {
  const payload = await giteeRequest({
    pathname: `/repos/${encodeURIComponent(giteeOwner)}/${encodeURIComponent(giteeRepo)}/releases/${releaseId}/attach_files`,
    token: giteeToken,
    query: {
      per_page: 100,
      direction: 'desc',
    },
  });

  return normalizeAttachFiles(payload);
}

async function verifyGiteeRepoAccess({ giteeOwner, giteeRepo, giteeToken }) {
  return giteeRequest({
    pathname: `/repos/${encodeURIComponent(giteeOwner)}/${encodeURIComponent(giteeRepo)}`,
    token: giteeToken,
  });
}

async function deleteGiteeAttachFile({ giteeOwner, giteeRepo, giteeToken, releaseId, attachFileId }) {
  return giteeRequest({
    pathname: `/repos/${encodeURIComponent(giteeOwner)}/${encodeURIComponent(giteeRepo)}/releases/${releaseId}/attach_files/${attachFileId}`,
    token: giteeToken,
    method: 'DELETE',
  });
}

async function uploadGiteeAttachFile({ giteeOwner, giteeRepo, giteeToken, releaseId, filePath }) {
  const pathname = `/repos/${encodeURIComponent(giteeOwner)}/${encodeURIComponent(giteeRepo)}/releases/${releaseId}/attach_files`;
  const url = buildGiteeApiUrl(pathname);
  console.log(`Gitee API URL: ${maskUrlForLogs(url)}`);

  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-fsS',
        '-X',
        'POST',
        '-F',
        `access_token=${giteeToken}`,
        '-F',
        `file=@${filePath}`,
        url.toString(),
      ],
      {
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    return stdout ? JSON.parse(stdout) : null;
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : '';
    const stdout =
      error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string'
        ? error.stdout.trim()
        : '';
    const details = [stderr, stdout].filter(Boolean).join(' | ');
    throw new Error(`Attachment upload failed for ${path.basename(filePath)}${details ? `: ${details}` : ''}`);
  }
}

async function syncRelease() {
  const args = parseArgs(process.argv.slice(2));
  const githubRepo = requireArg(args, 'github-repo');
  const tag = requireArg(args, 'tag');
  const giteeOwner = requireArg(args, 'gitee-owner');
  const giteeRepo = requireArg(args, 'gitee-repo');
  const assetsDir = args['assets-dir'];
  const githubToken = process.env.GITHUB_TOKEN || '';
  const giteeToken = process.env.GITEE_TOKEN || '';

  if (!giteeToken) {
    throw new Error('Missing GITEE_TOKEN environment variable');
  }
  if (giteeOwner.includes('/') || giteeOwner.startsWith('http')) {
    throw new Error(`Invalid GITEE_OWNER: ${giteeOwner}`);
  }
  if (giteeRepo.includes('/') || giteeRepo.startsWith('http')) {
    throw new Error(`Invalid GITEE_REPO: ${giteeRepo}`);
  }

  console.log(`Checking Gitee repository access: ${giteeOwner}/${giteeRepo}`);
  try {
    await verifyGiteeRepoAccess({
      giteeOwner,
      giteeRepo,
      giteeToken,
    });
  } catch (error) {
    throw new Error(
      `Failed to access Gitee repository ${giteeOwner}/${giteeRepo}. Check GITEE_OWNER, GITEE_REPO, and whether GITEE_TOKEN has access. ${error instanceof Error ? error.message : error}`
    );
  }

  console.log(`Fetching GitHub release: ${githubRepo}@${tag}`);
  const githubRelease = await getGitHubReleaseByTag({ githubRepo, githubToken, tag });
  const rewrittenBody = rewriteBody(githubRelease.body || '', {
    githubRepo,
    giteeOwner,
    giteeRepo,
  });

  console.log(`Checking Gitee release: ${giteeOwner}/${giteeRepo}@${tag}`);
  const existingGiteeRelease = await getGiteeReleaseByTag({
    giteeOwner,
    giteeRepo,
    giteeToken,
    tag,
  });

  let giteeRelease;
  if (existingGiteeRelease?.id) {
    console.log(`Updating existing Gitee release #${existingGiteeRelease.id}`);
    giteeRelease = await updateGiteeRelease({
      giteeOwner,
      giteeRepo,
      giteeToken,
      releaseId: existingGiteeRelease.id,
      githubRelease,
      rewrittenBody,
    });
  } else {
    console.log('Creating new Gitee release');
    giteeRelease = await createGiteeRelease({
      giteeOwner,
      giteeRepo,
      giteeToken,
      githubRelease,
      rewrittenBody,
    });
  }

  const releaseId = giteeRelease.id;
  if (!releaseId) {
    throw new Error('Gitee release response did not contain an id');
  }

  if (assetsDir) {
    const assetFiles = await listAssetFiles(assetsDir);
    console.log(`Syncing ${assetFiles.length} release asset(s) from ${assetsDir}`);

    for (const filePath of assetFiles) {
      const fileName = path.basename(filePath);
      const fileInfo = await stat(filePath);
      console.log(`Preparing attachment: ${fileName} (${fileInfo.size} bytes)`);

      const existingAttachFiles = await listGiteeAttachFiles({
        giteeOwner,
        giteeRepo,
        giteeToken,
        releaseId,
      });

      for (const attachFile of existingAttachFiles) {
        if (!attachFile?.id || attachFile.name !== fileName) {
          continue;
        }

        console.log(`Deleting old attachment: ${attachFile.name} (#${attachFile.id})`);
        await deleteGiteeAttachFile({
          giteeOwner,
          giteeRepo,
          giteeToken,
          releaseId,
          attachFileId: attachFile.id,
        });
      }

      console.log(`Uploading attachment: ${fileName}`);
      await uploadGiteeAttachFile({
        giteeOwner,
        giteeRepo,
        giteeToken,
        releaseId,
        filePath,
      });
    }
  }

  console.log(`Gitee release sync completed: ${tag}`);
}

syncRelease().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
