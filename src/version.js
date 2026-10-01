import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './config.js';

/**
 * What build is this?
 *
 * package.json carries the semantic version; the commit identifies the exact
 * source. Both matter for a tool whose output is evidence — when a document is
 * disputed years from now, "which code sealed this" is a question worth being
 * able to answer, and a version alone does not answer it if the tree was dirty.
 */

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Resolved once at startup. A deployed container has no git and no .git
 * directory, so BUILD_SHA is the override the build pipeline sets; the git
 * lookup is the convenience for running from a working copy.
 */
function resolveCommit() {
  if (process.env.BUILD_SHA) return { sha: process.env.BUILD_SHA.slice(0, 12), dirty: false, source: 'env' };
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    }).trim();
    // An uncommitted change means the running code is not the commit it claims.
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    }).trim().length > 0;
    return { sha, dirty, source: 'git' };
  } catch {
    return { sha: null, dirty: false, source: 'unknown' };
  }
}

const pkgVersion = readPackageVersion();
const commit = resolveCommit();

export const version = {
  number: pkgVersion,
  sha: commit.sha,
  dirty: commit.dirty,
  startedAt: new Date().toISOString(),

  /** "0.2.0" — for anywhere the commit would be noise. */
  short: `v${pkgVersion}`,

  /** "0.2.0 (a1b2c3d4e5f6)" or "0.2.0 (a1b2c3d4e5f6+local changes)". */
  full: commit.sha
    ? `v${pkgVersion} (${commit.sha}${commit.dirty ? '+local changes' : ''})`
    : `v${pkgVersion}`,

  /**
   * Printed into sealed PDFs, so it must stay terse and stable in shape — and
   * honest. The trailing "+" marks a build with uncommitted changes: naming a
   * commit on a legal document while the running code differed from it would
   * be a claim the record cannot support.
   */
  stamp: commit.sha
    ? `v${pkgVersion}·${commit.sha.slice(0, 7)}${commit.dirty ? '+' : ''}`
    : `v${pkgVersion}`,
};
