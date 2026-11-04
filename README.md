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
nmh                                # interactive wizard: arrow menu (delete all / pick / search / map / report / settings)
nmh wizard --dir=./a,./b           # v1.2: the wizard on explicit targets (skips the auto-climb)
nmh wizard -- stats --dir=./a      # v1.2: open a read-only view first, then the wizard menu
nmh <path> [path…]                 # shortcut: scan given path(s)
nmh scan [dir]                     # full scan (default: cwd)
nmh clean [dir]                    # scan + delete everything safe (trash by default)
nmh search <pattern> [dir…]        # find installed packages by name (+ versions & sizes)
nmh map [dir]                      # project → PM → size → top packages → declared deps
nmh stats [dir]                    # size analytics: dup factor, waste size, top-N, per-package tree
nmh stats --by type [dir]          # breakdown per dependency field (dep/dev/optional/peer/transitive)
nmh stats --licenses [dir]         # license buckets (+⚠ copyleft inside production deps)
nmh stats --score / --co2          # experimental: composite bloat score 0-100 / rough CO2 estimate
nmh stats --online [dir]           # deprecated scan: offline manifests + lazy cached registry fallback
nmh stats --graph [dir]            # dependency graph from the project lockfile — npm/yarn/pnpm/bun, no deps
nmh stats --reinstall [dir]        # naive npm-ci-style "how long to reinstall everything" estimate
nmh stats -g                       # global installs across npm/pnpm/yarn/bun — read-only analysis
# aliases: `analyze` and `info` behave exactly like `stats` (recognition from PRD-era names)
nmh why <pkg> [dir…]               # reverse depend: where is <pkg> and what requires it — read-only
nmh treemap [dir]                  # single-file interactive HTML treemap → nmh-treemap.html
nmh update --check                 # v1.2: compare installed vs registry — nothing installs
nmh update --info                  # v1.2: full registry detail (npm view style)
nmh update -y                      # install the newer version without asking (-n declines, --force skips the ask)

