import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const execFileP = promisify(execFile)

/** How stale a node_modules really is — freshest activity signal first (v1.1):
 *  1. last commit of the nearest `.git` (a project that still gets commits is alive,
 *     no matter how fresh `npm install` was);
 *  2. nearest `package.json` mtime (no git — manifests change when the project changes);
 *  3. the node_modules folder mtime (weakest signal, always available). */
export type ActivitySource = 'git' | 'manifest' | 'mtime'

export interface Activity {
  /** Whole days since the freshest signal (floor of ms/86400000). */
  idleDays: number
  source: ActivitySource
}

const DAY_MS = 86_400_000
const GIT_TIMEOUT_MS = 4_000

async function hasGitDir(dir: string): Promise<boolean> {
  try {
    // .git is a dir normally, a FILE for worktrees/submodules — stat covers both.
    await stat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

async function mtimeOf(dir: string, file: string): Promise<number | null> {
  try {
    return (await stat(join(dir, file))).mtimeMs
  } catch {
    return null
  }
}

/** Walk up from `start` (inclusive) to the filesystem root, first dir satisfying `test`. */
async function findUp(start: string, test: (dir: string) => Promise<boolean>): Promise<string | null> {
  let dir = start
  for (;;) {
    if (await test(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Committer timestamp (epoch seconds) of the last commit — null without git or commits. */
async function lastCommitSeconds(gitDir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', gitDir, 'log', '-1', '--format=%ct'],
      { maxBuffer: 64 * 1024, timeout: GIT_TIMEOUT_MS },
    )
    const seconds = Number.parseInt(stdout.trim(), 10)
    return Number.isNaN(seconds) ? null : seconds
  } catch {
    // no git binary, not a repo, or a repo with zero commits — degrade to the next signal
    return null
  }
}

/**
 * Compute the idle age of a node_modules whose folder sits at `entryPath`.
 * The search starts at the entry's own directory (a nested node_modules climbs to
 * the same repo root as its owner, and per-call caching collapses the cost).
 */
export async function computeActivity(entryPath: string, now = Date.now()): Promise<Activity | null> {
  const startDir = dirname(entryPath)

  const gitDir = await findUp(startDir, hasGitDir)
  if (gitDir !== null) {
    const seconds = await lastCommitSeconds(gitDir)
    if (seconds !== null) {
      return { idleDays: idleFrom(seconds * 1000, now), source: 'git' }
    }
  }

  const manifestMtime = await findUp(startDir, async (dir) => (await mtimeOf(dir, 'package.json')) !== null)
  if (manifestMtime !== null) {
    const mtime = await mtimeOf(manifestMtime, 'package.json')
    if (mtime !== null) {
      return { idleDays: idleFrom(mtime, now), source: 'manifest' }
    }
  }

  const folderMtime = await mtimeOf(startDir, 'node_modules')
  if (folderMtime !== null) {
    return { idleDays: idleFrom(folderMtime, now), source: 'mtime' }
  }
  return null
}

function idleFrom(signalMs: number, now: number): number {
  return Math.max(0, Math.floor((now - signalMs) / DAY_MS))
}
