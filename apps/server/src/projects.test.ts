import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const baseTmp = mkdtempSync(join(tmpdir(), 'agicloud-projects-'));
const dataDir = join(baseTmp, 'data');
const rootDir = join(baseTmp, 'projects');
mkdirSync(dataDir, { recursive: true });
mkdirSync(rootDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.WORKSPACES_ROOT = rootDir;
process.env.PROJECT_ROOTS = rootDir;

const { cloneProject, createProjectDir, isGitSource, parseGitSource } = await import('./projects.js');

after(() => {
  rmSync(baseTmp, { recursive: true, force: true });
});

test('isGitSource and parseGitSource handle URLs, shorthands, and invalid inputs', () => {
  assert.equal(isGitSource('owner/my-repo'), true);
  assert.equal(isGitSource('https://github.com/owner/my-repo'), true);
  assert.equal(isGitSource('git@github.com:owner/my-repo.git'), true);
  assert.equal(isGitSource('/data/projects/app'), false);
  assert.equal(isGitSource(''), false);

  assert.deepEqual(parseGitSource('owner/my-repo'), {
    url: 'https://github.com/owner/my-repo.git',
    name: 'my-repo',
  });
  assert.deepEqual(parseGitSource('https://github.com/owner/my-repo/tree/main/src'), {
    url: 'https://github.com/owner/my-repo',
    name: 'my-repo',
  });
  assert.throws(() => parseGitSource('   '), { status: 400 });
  assert.throws(() => parseGitSource('not a git url'), { status: 400 });
});

test('createProjectDir creates a directory inside allowed roots and rejects invalid names', () => {
  const created = createProjectDir('demo-app');
  assert.equal(created.name, 'demo-app');
  assert.equal(created.parent, realpathSync(rootDir));
  assert.equal(created.path, join(realpathSync(rootDir), 'demo-app'));
  assert.equal(existsSync(created.path), true);

  assert.throws(() => createProjectDir('..'), { status: 400 });
  assert.throws(() => createProjectDir('bad/name'), { status: 400 });
});

test('cloneProject clones a git repository and reuses it on repeat calls', async () => {
  const upstream = join(baseTmp, 'upstream-repo');
  mkdirSync(upstream, { recursive: true });
  execFileSync('git', ['init'], { cwd: upstream });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: upstream });
  writeFileSync(join(upstream, 'README.md'), '# Hello\n');
  execFileSync('git', ['add', 'README.md'], { cwd: upstream });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: upstream });

  const first = await cloneProject(`file://${upstream}`);
  assert.equal(first.name, 'upstream-repo');
  assert.equal(first.parent, realpathSync(rootDir));
  assert.equal(first.existed, false);
  assert.equal(existsSync(join(first.path, '.git')), true);
  assert.equal(existsSync(join(first.path, 'README.md')), true);

  const second = await cloneProject(`file://${upstream}`);
  assert.equal(second.path, first.path);
  assert.equal(second.existed, true);
});