nmh --dir=A,B,glob/*/node_modules  # targets: comma list, globs, ~ — combine with flags below
nmh version | --version | -v        # banner: tool version, node+abi, OS/arch/kernel distro, tty — --json for plain fields
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
| `--stale <days>` | **v1.1** — keep only projects idle ≥ N days; activity signal = newest of last git commit → nearest `package.json` mtime → folder mtime; rows without a signal are dropped in stale runs. Works on `scan`, `clean`, and the `--delete` one-liner — e.g. `nmh . --stale=90 --delete=trash -y` buries the boneyard |
| `--fast-size` | **v1.1** — measure with one `du -sk` per entry (KiB granularity, sizes are multiples of 1024) instead of walking every file; entries `du` can't handle fall back silently to the exact walker (Windows has no `du`, so it always walks). Hardlinks dedupe within a single entry only |
| `--sort size\|path\|idle\|mtime` | **v1.1** — result order: size (default, desc), path, idle (oldest project first — turns the activity probe on even without `--stale`), mtime (newest first) |
| `--no-skip` | **v1.1** — stop hiding system noise during discovery: `.Trash*`, `Library/`, and `*.app` dirs are skipped by default (`.git` stays skipped always); this flag restores the bare full-tree audit |
| `--trash system\|nmh` | **v1.1** — which trash takes victims in trash mode: `system` (default: gio / Finder / Recycle Bin — honest error when absent) or `nmh` (restorable `~/.nmh/trash/<batch>/` + `manifest.jsonl` recording original paths). When the system facility is missing, nmh now falls back to its own restorable trash **loudly** instead of refusing |
| `-r, --recursive` | Also look INSIDE found `node_modules` — nested entries are listed flagged and never counted twice in totals |
| `--pm <family>` | Keep only entries detected as `npm\|pnpm\|yarn\|bun\|vp`; bare `--pm` just lists what was detected |
| `--exclude <globs>` | Drop matching paths from results and traversal (comma list, e.g. `**/e2e/**`) |
| `--keep <pkgs>` | Refuse to delete the `node_modules` of these projects (comma list, glob ok) |
| `--depth <n>` | Hard cap on discovery depth (levels below the target) |
| `--expand` | Full absolute paths in output |
| `--search <pattern>` | Same as the `search` command, mixed into any read-only form (`nmh --dir=X --search lodash`) |
| `-m, --map [--tree]` | Project map table; `--tree` lists package names per project |
| `--depend [pkg]` | With `map`: show declared deps per project; with a value, list which projects declare it |
| `--stats` | Size analytics: instances vs unique names, duplication factor, dedupable waste, top-N list |
| `--tree` / `--top <n>` / `--by size\|type\|licenses` | With `stats`: per-package size tree / row count (default 10) / breakdown mode — package sizes, the declaring dep-field breakdown (`type`), or license buckets (`licenses`: historical field shapes normalized, `unknown` last, ⚠ copyleft in production deps) |
| `-g, --global` | With `stats`: analyze the global installs of npm/pnpm/yarn/bun (per-PM prefix scan, cross-PM duplicates, dead bin symlinks — read-only) |
| `--save-baseline <name>` / `--compare <name>` / `--history` | With `stats`: snapshot totals+per-package to `~/.nmh/baselines/<name>.json`, diff a later run against it (totals, per-node_modules tree, package movers, >30% growth warning), or just list snapshots |
| `--why <pkg>` | Same as the `why` command, mixed into any read-only form |
| `--phantom` / `--dead` | With `stats`: best-effort regex audit — imports declared nowhere / declared+installed packages nobody imports |
| `--score` / `--co2` / `--licenses` / `--online` | With `stats` (focused views): experimental bloat score 0–100 (waste % + dup factor + dead % + size, grade A–F) / rough CO2 estimate (g CO2e per GB-year + per redownload) / license buckets with copyleft flag / deprecated check (offline manifests + lazy cached registry fallback for missing notes) |
| `--graph` | With `stats` (focused view): dependency graph from the project lockfile — npm `package-lock.json` v2/v3, `yarn.lock` v1, `pnpm-lock.yaml`, `bun.lock` (zero new dependencies); edges + BFS depth histogram; unusable lockfiles stay honestly manifest-grade. Also powers `nmh why` (lockfile-grade required-by) |
| `--save-report <file>` / `--report <file>` | `scan`, `map`, `search`, `stats`: **also** write the printed report to a file — format picked by extension `.json` / `.md` / `.txt` (write failure = warning, exit unchanged) |
| `--treemap [file]` / `--out <file>` | `nmh treemap <dirs>`: export one self-contained interactive HTML treemap (default `nmh-treemap.html`); `--json` prints the raw data instead |
| `--reinstall` | With `stats` (focused view): naive npm-ci-style estimate of how long re-installing everything takes (pkg × 60 ms + bytes / 50 MB/s + 3 s per native-family build); assumptions surfaced in the JSON, labeled naif |
| `--animate` / `--no-animate` | Spinning braille loader while measuring (time-driven — rotates on its own, v1.1.1): auto = real TTY only, `--animate` forces it even when piped; always suppressed under `--json`; `.nmhrc animate:false` mutes it |
| `--update-check` | Opt-in: peek npm for a newer release (non-blocking, 24 h cache, notice on stderr; also `updateCheck` in `.nmhrc`) |
| `--config <file>` | Use this config file instead of the `.nmhrc` lookup (cwd → `$HOME`) |
| `--language <lang>` | **v1.3** — UI language: `en` \| `id` \| `zh` \| `ru` \| `es`; also via `.nmhrc` `language` and `NMH_LANG` (see [UI language](#ui-language-v130--i18n)) |
| `--json` | Machine-readable output (pipe into `jq`) |
| `-q/--quiet`, `--verbose`, `--no-color` | Output control — ANSI colors paint only on a real TTY, or with explicit opt-in (`--color` / `FORCE_COLOR`); pipes & CI get plain text by default, `--no-color`/`NO_COLOR` always win (v1.1.1) |

The `.nmhrc` lookup walks every ancestor from cwd up to `$HOME` — and it honors `logDir`, the directory where delete recovery logs are written. Only keep a `.nmhrc` in directories you control: in a shared checkout, a parent directory you don't own could steer your recovery logs and scan defaults; when in doubt, pass an explicit `--config`.

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

### Size analytics (v0.3)

```bash
$ nmh stats ./my-repo
📊 nmh stats — 2 node_modules · dedup potential detected

━━━ OVERVIEW ━━━
Total size        : 11.4 KB across 2 node_modules
Packages          : 4 instances / 3 unique (dup 1.3×)
Waste (dedupable) : 3.7 KB (32.9% of package sizes)

━━━ TOP 10 SIZE ━━━
 1. lodash  ×2 copies  7.7 KB   ← dedup bisa hemat 3.7 KB
 2. moment  ×1 copy  2.5 KB

$ nmh stats ./my-repo --tree        # per-package sizes inside each node_modules (PM column: — = unknown)
web · ./web/node_modules · — · 6.4 KB
  ├─ lodash@4.17.21 (3.9 KB)
  └─ moment@2.29.4 (2.5 KB)

$ nmh stats -g                      # every global install, per package manager
🌐 nmh stats — global installation analysis
(⚠️ global mode — read-only; needs access to the PM prefixes — sudo is never auto-applied)

PM detected      : npm  (not found: pnpm, yarn, bun)
Total global     : 2 packages — 11.8 KB

┌────────────┬─────────┬────────┬─────┐
│ Package    │ Version │ Size   │ PM  │
├────────────┼─────────┼────────┼─────┤
│ @acme/beta │ 2.3.4   │ 3.0 KB │ npm │
│ alpha      │ 1.0.0   │ 8.8 KB │ npm │
└────────────┴─────────┴────────┴─────┘
⚠ dead globals in npm: 1 (broken/missing bin symlink)
  - alpha → alpha (missing bin symlink)
```

Stats rank the same package across many `node_modules` folders, so `dupFactor` grows with copies; "waste" counts only **exact-same-version** duplicates minus one copy each (never mind-measured, symlink-safe). `stats -g` discovers each PM's real global prefix (`npm root -g`, `pnpm root -g`, `yarn global dir`, `bun pm -g` with fallback paths), stays top-level-only and read-only, and flags packages whose declared `bin` commands are missing/broken in the global bin dir.

```bash
$ nmh scan ./my-repo --save-report report.md   # table on screen + file copy (also --report, .json/.md/.txt)
ℹ 💾 report saved → report.md (md)
```

### Analytics deep-cut & audits (v0.4)

**Baseline & compare** — snapshot a repo before a big refactor, diff after:

```bash
$ nmh stats ./my-repo --save-baseline before        # → ~/.nmh/baselines/before.json
$ … dikerjain nanti …
$ nmh stats ./my-repo --compare before
━━━ BASELINE COMPARE ━━━
Baseline         : 'before' saved 2026-10-22T03:33:15.875Z
Total size       : +2.4 KB (+44.8%) — was 5.4 KB, now 7.9 KB
Packages         : ±0 B
┌──────────────────┬────────┬────────┬─────────┐
│ Path             │ Before │ Now    │ Δ       │
├──────────────────┼────────┼────────┼─────────┤
│ api/node_modules │ 2.5 KB │ 4.9 KB │ +2.4 KB │
└──────────────────┴────────┴────────┴─────────┘

Package movers   :
 1. lodash  +2.4 KB
🚨 bloat growth detected — node_modules grew by more than 30% since the baseline

$ nmh stats --history               # list saved baselines (newest first) — no scan
```

**Dedup suggestion** — per-copy attribution so the waste number becomes actionable:

```
━━━ DEDUP SUGGESTION ━━━
 1. lodash@4.17.21  ×2 copies  +3.0 KB bisa hemat
    · ./web/node_modules  · 3.9 KB · web declared ^4.17.0 (dependencies)
    · ./api/node_modules  · 3.0 KB · api declared ^4.17.21 (devDependencies)
    ↳ range declared beda (^4.17.0 vs ^4.17.21) — samakan dulu di package.json, lalu install ulang
```

Identical ranges get the hoist/dedupe hint (`npm dedupe` / `yarn dedupe`, pnpm virtual store), mixed ranges get the align-first warning, undeclared copies get the honest transitive note. Symlinked copies never count as a dedupable copy.

**`nmh why <pkg>`** — reverse depend at manifest level:

```
$ nmh why lodash ./my-repo
🔍 why 'lodash' — 1 instance(s)

./web/node_modules · lodash@4.17.21 · 3.9 KB
  project              : web declares ^4.17.21 (dependencies)
  required by          : 1 package(s)
    · express@4.19.2 → ^4.17.0 (dependencies)
```

Required-by uses only each sibling's **own manifest** (no ancestor climb, so a project declaring lodash is never attributed to innocent siblings); orphan copies say so; symlinked copies show as `linked` without a size.

**`--by type` / `--phantom` / `--dead`** — the dependency-field breakdown plus the regex audit:

```
━━━ BY TYPE ━━━
dependencies          : 2.0 KB · 1 pkg
devDependencies       : 1.5 KB · 1 pkg
peerDependencies      : 437 B · 1 pkg
transitive            : 735 B · 1 pkg

━━━ DEPS AUDIT ━━━
· best-effort regex scan — 1 source file(s) (lockfile graph lands later)
🧟 phantom imports — imported in code, declared nowhere (1)
  · chalk — src/index.ts
🪦 dead declarations — installed + declared, never imported (1)
  · unused — web (dependencies)
```

Only bare package specifiers count (`node:fs`, `./util`, `#alias` skipped; subpaths folded to the package name); `peerDependencies` never count as dead; both audits are honest best-effort, lockfile-grade graphs land later. All of this is stats-family state: read-only, and combining any of it with `--delete`/`clean` is refused (exit 1).

```bash
$ nmh stats ./my-repo --update-check   # opt-in npm peek, 24 h cache
ℹ update tersedia: 0.4.0 → 0.5.0 — npm i -g node-modules-hunter (…)
```

### Vision & hygiene extras (v0.5)

**License scan** — every installed instance gets bucketed by its manifest `license` field (all historical shapes normalized: string, `{type}`, `[{type}]`); the `unknown` bucket lands last, and copyleft families (GPL/AGPL/LGPL/MPL) get a ⚠ only when they ship inside production dependencies:

```bash
$ nmh stats ./my-repo --licenses          # (= --by licenses)
━━━ LICENSES ━━━
MIT                     : 8.1 MB · 42 pkg
Apache-2.0              : 2.0 MB · 11 pkg
GPL-3.0-or-later        : 401 B · 1 pkg  ⚠ copyleft di production dependencies
unknown                 : 41 B · 1 pkg
```

**Bloat Score & CO2** (experimental per decision #6) — one offline number for "how bloated is this folder" (waste % dominates at 40 pt, dup factor 20, dead declarations 20, absolute size vs 512 MB 20; grades A–F at 20-point steps), plus a clearly-labeled rough carbon estimate (~2 g CO2e per GB idle-year stored, ~10 g per GB redownloaded; small sizes stay honest to the third decimal):

```bash
$ nmh stats ./my-repo --score --co2
━━━ BLOAT SCORE ━━━ (experimental)
 20 / 100  grade B  [████░░░░░░░░░░░░░░░░]
waste  0%  → 0 pt
dup factor  1×  → 0 pt
dead  50% (1 pkg)  → 20 pt
size  3.5 MB  → 0 pt
estimasi kasar, bukan audit karbon — simpan setahun: 0.030 g CO2e
kalau men-download ulang semuanya sekali: 0.310 g CO2e
```

The score runs the deps audit implicitly for its deadness component (without printing it — add `--dead` for the actual list).

**Deprecated packages** — `--online` scans the installed manifests **offline first** (npm writes the `deprecated` note into package.json at install time); instances without a local note get a lazy, cached registry lookup — capped at 25 lookups per run, cached 30 days under `~/.nmh/cache/registry-deprecated/`, `NMH_REGISTRY_URL` points elsewhere (mirror/test), and network failures stay silent:

```bash
$ nmh stats ./my-repo --online
━━━ DEPRECATED ━━━
1 instance deprecated:
old-lodash@4.17.19  ./web/node_modules — This version has a prototype pollution bug — please upgrade to 4.17.20+
```

**`nmh treemap`** — one **self-contained interactive HTML** (vanilla JS, zero dependencies, no network): a squarified two-level map (node_modules → top packages) with hover tooltips for path+size; symlinked packages get dashed sliver cells so nothing silently disappears:

```bash
$ nmh treemap ./my-repo                    # → ./nmh-treemap.html
$ nmh treemap ./my-repo --out viz.html     # custom path; nmh treemap . --json = raw data
🗺️ treemap → /abs/nmh-treemap.html — buka di browser, hover cell buat detail
```

**`--save-report` everywhere** — the report export is no longer scan-only: `map`, `search`, and `stats` accept `--save-report`/`--report` with the exact scan semantics (the printed report, format by extension `.json`/`.md`/`.txt`, ANSI stripped for text, write failure = warning and the exit code never changes). `treemap` refuses it — its HTML file IS the report.

### Lockfile graph & reinstall (v0.6)

The dependency graph finally stops being a heuristic. `--graph` parses the project lockfile (**zero new dependencies**): npm `package-lock.json` v2/v3, `yarn.lock` v1 (plus the sibling `package.json` for the root), `pnpm-lock.yaml` via a lockfile-subset mini-YAML parser (v9 `snapshots:` edges, v6 `packages:` edges, peer-suffixed keys reduced to the bare name), and Bun ≥1.2 `bun.lock` (jsonc-flavored text). The first usable lockfile wins (npm → yarn → pnpm → bun); anything outside the known shapes — including the `bun.lockb` binary — is honestly reported as **manifest-grade**:

```bash
$ nmh stats ./my-repo --graph
━━━ GRAPH ━━━ (lockfile-grade)
root direct   : 9 declared → 145 tree nodes via 138 edges
depth  1    : █████████            9
depth  2    : ████████████████████ 39
depth  3    : ████████████████████ 29
+ 54 node(s) unreachable from the root (optional/peer pruning)
· ~/my-repo/node_modules  npm package-lock.json · 145 nodes · 138 edges · direct 9
```

`nmh why` upgrades with it: when a lockfile exists, required-by is **lockfile-grade** — the full transitive requirer set (transitive packages stop being "orphans"), sibling manifests stay the fallback otherwise.

**`--reinstall`** answers the other classic question — "kalau aku copy-paste folder ini ke server baru, berapa lama pasang ulangnya?" — with a deliberately naive model (60 ms/package + flat 50 MB/s + 3 s per native-family build, `sharp`/`grpc`/`better-sqlite3` style proxies) and every assumption surfaced in the JSON:

```bash
$ nmh stats ./my-repo --reinstall
━━━ REINSTALL ━━━ (naif)
pasang ulang semuanya sekali : ~6.7s
· 94 pkg × 60 ms + 50.8 MB / 50 MB/s + 0 native × 3 s
```

### Wizard menu (v0.7 — PRD §7.5, the whole menu; v0.8 auto-scope)

`nmh` with no arguments opens with a compact banner box, quick-scans the cwd (depth 3 — and since v0.8, if nothing is found there, it scopes up once to the nearest manifest ancestor: a project root ≤8 hops away) and offers an arrow-key menu:

| Key | |
| --- | --- |
| 🗑️ Delete everything found | guards run first (blocked targets are surfaced), then trash/hard mode + confirm + guarded execution |
| ☑️ Pick manually | the v0.1 checkbox flow — space to select, then mode + confirm |
| 🔍 Search packages | type a pattern (substring, glob, `/regex/`) — same output as `nmh search` |
| 🗺️ Map dependencies | same project → PM → declared-deps table as `nmh map` |
| 📊 Detailed report | the full `nmh stats` read-out for this tree |
| ⚙️ Settings & integration | the active `.nmhrc` (source path + values) — read-only |
| ⏹ Exit | `esc` also exits |

Read-only items return to the menu; a delete run ends with the freed-space summary and the rescue-log pointer. Non-TTY (piped/CI): no menu — a compact one-line banner + a read-only scan, and `--json` suppresses even that for clean machine output. The v0.8 auto-scope climbs to the nearest project root (package.json / any PM lockfile / `pnpm-workspace.yaml`, ≤8 hops of ancestors — empty manifest dirs are skipped so the monorepo root still wins) and sticks for the whole session; the TTY shows a dim note, non-TTY a warn line, `--json` stays a pure payload.

**Explicit targeting (v1.2)**: `nmh wizard` is a registered command now (same menu as the bare invocation). Give it `--dir=./repo1,./repo2` and the menu runs on those targets as-is — the auto-climb is skipped for explicit scopes. `nmh --wizard` is the flag form. The **`--` router** opens a read-only view before the menu: `nmh wizard -- stats --dir=./repo1` runs the full stats report first (the view segment is parsed by the same dispatcher — all its flags/guards apply, and flags before `--` belong to the wizard), then drops you into the menu. Views: `stats` (aliases `analyze`, `info`), `map`, `search`, `why`, `treemap`. All explicit wizard forms need a TTY — a piped run refuses with exit `1` and directions (the bare `nmh` fallback scan is untouched).

## Safety first (the whole point)

- **Guards refuse to delete** (exit code `3`): the filesystem root, `$HOME` itself, a `node_modules` sitting **directly inside** `/` or `$HOME`, anything not named exactly `node_modules`, and targets with unresolvable paths (symlink loops).
- **pnpm-safe accounting & deletion**: symlinks are never followed when measuring (`lstat` discipline — and `lstat` is also authoritative for file/dir/link classification: some filesystems lie about `d_type`, e.g. Android FUSE reporting hardlinked pnpm-store files as symlinks), never followed when deleting (`fs.rm(rm recursive, force)` unlinks links — the pnpm link farm and virtual store die together, nothing outside the target is touched). Hardlinks inside one entry count once per inode (`du -sb`-style dedupe), so pnpm's multi-linked virtual store is not double-counted.
- **`--dry-run` exists** and is the safe default when running from a non-interactive shell without `--yes` — in that case nmh refuses to execute (it is a CLI misuse, exit `1`), it never hangs waiting for input.
- **`--json` deletes demand explicit consent** (v0.9.2): machine output has no interactive confirm slot, so `--json --delete` without `--yes`/`--force` refuses on any shell — TTY or not (exit `1`, nothing deleted). Since v0.9.1 the non-TTY path was guarded; v0.9.2 closes the same hole for TTY runs (previously a TTY `--json --delete=hard` executed with zero confirmation).
- **Recovery log**: every verified delete writes `~/.nmh/logs/delete-<timestamp>-<suffix>.json` (mode, paths, sizes, failures) so discoveries can be traced/undone manually.
- **Trash by default**: wizard pre-highlights `trash`; `soft` is an alias of `trash`.
- **Windows EPERM**: `fs.rm` retries 3× with backoff before reporting a failure.

### Trash backends

| Platform | Backend |
| --- | --- |
| Linux | `gio trash` (gvfs) → `trash-put` (trash-cli) → honest error if neither exists (never silently falls back to hard delete) |
| macOS | Finder via `osascript` |
| Windows | Recycle Bin via PowerShell (`Microsoft.VisualBasic.FileIO`) |

**Which trash takes the victim?** (v1.1 `--trash=system\|nmh`) `system` (default) uses the platform backends above; `nmh` uses nmh's own restorable trash at `~/.nmh/trash/<batch>/` — a rename-first move (cross-device falls back to a `fs.cp` that does not dereference symlinks) plus a `manifest.jsonl` per victim recording `originalPath` / `storedAs` / `size` / `trashedAt`, so restoring is just moving the folder back. `--trash=nmh` refuses to combine with `--delete=hard` (hard delete is permanent by design). And the v1.0 "honest error" is upgraded: when the system facility is missing, nmh now falls back to its **own restorable trash — loudly** (stderr notice; `backend` / `trashFallback` in `--json`) instead of leaving you with only an error and no victim.

## Stale hunting (v1.1)

The classic question — *which of these `node_modules` can I actually kill?* — is now answered with an activity signal, not just raw size:

- **`--stale <days>`** (works on `scan`, `clean`, and the `--delete` one-liner): keeps only entries idle ≥ N days. The ladder is: last **git commit** of the enclosing project (nearest `.git`, 4s timeout — a project that is still being committed counts as *alive*, even if `npm install` ran yesterday) → nearest **`package.json` mtime** → the `node_modules` folder's own mtime. Entries **without any evidence are dropped** from stale runs, not kept.
- **`--sort size|path|idle|mtime`** reorders results; `idle` (oldest project first) turns the same probe on even without a stale threshold, and every sorted table shows the new **Idle** column. The table also gains a proportional **Share** bar (12 cells, entries with the largest sizes only — nested stores don't compete); bars and columns are table-only, `--json` stays a pure payload.

- **`--fast-size`** swaps the byte-exact walker for one `du -sk` per entry (KiB granularity — sizes are always multiples of 1024); anything `du` can't measure falls back to the exact walker silently. Scan-only knob: delete runs always measure exactly so the freed-bytes number stays honest. Windows has no `du`, so it always walks.
- **Default skip-list flip**: discovery now hides name-based system noise (`.Trash`, `.Trashes`, `.Trash-<uid>`, `Library`, `*.app`) wherever it sits in the tree; pass **`--no-skip`** to restore the bare full-tree v1.0 audit. `.git` stays skipped always (even with `--no-skip`), and direct targets are never filtered — the skip only shapes what discovery finds.
- **`nmh update` is consented (v1.2)**: the plain run shows the facts and asks before installing (`@clack` confirm on a TTY; a piped/`--json` run needs `-y` to install or `-n` to decline — without an answer it refuses with exit `1`, the same protocol as deletes). `--check` is the compact compare for scripts/CI (exit 0 whether or not an update exists, never installs), `--info` is the full `npm view`-style read-out (description, tarball + size + file count, engines, license, publish time), and the two are mutually exclusive. `--force` skips the ask when an update exists — an already-latest install is checked and reported, never blindly reinstalled. Non-npm-global installs keep the honest how-to note. `--json` payload: `{ current, latest, updated, method }` frozen + additive `{ updateAvailable, detail? }`.
- **`--json` stays additive**: new optional keys `idleDays`, `activitySource`, `backend`, `trashBatch`, `trashFallback` appear only when a v1.1 feature is active; every v1.0 payload key is unchanged (the frozen v1.0 contract, extended minor-version-safely).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success (incl. dry-run, cancelled) |
| `1` | general / usage error (e.g. non-TTY or `--json` without `--yes`) |
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

## Config file (.nmhrc)

For settings you always repeat, drop a `.nmhrc` (or `.nmhrc.json`) next to your project or in `$HOME`:

```json
{
  "depth": 4,
  "exclude": ["**/e2e/**", "**/.cache/**"],
  "keep": ["my-fragile-app"],
  "defaultMode": "trash",
  "color": true,
  "animate": false,
  "updateCheck": true,
  "language": "en",
  "logDir": "~/.cache/nmh-logs"
}
```

- Nearest file wins: looks from the current dir up **to** `$HOME` (inclusive), not beyond. When your cwd lives **outside** the home tree, `$HOME/.nmhrc` is still honored as the final fallback (chain first, v1.1.1) — so `nmh config set` works everywhere.
- `--config <file>` replaces the lookup entirely.
- CLI flags always win; `exclude`/`keep` **merge** (config first, CLI appended); `defaultMode` pre-fills a bare `--delete` and the wizard's initial choice; unknown keys are warned about and ignored.
- `--config` isn't a delete-mode switch — deleting still asks permission unless `--yes`/`--force`.

### `nmh config` — manage the file from the CLI (v0.9)

Hand-editing JSON is optional now:

| Command | What it does |
|---|---|
| `nmh config info` | Which file is active (or "none — defaults"), its values, defaults for everything else (`--json` payload works) |
| `nmh config set …` | Write/replace keys — list keys are **replaced whole** |
| `nmh config add …` | Append to a list key (deduped) |
| `nmh config remove …` | Drop listed items; the **bare flag clears the whole list** |
| `nmh config unset …` | Delete keys from the file (back to defaults) |

List keys use self-describing flag names: `--default-exclude` (→ the `exclude` key) and `--default-keep` (→ `keep`). Scalars keep their `.nmhrc` names: `--depth`, `--default-mode`, `--log-dir`, `--animate`, `--color`, `--update-check` (negations like `--no-animate` work).

```bash
nmh config add --default-exclude=.npm,.nvm,self   # the classic homedir silencer
nmh config set --default-exclude=self            # lists replace on set
nmh config set --depth=2 --default-mode=trash
nmh config remove --default-exclude=.nvm         # one item out
nmh config remove --default-exclude              # whole list cleared
nmh config unset --default-exclude --animate     # keys out of the file
```

- Writes go to `$HOME/.nmhrc` by default; `--config <file>` manages that exact file (created when missing).
- Unknown keys already in the file are **preserved on write** (the same tolerance the loader has).
- Validation mirrors the loader: bad values (`--depth=-1`, `--default-mode=bogus`) exit 1 and touch nothing.
- **Special value `self`** in either list is a scan-level guard: entries inside (or exactly at) the folder nmh runs from are dropped before filters, delete pipelines and wizard picks. Point `--dir` wherever you like — run nmh from inside a project and that project refuses to be scanned or deleted wholesale. Works identically via the config file (`"exclude": ["self"]`) and the runtime `--exclude self` / `--keep self`.

## UI language (v1.3.0) — i18n

Every user-facing string — help manual, wizard menus, tables, guards, delete confirmations, `stats` sections — speaks your language. Five locales ship in the binary: **`en`** (default & fallback), **`id`** (Indonesian), **`zh`** (Chinese), **`ru`** (Russian) and **`es`** (Spanish).

Pick one three ways — highest priority first:

```bash
nmh --language es stats          # 1. the CLI flag (wins over everything)
nmh config set --language=id     # 2. persists to .nmhrc ("language" key)
NMH_LANG=ru nmh scan             # 3. the environment (NMH_LANG, then LC_ALL/LANG)
```

- Nothing set (or an unknown value) falls back **silently** to `en` — never a crash, never a half-translated sentence. Invalid `--language` values are refused loudly (exit 1); invalid env values just fall back.
- Output that exists before the language is known (the very first help/version paint, config-load errors) renders English by design; everything after the config read is localized.
- The `--json` payloads and the exit-code table are **language-independent contracts** — keys and codes never change with the locale.
- Grammar of the CLI itself is universal: command names, flags, manifest field names (`dependencies`/`devDependencies`), and technical labels (`runtime`/`system`/`io`) stay as-is in every locale.

## Roadmap

v0.1 shipped the MVP (scan · size · delete · wizard · guards · PM detection). v0.2 added **search, map, `--depend`, `-r` recursive audit and the `--pm` / `--exclude` / `--keep` / `--depth` / `--expand` filters**. v0.3 added the **`stats` suite (dup factor, waste, top-N, per-package tree), `stats -g` global analysis across PMs, report export (`--save-report`/`--report`), `--animate` and the `.nmhrc` config file**. v0.4 added the **analytics deep-cut: baselines (`--save-baseline`/`--compare`/`--history`), dedup suggestions with per-copy declared ranges, `nmh why`, the real `--by type` breakdown, the `--phantom`/`--dead` best-effort import audit and the opt-in `--update-check`**. v0.5 added the **vision & hygiene extras: license scan (`--licenses`/`--by licenses` with the copyleft-in-prod ⚠), the experimental Bloat Score (`--score`) and CO2 estimate (`--co2`), the deprecated check (`--online`, offline manifests + lazy cached registry fallback), the `nmh treemap` single-file HTML export and `--save-report` for map/search/stats**. v0.6 added the **lockfile-grade graph: `--graph` parses npm/yarn/pnpm/bun lockfiles (zero new dependencies) into a real dependency graph with a BFS depth histogram, `nmh why` upgrades to lockfile-grade required-by (transitive requirers, no more false "orphans"), and `--reinstall` estimates the npm-ci-style reinstall time**. v0.7 added the **full PRD §7.5 wizard menu (delete all / pick / search / map / detailed report / settings, with loop-backs), a serious banner box (TTY) + compact one-liner (non-TTY, `--json`-clean), and a richer `nmh version` (node + abi + OS/arch/kernel + tty, `--json`)**. The v0.7.1 patch re-scheduled the folder walker to a slot-per-readdir work queue: the old recursive limiter could deadlock (circular wait) on wide bushy trees like a 12-package pnpm workspace — freezing the scan with **zero output and exit code 0 mid-walk**. Trees of that shape are covered by a regression test now. The same patch hardened measurement: children are classified with `fs.lstat` instead of dirent `d_type`, because some filesystems (Android FUSE/sdcardfs) misreport hardlinked pnpm-store files as symlinks — one `typescript/lib` dir had 112 of 125 dirents lying, which made a whole pnpm virtual store measure 650 KB while `du` saw 66 MB — and entry sizes now dedupe hardlinks per entry (`du -sb`-style), keeping walk numbers in line with `du` (91 → 63 MB on the same tree). v0.8 makes the no-arg wizard scope-aware: when the cwd has no node_modules within depth 3, it climbs once to the nearest manifest ancestor (package.json, any PM lockfile, or `pnpm-workspace.yaml`, ≤8 hops — empty manifest dirs are skipped so the monorepo root still wins) and the whole menu runs there; the scope is frozen for the session (rescans never re-climb), a TTY note reveals the lift, non-TTY gets a warn line, and `--json` stays a pure payload. The v0.9 minor introduces **`nmh config` (info · set · add · remove · unset)** — manage the `.nmhrc` from the CLI instead of hand-editing JSON (`--default-exclude`/`--default-keep` list discipline with dedupe and clear, loader-grade validation, unknown-key preservation on write, `$HOME/.nmhrc` default target) — and the **`self` token** for `exclude`/`keep`: a scan-level guard that drops every entry inside the folder nmh runs from, wholesale, whatever target you point at (your own project can never be hunted by accident). v0.9.1 is a **live-audit hardening patch**: a scripted fixture farm × ~140 invoked combination runs surfaced five defects that are now fixed — delete guards additionally refuse a `node_modules` sitting *directly inside* `/` or `$HOME` (previously a `--dir ~ --delete -y` could sweep it away), the wizard's non-TTY fallback scan now honors `exclude`/`keep` from config and flags, a bare `--depth` failure message no longer swallows the value into `true`, the `--depend` guard messages are reconciled as map-only with actionable hints, and a failed `treemap --out` write exits 1 with a friendly 🛑 instead of a raw errno string. Audited-and-confirmed-as-designed along the way: positional targets are never comma-split (only `--dir` is), `--save-report` write failures warn and keep the exit code, `nmh search` matches top-level package names per PRD §7.3, and `nmh why` takes pkg-first arguments. v0.9.2 is an **independent-review hardening patch**: it closes the biggest hole the v0.9.1 audit missed — a TTY `--json --delete` used to execute with **zero confirmation** (machine output has no interactive prompt slot, and the non-TTY guard didn't cover the TTY branch; a pseudo-TTY reproduction proved rc=0 with the victim gone) — now `--json --delete` requires `--yes`/`--force` on every shell, TTY included. The same pass fixed the config family under `--quiet --json` (its payload was the one survivor the sweep missed — printed empty with rc 0), turned a silent bare/multi `--size` into a loud usage error like its sibling guards, and cleaned the last 10 pre-existing `tsc` errors (a leftover `depth` sentinel union) so `npm run typecheck` is finally clean. v0.9.3 is a **no-behavior-change cleanliness patch** from the same review: six dead symbols removed (`measurePackageRefs`, `SizedPackageRef`, `readLicense`, `listHasSelf`, `isVerbose`, `formatCount`), the write-only `MeasureProgress.currentEntry` field dropped, the twin `DepsAudit` interfaces collapsed to one canonical definition (re-exported from `core/result.ts`), the `self` guard moved to its semantic home (`core/guards.ts`), `ConfigError` now carries a machine-readable `code` instead of message string-matching, scan's private report writer now shares `writeReportSnapshot` with map/search/stats, the `analyze`/`info` stats aliases are documented, and `npm run typecheck` stays at zero errors. v0.9.4 is a **hardening patch for the review findings that change data/behavior**: `stripJsonC` is now fully quote-aware (a trailing comma inside a string value is no longer eaten — silent corruption fixed), `makeGlobMatcher` caps pathological patterns (512 chars / 8 `**`) up front, a delete op aimed at `/` refuses before scanning, the deprecated `truncated` flag means "a 201st item was refused" instead of "exactly at the cap", recovery logs get a random suffix (no same-millisecond overwrites), deprecated notes are ANSI-stripped at the source, `nmh why` reads its manifests/locks with bounded concurrency of 4, the `$HOME` guard ignores letter-case on macOS, the `.nmhrc` ancestor trust is documented in the README, and the self-guard-vs-symlinked-cwd claim is verified as a non-issue (Node resolves `process.cwd()` physically). v1.0.0 is the **stable-API release**: every `--json` payload is a frozen contract guarded by the 245-test suite, the exit-code table (0/1/2/3/4) is locked, `npm run typecheck` and `npm audit` are both clean, and the package ships to npm with a `v1.0.0` git tag once the remote is configured. v1.1.0 is the **stale-hunting edition**: `--stale <days>` grades entries by newest-of git commit → manifest mtime → folder mtime and drops no-evidence stragglers, `--fast-size` measures with `du -sk` (exact-walker fallback), results gain an `Idle` column, a proportional Share bar and `--sort size|path|idle|mtime`, discovery hides system noise by default (`--no-skip` restores the bare audit), `nmh update` self-updates npm-global installs, and `--trash=system|nmh` picks the backend with a restorable `~/.nmh/trash` fallback — all with zero new dependencies and additive-only JSON keys, guarded by the 267-test suite. The v1.1.1 patch is a **polish-and-hardening pass driven by three user reports and a full live-exercise matrix** (26 sandbox fixtures × 223 real combinations): the measuring loader is a **time-driven spinner** (braille frames rotate on their own timer at 70 ms instead of per-update repaints, spinning on TTY, silent in pipes unless `--animate on`), `nmh help` renders a **complete manual** (own renderer — 14 commands + 5 stats subcommand views + grouped options + examples + the safety/exit footer, and the previously-missing `-h`/`--help`/`-v`/`--version` aliases finally work instead of slipping into the default scan), and ANSI colors are **TTY-only by design** (picocolors' `!!env.CI` guess had painted unknown escape bytes into piped GitHub Actions output and shredded substring assertions — CI is 9/9 green for the first time; local color comes from a real TTY or explicit `--color`/`FORCE_COLOR`). The same matrix surfaced two defects the suite had missed: an unknown first word (`nmh scanx`) used to fall through to a silent full-cwd scan with exit 0 — any non-path, non-command token is now a loud usage error (and a bare cwd-relative dir like `nmh node_modules` now correctly targets that folder); and `nmh config set` wrote `$HOME/.nmhrc` while scans walked cwd → `/` and never read it when the cwd lived outside the home tree — the home file is now the documented fallback (chain first). Meanwhile `os.homedir()` on Windows reads `USERPROFILE` (test helper pins both), `execFile('npm')` needs `shell: true` on win32 (`stats -g` exited 2 there), and system-trash-dependent flows run hermetically via `nmh trash` fallback. Suite: 44 files / 279 tests green. v1.2.0 is the **consent-and-targeting edition**: `nmh update` stops installing on faith — the plain run shows the facts and asks (`-y`/`-n` on pipes, `--force` to skip the ask, and an already-latest install is never reinstalled), while `--check` and `--info` are read-only registry views (compact compare vs full `npm view` detail, mutually exclusive); and the wizard becomes a first-class command — `nmh wizard --dir=./a,./b` scopes the menu to explicit targets (no auto-climb), `nmh --wizard` is the flag form, and the `--` router (`nmh wizard -- stats --dir=./a`) opens a read-only view through the full dispatcher before the menu; pipes refuse every explicit wizard form with exit 1 and directions while the bare `nmh` fallback scan stays untouched. The update messages were also unified to Indonesian (the smoke matrix caught `--check` speaking English next to an Indonesian default). Suite: 46 files / 295 tests green. The v1.2.1 hotfix repairs what the wild caught the same day: modern npm prints `npm view <pkg> --json` as an **abbreviated packument array** (no top-level `version` key), which made every `nmh update` flavor exit "cannot read the latest version" — version detection is back on the plain-text `npm view <pkg> version` spawn, the `--info` detail is a separate best-effort fetch with shape normalization (array / object / garbage all tolerated — facts minus detail, never a failed run), and the new `NMH_UPDATE_VIEW_JSON` seam keeps both shapes hermetically testable. Suite: 46 files / 296 tests green. v1.3.0 is the **full-i18n edition**: the CLI now speaks five languages — `en` (default & fallback), `id`, `zh`, `ru`, `es` — through a single catalog (`t(key, params)` in `src/i18n/`, `{placeholder}` interpolation, zero hard-coded user-facing strings left in `src/` outside the i18n module, help manual / wizard menus / table headers / guard & delete messages / treemap HTML included). The language resolves as `--language` > `.nmhrc` `language` key > `NMH_LANG` > `LC_ALL`/`LANG` > `en` (unknown flag values refused loudly with exit 1, unknown env values fall back to `en` silently), a CI completeness gate keeps every locale's key set and `{placeholder}` slots 1:1 with the English source, and both frozen contracts — `--json` payload keys and the exit-code table — are language-independent. Suite: 48 files / 315 tests green.

## Development

```bash
npm ci
npm test        # build + vitest (unit + e2e through the real CLI binary)
npm run typecheck
npm run build
```

CI runs the full suite on Linux/macOS/Windows × Node 20/22/24 (the runtime `engines` stays `>=18`).

## License

[MIT](./LICENSE) — node-modules-hunter contributors.
