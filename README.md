# 🐉 node-modules-hunter (nmh)

> Hunt down bloated `node_modules` folders across your machine — scan, measure, and clean them **with one command**.

```bash
nmh --dir=./my-project,./my-repo/packages/*/node_modules --delete=hard
```

`node_modules` grows absurdly and piles up across every repo, sub-repo and artifact you forget about. Manual cleanup means cd-ing into each project, checking, deleting, praying. **nmh** does it in one line, safely, cross-platform (Linux · macOS · Windows), and cross-package-manager (npm · pnpm · Yarn · bun — *and* [Vite+ (`vp`)](https://viteplus.dev) projects, whose `vp` wrapper is detected through the underlying manager's lockfile the same way vp itself detects it).

For a plain interactive TUI alternative, check [npkill](https://github.com/voidcosmos/npkill) — nmh's differentiators are scriptable flags (CI-friendly), monorepo-aware package-manager detection, and accurate byte accounting that never follows symlinks.

---

## Install

```bash
# run once without installing
npx node-modules-hunter scan

# or install globally (bin: nmh, alias: node-modules-hunter)
npm i -g node-modules-hunter
```

Node.js ≥ 18 required.

## Usage

```
nmh                                # interactive wizard (scan cwd → checkbox → pick mode → confirm)
nmh <path> [path…]                 # shortcut: scan given path(s)
nmh scan [dir]                     # full scan (default: cwd)
nmh clean [dir]                    # scan + delete everything safe (trash by default)
nmh search <pattern> [dir…]        # find installed packages by name (+ versions & sizes)
nmh map [dir]                      # project → PM → size → top packages → declared deps

nmh --dir=A,B,glob/*/node_modules  # targets: comma list, globs, ~ — combine with flags below
nmh version | --version | -v
nmh help    | --help    | -h
```

Search patterns: plain text is a case-insensitive substring (`nmh search lodash`), glob chars match whole names (`v*`, `@scope/*`), and `/re/flags` is a real regex (`/^vi/`).

| Flag | Effect |
| --- | --- |
| `-d, --dir <paths>` | Target dirs — comma separated or repeated; globs (`./packages/*/node_modules`) and `~` allowed |
| `--delete=hard\|soft\|trash` | Delete mode: `hard` = permanent, `trash`/`soft` = OS recycle bin; no value = pick interactively |
| `--dry-run` | Preview what would be deleted — **nothing is touched** |
| `-f, --force` | Skip confirmations (implies `--yes`) |
| `-y, --yes` | Answer yes to every prompt |
| `--size total\|each` | Aggregate-only output (default: per-folder table) |
| `-r, --recursive` | Also look INSIDE found `node_modules` — nested entries are listed flagged and never counted twice in totals |
| `--pm <family>` | Keep only entries detected as `npm\|pnpm\|yarn\|bun\|vp`; bare `--pm` just lists what was detected |
| `--exclude <globs>` | Drop matching paths from results and traversal (comma list, e.g. `**/e2e/**`) |
| `--keep <pkgs>` | Refuse to delete the `node_modules` of these projects (comma list, glob ok) |
| `--depth <n>` | Hard cap on discovery depth (levels below the target) |
| `--expand` | Full absolute paths in output |
| `--search <pattern>` | Same as the `search` command, mixed into any read-only form (`nmh --dir=X --search lodash`) |
| `-m, --map [--tree]` | Project map table; `--tree` lists package names per project |
| `--depend [pkg]` | With `map`: show declared deps per project; with a value, list which projects declare it |
| `--json` | Machine-readable output (pipe into `jq`) |
| `-q/--quiet`, `--verbose`, `--no-color` | Output control |

### Example

```bash
$ nmh scan ./my-repo
┌──────────────────────────────────────┬──────────┬──────┬──────┐
│ Path                                 │ Size     │ Pkgs │ PM   │
├──────────────────────────────────────┼──────────┼──────┼──────┤
│ ./packages/web/node_modules          │ 1.20 GB  │ 1843 │ pnpm │
│ ./packages/api/node_modules          │ 640 MB   │ 912  │ npm  │
└──────────────────────────────────────┴──────────┴──────┴──────┘
💾 Total: 2.41 GB across 12 folder(s), 4820 packages

$ nmh --dir=./my-repo/packages/*/node_modules --delete=hard --dry-run
[DRY RUN] Would DELETE (permanent) 12 folder(s) (2.4 GB):
  ✗ ./packages/web/node_modules (1.2 GB, pnpm)
  …
Run again without --dry-run to execute.
```

## Safety first (the whole point)

- **Guards refuse to delete** (exit code `3`): the filesystem root, `$HOME` itself, anything not named exactly `node_modules`, and targets with unresolvable paths (symlink loops).
- **pnpm-safe accounting & deletion**: symlinks are never followed when measuring (`lstat` discipline), never followed when deleting (`fs.rm(rm recursive, force)` unlinks links — the pnpm link farm and virtual store die together, nothing outside the target is touched).
- **`--dry-run` exists** and is the safe default when running from a non-interactive shell without `--yes` — in that case nmh refuses to execute (it is a CLI misuse, exit `1`), it never hangs waiting for input.
- **Recovery log**: every verified delete writes `~/.nmh/logs/delete-<timestamp>.json` (mode, paths, sizes, failures) so discoveries can be traced/undone manually.
- **Trash by default**: wizard pre-highlights `trash`; `soft` is an alias of `trash`.
- **Windows EPERM**: `fs.rm` retries 3× with backoff before reporting a failure.

### Trash backends

| Platform | Backend |
| --- | --- |
| Linux | `gio trash` (gvfs) → `trash-put` (trash-cli) → honest error if neither exists (never silently falls back to hard delete) |
| macOS | Finder via `osascript` |
| Windows | Recycle Bin via PowerShell (`Microsoft.VisualBasic.FileIO`) |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success (incl. dry-run, cancelled) |
| `1` | general / usage error (e.g. non-TTY without `--yes`) |
| `2` | no `node_modules` targets found |
| `3` | safety guard refused |
| `4` | permission denied somewhere (results still listed) |

## Package-manager detection (mirrors Vite+)

Nearest-evidence-first, ordered like the [`vp`](https://viteplus.dev/guide/install) wrapper does it:

1. `packageManager` field in `package.json`
2. `devEngines.packageManager` field
3. lockfiles: `pnpm-workspace.yaml`/`pnpm-lock.yaml` → pnpm, `yarn.lock`/`.yarnrc.yml` → yarn, `package-lock.json` → npm, `bun.lock`/`bun.lockb` → bun
4. nothing conclusive → `unknown` (shown as `—`; nmh never guesses for deletion)

A `vp`-scoped project tags the underlying manager as `pnpm [vp]` / `npm [vp]` (etc.); the node_modules layout and cleanup strategy are always the underlying PM's. Filter such projects with `--pm vp`.

## Monorepo-aware extras (v0.2)

```bash
$ nmh search lodash ./my-repo
🔍 'lodash' → 2 package(s) in 1 node_modules

./my-repo/packages/web/node_modules · pnpm · 1.20 GB
   • lodash@4.17.21 528.0 KB

$ nmh map ./my-repo
┌─────────┬────────────┬─────────┬─────────┬──────────┐
│ Project │ PM         │ Size    │ TopPkgs │ Declared │
├─────────┼────────────┼─────────┼─────────┼──────────┤
│ web     │ pnpm [vp]  │ 1.20 GB │ 1843    │ 42       │
│ api     │ npm        │ 640 MB  │ 912     │ 18       │
└─────────┴────────────┴─────────┴─────────┴──────────┘

$ nmh map ./my-repo --tree          # package names per project
$ nmh map ./my-repo --depend vite   # who declares vite? (declared level)
```

## Roadmap

v0.1 shipped the MVP (scan · size · delete · wizard · guards · PM detection). v0.2 adds **search, map, `--depend`, `-r` recursive audit and the `--pm` / `--exclude` / `--keep` / `--depth` / `--expand` filters**. Still ahead per [PROPOSAL.md](./PROPOSAL.md): `stats` analysis suite (dup factor, waste size, scores, licenses), per-package size breakdown in tree, global installs, config file, report export.

## Development

```bash
npm ci
npm test        # build + vitest (unit + e2e through the real CLI binary)
npm run typecheck
npm run build
```

CI runs the full suite on Linux/macOS/Windows × Node 18/20/24.

## License

[MIT](./LICENSE) — node-modules-hunter contributors.
