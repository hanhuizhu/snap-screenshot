#!/usr/bin/env node
/* Publishes the current git working tree to GitHub through the REST API.
 *
 * Why: on some networks `git push` over HTTPS to github.com fails
 * ("HTTP/2 framing layer" / "Empty reply from server") while api.github.com
 * stays reachable. This uploads blobs + a tree + one commit and moves the
 * branch, so the history stays clean (a single commit, no per-file commits).
 *
 *   node scripts/upload-tree-via-api.js <owner/repo> [branch] [message]
 *
 * Requires an authenticated gh CLI (`gh auth token`).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REPO = process.argv[2];
const BRANCH = process.argv[3] || 'main';
const MESSAGE = process.argv[4] || `Sync working tree (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`;

if (!REPO || !REPO.includes('/')) {
  console.error('usage: upload-tree-via-api.js <owner/repo> [branch] [message]');
  process.exit(2);
}

const token = execFileSync('gh', ['auth', 'token'], { cwd: ROOT }).toString().trim();

async function api(endpoint, init = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'snap-tree-publisher',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok && res.status !== 404) {
    const msg = body && body.message ? body.message : String(body);
    const err = new Error(`${init.method || 'GET'} ${endpoint} → ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return { ok: res.ok, status: res.status, body };
}

/** files tracked by git, with their exec bit */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: ROOT }).toString();
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      const mode = meta.split(' ')[0];             // 100644 | 100755
      return { file, mode: mode === '100755' ? '100755' : '100644' };
    });
}

async function pool(items, limit, worker) {
  const results = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const files = trackedFiles();
  console.log(`▸ repo ${REPO} · branch ${BRANCH} · ${files.length} files`);

  // A brand-new repo has no git objects, and the blobs endpoint refuses to work
  // on it ("409 Git Repository is empty"); bootstrap one file through the
  // contents API so a branch exists.
  await api(`/repos/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: 'eA==', encoding: 'base64' }),
  }).catch(async (err) => {
    if (err.status !== 409) throw err;
    const seed = files[0];
    console.log(`▸ empty repository — seeding ${seed.file} to create ${BRANCH}`);
    await api(`/repos/${REPO}/contents/${encodeURIComponent(seed.file)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'chore: initialise repository',
        content: fs.readFileSync(path.join(ROOT, seed.file)).toString('base64'),
        branch: BRANCH,
      }),
    });
  });

  const blobs = await pool(files, 4, async ({ file }) => {
    const content = fs.readFileSync(path.join(ROOT, file));
    const { body } = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
    });
    process.stdout.write('.');
    return { path: file, mode: files.find((f) => f.file === file).mode, type: 'blob', sha: body.sha };
  });
  console.log(`\n▸ uploaded ${blobs.length} blobs`);

  const { body: tree } = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: blobs }),
  });
  console.log(`▸ tree ${tree.sha}`);

  // GitHub's ref endpoints take the short form ("heads/main"), not the fully
  // qualified "refs/heads/main", and slashes must stay unencoded.
  const shortRef = `heads/${BRANCH}`;
  const fullRef = `refs/${shortRef}`;
  const head = await api(`/repos/${REPO}/git/ref/${shortRef}`);
  const parents = head.ok && head.body && head.body.object ? [head.body.object.sha] : [];

  const { body: commit } = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: MESSAGE, tree: tree.sha, parents }),
  });
  console.log(`▸ commit ${commit.sha}${parents.length ? ` (parent ${parents[0].slice(0, 7)})` : ''}`);

  if (head.ok) {
    await api(`/repos/${REPO}/git/refs/${shortRef}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    console.log(`▸ moved ${fullRef} → ${commit.sha}`);
  } else {
    await api(`/repos/${REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: fullRef, sha: commit.sha }),
    });
    console.log(`▸ created ${fullRef} → ${commit.sha}`);
  }

  console.log(`✓ https://github.com/${REPO}/tree/${BRANCH}`);
}

main().catch((err) => {
  console.error('\n✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
