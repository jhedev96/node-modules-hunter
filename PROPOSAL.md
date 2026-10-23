📦 node-modules-hunter (nmh) — Product Requirement Document

> Version: 0.1.0-draft
Status: Proposal — siap untuk diimplementasikan
Target: CLI tool cross-platform (Linux, macOS, Windows) berbasis Node.js
Bahasa internal komunikasi: bebas (ID/EN campur), dokumen ini ID

---

1. Ringkasan (Executive Summary)

`node-modules-hunter` (bin: `nmh`, alias: `node-modules-hunter`) adalah CLI tool untuk mendeteksi, memetakan, dan membersihkan folder `node_modules` secara cepat dengan satu baris perintah. Masalah yang diselesaikan: `node_modules` sering menggumpal di banyak project/sub-repo, ukurannya absurd (ratusan MB sampai GB), dan pembersihan manual (masuk folder → cek → hapus) sangat memakan waktu.

One-liner value:

```bash
nmh --dir=./my-project,./my-repo/packages/*/node_modules --delete=hard
```

---

2. Problem Statement

1. Developer sering punya banyak repo/project sekaligus; `node_modules` menumpuk dan tidak terlacak.
2. Ukuran `node_modules` tidak proporsional (akibat duplikasi transitive deps, platform binaries, cache).
3. Pembersihan manual rentan salah hapus karena harus cek satu per satu.
4. Monorepo (pnpm/yarn/npm workspaces) punya puluhan `node_modules` tersebar di sub-package.
5. Tools yang ada belum memenuhi: npkill TUI-nya interaktif (kurang scriptable untuk CI), dan belum ada yang satu-perintah, cross-platform, lintas package manager (npm/pnpm/yarn/bun + wrapper vite+), dengan akuntansi symlink yang benar untuk pnpm.

3. Goals & Non-Goals

3.1 Goals (MVP)
- Scan folder untuk menemukan semua `node_modules` (support glob pattern & multi-path).
- Tampilkan ukuran per folder + total.
- Hapus dengan mode `hard` (permanen) dan `soft`/`trash` (ke recycle bin).
- Deteksi package manager otomatis (npm/pnpm/yarn/bun/vp) via lockfile.
- Wizard interaktif saat dijalankan tanpa argumen.
- Search package tertentu di dalam `node_modules`.
- Peta dependensi antar package (`--map`, `--depend`).

3.2 Non-Goals (v1)
- Tidak menghapus global cache package manager (`pnpm store`, `~/.npm`) kecuali via `--global` eksplisit.
- Tidak melakukan install/reinstall dependency.
- Tidak jadi package manager replacement.

---

4. Persona Pengguna

Persona	Kebutuhan utama	
Dev "repo hoarder"	Bersihin 30 repo lama sekali klik	
Monorepo maintainer	Map & audit deps di ratusan sub-package	
CI/DevOps	Bersihin workspace otomatis (non-interactive, `--force --yes`)	
Disk-panic user	Cari folder `node_modules` terbesar, hapus kilat	

---

5. CLI Interface Design

5.1 Nama & alias
- Package: `node-modules-hunter`
- Bin utama: `nmh`
- Bin alias: `node-modules-hunter`, `nm-hunter` (opsional)

5.2 Sintaks umum

```
nmh [command] [target...] [flags]
```

Parser harus toleran: `=` dan spasi keduanya valid (`--dir=./a` == `--dir ./a` == `-d ./a`).

5.3 Commands & Mode Tanpa Flag

Perintah	Deskripsi	
`nmh` (tanpa argumen)	Interactive wizard: scan cwd → tampilkan hasil berurutan by size → user checklist pilih yang mau dihapus → konfirmasi → eksekusi.	
`nmh version` \| `-v` \| `--version`	Print versi tool + versi Node + platform.	
`nmh help` \| `--help` \| `-h` \| `nmh <command> --help`	Help lengkap; help per-subcommand kalau ada.	
`nmh <path>` (positional)	Shortcut: scan + search di `<path>`. Ekuivalen `nmh scan <path>`.	
`nmh scan` \| `--scan` `[dir]`	Scan semua `node_modules` di dalam `dir` (default: cwd).	
`nmh search <pattern>` \| `--search <pattern>`	Cari folder `node_modules` ATAU package terinstall yang namanya match pattern (glob/regex).	
`nmh map` \| `--map` \| `-m` `[dir]`	Petakan struktur package: mana saja `node_modules` yang ada, isinya package apa (top-level + optionally nested).	
`nmh clean` (opsional sugar)	Alias wizard mode "hapus semua yang ketemu di cwd".	

5.4 Flags Lengkap

Flag	Nilai	Deskripsi	
`--dir` \| `-d`	`<path[,path,...]>`	Target direktori. Support: multi-path comma-separated, glob (`./packages/*/node_modules`), `~`.	
`--delete` \| `--d`	`hard` \| `soft` \| `trash`	Mode hapus. `hard` = hapus permanen (`rm -rf` style, via `fs.rm recursive force`). `soft`/`trash` = pindah ke OS trash (pakai lib `trash`). Tanpa nilai = prompt pilih mode.	
`--size`	`total` \| `each` \| `<n>`	Hitung ukuran. `total` = agregat semua target; `each` = per folder (default); `<n>` = top-N terbesar (mis. `--size 10`). Unit otomatis B/KB/MB/GB.	
`--recursive` \| `-r`	boolean	Masuk ke dalam `node_modules` bersarang (node_modules di dalam node_modules) untuk audit ukuran & search. Default: tidak (hanya top-level per project) untuk performa.	
`--pm`	`npm` \| `pnpm` \| `yarn` \| `bun` \| `vp` (vite+)	Filter/filter-by package manager, ditentukan dari folder induk: field `packageManager`/`devEngines.packageManager` atau lockfile (`package-lock.json`, `pnpm-lock.yaml`/`pnpm-workspace.yaml`, `yarn.lock`/`.yarnrc.yml`, `bun.lock`/`bun.lockb`). Proyek ber-wrapper vite+ ditag `[vp]` di atas PM dasarnya. Tanpa nilai: list semua PM yang terdeteksi (read-only).	
`-g` \| `--global`	boolean	Operasi pada install global (mis. global `node_modules`, prefix npm). Memerlukan konfirmasi ekstra; di Windows/UAC & Unix butuh permission — tampilkan instruksi `sudo`/elevated kalau gagal tulis, jangan auto-elevate.	
`--expand`	boolean	Expand jalur hasil map/scan/search menjadi full absolute path + tampilkan detail (size, jumlah package, PM). Relevan di: `scan`, `search`, `map`, `-r`, `-g`, `--pm`.	
`--depend`	boolean	Tampilkan jalur dependensi: package X dipakai oleh siapa saja (hasil parse `package.json` + lockfile, lazy — hanya kalau diminta, karena parsing lockfile berat).	
`--animate`	boolean	Animasi counting-up total size real-time selama scan (spinner + angka naik). Nyala otomatis kalau TTY; fallback diam kalau piped/CI.	
`-f` \| `--force`	boolean	Skip semua konfirmasi interaktif (kecuali guard safety absolut, lihat §6). Wajib dipakai bersama `--yes` di CI, atau `--force` mengimplikasikan `--yes`.	
`-y` \| `--yes`	boolean	Jawab "yes" untuk semua prompt.	
`-q` \| `--quiet`	boolean	Output minimal (hanya hasil akhir / exit code).	
`--verbose`	boolean	Log debug: setiap folder yang dibaca, waktu, dsb.	

5.5 Flag Rekomendasi Tambahan (guaranteed berguna)

Flag	Nilai	Alasan	
`--dry-run`	boolean	Simulasi: tampilkan apa yang akan dihapus tanpa eksekusi. Sangat direkomendasikan untuk fitur delete.	
`--exclude`	`<glob[,glob]>`	Kecualikan path (mis. `--exclude=./node_modules,**/keep-this`).	
`--keep`	`<pkg[,pkg]>`	Jangan hapus `node_modules` milik package tertentu (mis. `--keep=react-native`).	
`--empty`	boolean	Setelah hapus, hapus juga folder induk yang jadi kosong (mis. project lama tanpa source).	
`--depth`	`<n>`	Batas kedalaman scan MURNI: jumlah level direktori di bawah target; `node_modules` hanya ditemukan bila levelnya ≤ n. Semantik traversal tidak berubah — bebas turun ke subfolder, tapi tidak pernah masuk ke dalam `node_modules` yang sudah ditemukan kecuali `-r`. Default: tanpa batas.	
`--json`	boolean	Output JSON (untuk dipipe ke jq / dipakai script lain).	
`--tree`	boolean	Output tree view hasil map (alternatif dari tabel).	
`--report` \| `--save-report`	`<file>`	Simpan hasil scan ke file (md/json/txt).	
`--update-check`	boolean	Cek update tool (non-blocking, cached 24h). Default OFF — opt-in via flag/config.	
`--no-color`	boolean	Matikan ANSI color (otomatis off kalau non-TTY).	
`--stats`	boolean	Jalankan metadata report (lihat §8).	
`--by`	`package` \| `type` \| `size`	Mode breakdown stats.	
`--top`	`<n>`	Top-N entry (default 10).	
`--online`	boolean	Fetch data registry (deprecated, umur paket, license).	
`--score`	boolean	Bloat Score + Health Score.	
`--licenses`	boolean	Detail lisensi per package.	
`--save-baseline` / `--compare` / `--history`	`<name>`	Snapshot & diff histori metadata (lihat §8.3).	
`--why <pkg>`	`<package>`	Reverse depend tree: kenapa package ini terinstall.	
`--config`	`<file>`	Pakai config file kustom (default: `.nmhrc` / `.nmhrc.json` di cwd).	

---

6. Safety & Guardrails (WAJIB — jangan diskip)

1. Konfirmasi sebelum delete, kecuali `--force`/`--yes`. Prompt menampilkan: jumlah folder, total size, daftar top 5 terbesar, dan mode delete.
2. `--dry-run` tersedia di semua operasi destruktif.
3. Hard guard — tool harus refuse (exit code `3`) kalau target:
   - path root filesystem (`/`, `C:\`),
   - `$HOME` / user home root itu sendiri,
   - bukan bernama persis `node_modules` (hindari salah hapus folder lain),
   - hasil resolve path mengandung symlink loop.
4. Symlink handling: `node_modules` berisi symlink (khas pnpm) — hapus symlink-nya saja, jangan ikuti symlink ke luar target. Pakai `lstat`, bukan `stat`.
5. Global ops (`-g`): selalu butuh konfirmasi ganda (meski `--force`), dan tampilkan estimasi size + lokasi sebelum eksekusi.
6. Trash dulu, hard later: default `delete` tanpa nilai di wizard = sarankan `trash` sebagai pilihan aman pertama.
7. Atomic report: tulis log hasil delete ke `~/.nmh/logs/` (opsional via config) — "recovery reference" kalau salah hapus.
8. Exit codes: `0` sukses, `1` error umum, `2` tidak ada target ditemukan, `3` guard safety memblokir, `4` permission denied.

---

7. Core Flow Detail

7.1 Scan flow
1. Resolve target paths (expand glob, `~`, relative → absolute).
2. Walk direktori (respect `--depth`, `--exclude`, skip hidden `.git` content).
3. Untuk tiap `node_modules` ditemukan: `lstat` (skip symlink), hitung size (streaming, jangan load semua file ke memori), deteksi PM dari lockfile sibling.
4. Render tabel: `path | size | packages count | pm | last modified`.
5. Sort default: size descending. `--animate` = tampilkan counter naik selama langkah 3.

7.2 Delete flow
1. Jalankan scan (reuse) → kumpulkan kandidat.
2. Terapkan filter (`--keep`, `--exclude`, `--pm`).
3. `--dry-run`? render tabel "AKAN DIHAPUS" + stop.
4. Konfirmasi (kecuali `-f`/`-y`).
5. Eksekusi: `hard` → `fs.rm(path, {recursive:true, force:true})`; `trash` → lib `trash`. Parallel dengan concurrency limit (mis. 8).
6. Progress bar per folder. Setelah selesai: ringkasan "Freed: X GB from Y folders" (+ animasi counter kalau `--animate`).
7. `--empty`? post-clean pass hapus folder induk kosong.

7.3 Search flow
- Pattern match pada (a) nama folder `node_modules`, (b) nama package di dalamnya (top-level scope + `@org/pkg`).
- `--recursive` untuk cari juga di nested.
- Output: `path → matched packages (+ size)`.
- Contoh: `nmh search lodash --dir=./my-repo` → list semua `node_modules/lodash` + versi (baca `package.json` version-nya, cached).

7.4 Map flow
- Petakan tiap project → PM → top-level deps → size.
- `--depend`: tampilkan siapa yang depend ke siapa (parse `dependencies` dari `package.json` tiap sub-package workspace).
- Output mode: tabel (default), `--tree`, atau `--json`.

7.5 Wizard flow (no-arg)
1. Banner + deteksi cwd.
2. Quick scan (depth 3) + animasi size.
3. Menu interaktif (arrow keys): `Hapus semua` / `Pilih manual (checkbox)` / `Search package` / `Map dependensi` / `Laporan detail` / `Settings`.
4. Eksekusi pilihan + konfirmasi akhir.

---

8. Analisis Metadata & Statistik (`stats` / `analyze`)

Perintah khusus untuk membedah isi `node_modules` secara mendalam — bukan cuma "berapa GB", tapi "kenapa segede ini dan isinya apa aja".

8.1 Command

Perintah	Deskripsi	
`nmh stats [dir]` \| `analyze` \| `info`	Print SEMUA informasi (overview, dup/waste, top size, risk, skor, estimasi) dalam satu laporan lengkap. Tanpa subflag = full report, bukan ringkasan. `--by`/`--top`/dll dipakai untuk memfilter/memfokuskan laporan itu, bukan mengaktifkannya.	
`nmh stats [dir] --by=package`	Breakdown ukuran per package (top 20 + long tail agregat).	
`nmh stats [dir] --by=type`	Breakdown per tipe dep: `dependencies` / `devDependencies` / `optionalDependencies` / `peerDependencies`.	
`nmh stats [dir] --top <n>`	Top-N package terbesar (default 10).	
`nmh stats [dir] --tree` / `--json`	Output tree atau JSON (reuse flag global).	
`nmh stats -g` \| `--global`	Analisis metadata khusus instalasi global saja (bukan project): scan global prefix (npm/pnpm/yarn/bun — auto-detect atau via `--pm`), laporkan semua package global terinstall, size, versi, duplikasi antar-PM, dan dead global packages. Tidak memerlukan `[dir]`. Ikuti aturan permission `-g` di §6.5 (konfirmasi ganda, no auto-elevate).	

Perilaku default `nmh stats [dir]` (penting):
- Tanpa subflag apapun → full report: semua seksi dari §8.2 (overview, top size, dup/waste, risk, skor, estimasi) di-print berurutan, plus highlight anomali paling parah di akhir.
- `--by`, `--top`, `--licenses`, `--phantom`, `--dead` → memfokuskan report (hanya seksi terkait yang diperluas), bukan mematikannya.
- `--animate` → count-up real-time aktif selama analisis: counter ukuran, jumlah paket, dan waste size naik live (bukan cuma di akhir), pakai spinner + angka running. Auto-on kalau TTY, fallback diam kalau piped/CI (reuse perilaku global `--animate`).

8.2 Metadata yang Dikumpulkan

Ukuran & Komposisi
- Total size (sudah ada via `--size`, tapi di sini dibedah): per-package size, median package size, long tail (bottom 50% paket cuma makan berapa %).
- Largest files dalam `node_modules` (top 10 file individual — sering ketemu binary `.node`, sourcemap, atau `.wasm` gede yang nyelip).
- Kategori bloat otomatis: `binary/native`, `sourcemap`, `typescript-declaration`, `test-files-paket`, `documentation`, `cache`.

Package Count & Duplikasi
- Total terinstall (semua instance) vs unique packages (berdasarkan nama+versi).
- Duplication factor = total instance ÷ unique packages.
- Waste size = byte yang bisa dihemat kalau semua versi identik didedup. Ini metrik bintang utama fitur ini — sering kejadian: 40 copy `lodash@4.17.21` di 12 sub-repo.
- Cross-repo duplication (kalau `--dir` multi-target): package X versi sama ada di N repo → potensi hemat Y MB (ini modal fitur "dedup suggestion" di roadmap).

Graf Dependensi
- Total edges dependensi (dari lockfile, fallback parse `package.json` nested kalau lockfile absen).
- Direct vs transitive count: "lo tulis 12 deps di package.json, realitanya keinstall 1.243 paket" — angka klasik yang harusnya selalu ditampilkan.
- Inbound depend (`--depend` diperkaya): siapa depend ke package X (reverse lookup) — `nmh stats --depend lodash` → "dipakai oleh 23 package: web→ui, api→core, ...".
- Depth histogram: berapa paket di depth 1, 2, 3, ... (npm flat vs pnpm nested kelihatan bedanya di sini).
- Hoisting anomalies: package yang di-`import` tapi tidak ada di `package.json` manapun (phantom deps — bug time bomb) + sebaliknya package terinstall tapi tidak dipakai sama sekali (dead deps, deteksi via import scan statis di `src/`, best-effort).

Kualitas & Risiko
- License summary: count per lisensi (MIT, Apache, GPL, unknown/dll) + flag kalau ada GPL di dep graph production deps.
- Deprecated packages: cek field `deprecated` di `package.json` tiap paket + registry check (lazy, `--online` flag, cached).
- Native/binary packages count (`*.node`, prebuild) — patokan seberapa berat reinstall/build.
- Symlink count & virtual store size (pnpm): berapa space yang sebenarnya "hemat" karena hardlink/symlink vs copy fisik.
- Package age: median umur paket, paket terlama tak update (>3 th), paket berumur <30 hari (supply-chain risk flag, `--online`).

Mode Global (`stats -g`)
- Deteksi otomatis global prefix tiap PM yang terinstall (`npm prefix -g`, `pnpm root -g`, `yarn global dir`, `bun pm -g`), atau override via `--pm`.
- Laporan: daftar semua package global (nama, versi, size, PM asal), total size global, dan cross-PM duplication (package yang sama terinstall global di >1 PM → kandidat uninstall).
- Dead global detection (best-effort): package global yang tidak pernah dipanggil sebagai bin (cek symlink di global `bin/` → kalau bin-nya broken/unused, flag kuning).
- Ikuti guard §6.5: `stats -g` read-only tapi tetap tampilkan warning permission — beberapa global prefix mungkin butuh elevated access, dan tool tidak auto-elevate sudo.

Skor & Estimasi (ide liar tapi berguna)
- Bloat Score (0–100): skor komposit `waste% + duplikasi + dead deps% + ukuran/median`. Bikin repos bisa di-rank: `nmh stats --score --dir=./repos/*`.
- Reinstall time estimate: estimasi `npm ci` / `pnpm i` berdasarkan jumlah paket + native binaries + historis (naif dulu: paket/detik rata-rata; bisa makin akurat pakai data sendiri).
- Carbon footprint estimate: GB × faktor konversi cloud storage/transfer (clearly-labeled estimate, `--co2` flag) — gimmick tapi efektif buat bikin tim sadar, wkwk.
- Health Score: gabungan deprecated% + phantom deps + usia paket + lisensi issue.

8.3 Perbandingan & Histori (baseline)

Flag	Deskripsi	
`--save-baseline <name>`	Simpan snapshot metadata ke `~/.nmh/baselines/<name>.json`.	
`--compare <name>`	Bandingkan kondisi sekarang vs baseline → delta size, delta paket, "kenaikan terbesar: +180 MB dari @new-dep".	
`--history`	Tampilkan semua baseline yang tersimpan untuk repo ini (tabel timeline).	

Use case nyata: "abis refactor pake lib baru, node_modules kok nambah 300MB?" → `nmh stats --compare before-refactor`.

8.4 Output Contoh

```bash
$ nmh stats ./my-repo --animate
📊 Analyzing ./my-repo ...
⠋ size 1.02 GB → 1.41 GB → 1.84 GB   ·   packages 1.207 → 2.847   ·   waste 388 MB → 612 MB
✅ Done in 4.1s  (full report dibawah — tanpa subflag, SEMUA seksi di-print)

━━━ OVERVIEW ━━━
Total size        : 1.84 GB
Packages installed: 2.847 instances / 1.102 unique (dup factor 2.6×)
Direct deps       : 24 declared → 2.847 resolved 🚨
Waste (dedupable) : 612 MB (33%)
Native binaries   : 7 packages
Symlinks (pnpm)   : 1.982 links — real disk: 1.84 GB (copy-physical: ~4.2 GB)

━━━ TOP 5 SIZE ━━━
1. @esbuild  x11 copies  142 MB   ← dedup bisa hemat 129 MB
2. typescript x3 copies   96 MB
3. rxjs      x22 copies   88 MB    ← dedup bisa hemat 84 MB
4. lodash    x40 copies   61 MB    ← dedup bisa hemat 59 MB
5. puppeteer x1 copy      58 MB

━━━ RISK ━━━
⚠️  Deprecated  : 3 packages (left-pad@1.x, ...)
⚠️  Phantom deps: 2 imports tanpa package.json entry (classnames di apps/web)
⚠️  Dead deps   : 5 package terinstall tapi tak dipakai (uuid, moment, ...)
ℹ️  Licenses    : MIT 89%, Apache 7%, unknown 3%, GPL 1% (in dev only ✅)
🌱 Est. CO2     : ~0.4 kgCO2e/tahun (cloud storage, rough estimate)

Bloat Score     : 71/100 (⚠️  tinggi — cek dedup suggestion)
Health Score    : 78/100
```

```bash
$ nmh stats -g
🌐 Global installation analysis
(⚠️  global mode — read-only; butuh akses ke prefix PM, sudo tidak auto-dipakai)

PM detected     : npm, pnpm, bun
Total global    : 41 packages — 312 MB
┌──────────────────────┬─────────┬───────┬──────────┐
│ Package              │ Version │ Size  │ PM       │
├──────────────────────┼─────────┼───────┼──────────┤
│ typescript           │ 5.6.2   │ 22 MB │ npm      │
│ @company/internal-cli│ 1.x     │ 18 MB │ npm, bun │ ← duplicated across PM
│ pnpm                 │ 9.x     │ 15 MB │ bun      │
│ eslint               │ 9.x     │ 12 MB │ npm, pnpm│ ← duplicated across PM
└──────────────────────┴─────────┴───────┴──────────┘
⚠️  Cross-PM duplicates : 6 packages (48 MB bisa dihemat — uninstall salah satu)
⚠️  Dead globals        : 3 packages (bin symlink tidak aktif / broken)
```

8.5 Flag Tambahan Khusus Stats

Flag	Nilai	Deskripsi	
`--stats`	boolean	Jalankan laporan stats (alternatif penulisan, bisa digabung flag lain: `nmh scan --stats`).	
`--by`	`package` \| `type` \| `size`	Mode breakdown.	
`--top`	`<n>`	Jumlah entry top-N (default 10).	
`--online`	boolean	Izinkan fetch registry (deprecated check, usia paket, license). Default: offline, pakai data lokal `package.json`.	
`--co2`	boolean	Tampilkan estimasi carbon footprint.	
`--score`	boolean	Hitung Bloat & Health Score (butuh `--online` untuk Health penuh).	
`--save-baseline` / `--compare` / `--history`	`<name>`	Baseline & diff histori (lihat §8.3).	
`--licenses`	boolean	Detail lisensi per package.	
`--phantom` \| `--dead`	boolean	Fokus audit phantom deps / dead deps saja.	
`--animate`	boolean	Count-up real-time selama analisis: size, jumlah paket, waste size naik live dengan spinner (lihat §8.1).	

8.6 Ide Liar (Stretch Goals — opsional, prioritas rendah)

1. `nmh treemap` — export data ukuran jadi file HTML treemap interaktif (single file, vanilla JS, no dep) — jadi lo bisa lihat secara visual siapa makan disk. Sangat satisfying buat demo ke tim.
2. Leaderboard antar repo — `nmh stats --dir=./repos/* --score --json | jq sort` → ranking repo paling bloated di mesin lo. Bisa dijadiin badge "🏆 Repo Tergila 2026".
3. "node_modules horoscope" — easter egg: `nmh stats --horoscope` → meme prediction berdasar komposisi deps ("rxJs 22 copy = lo over-engineer hari ini 🪐"). Pure fun, hidden flag. (Ini beneran ide liar sesuai request 😂)
4. Predictive warning — kalau `--compare` nunjukin kenaikan >30% dalam 30 hari → warning otomatis "🚨 bloat growth detected".
5. `--why <package>` — alias gabungan: print jalur dependensi penuh kenapa package X terinstall ("X ← diinstall oleh Y ← karena Z di devDependencies") — reverse depend tree, jawaban langsung untuk pertanyaan klasik "INI PACKAGE DARI MANA SIH".

9. Package Manager Support Matrix (v1)

PM	Deteksi lockfile	Catatan khusus	
npm	`package-lock.json`	—	
pnpm	`pnpm-lock.yaml`	Struktur `.pnpm` — saat delete, hapus juga `.pnpm` virtual store di folder yang sama; symlink jangan di-follow.	
yarn (v1/berry)	`yarn.lock`	Yarn berry: `.yarn/cache` — flag `--pm yarn` juga report `.yarn` folder.	
bun	`bun.lockb` / `bun.lock`	`bun.lockb` binary — deteksi cukup by filename.	
vp (vite+)	Bukan package manager — *wrapper*. Deteksi: manifest proyek mendeklarasikan `vite-plus` / `@voidzero-dev/vite-plus-core` (dependencies/devDependencies/peerDependencies).	Tag `[vp]` ditempel pada PM dasar yang sah (lockfile/field). Layout node_modules & strategi cleanup selalu milik PM dasar; filter via `--pm vp`.	

Auto-detect: scan sibling lockfile dari `node_modules` yang ketemu. Kalau >1 lockfile → tampilkan semua, beri tag `[multiple]`.

---

10. Config File (`.nmhrc`)

```json
{
  "defaultMode": "trash",
  "depth": 3,
  "exclude": ["**/node_modules/.cache"],
  "keep": [],
  "color": true,
  "animate": true,
  "logDir": "~/.nmh/logs"
}
```

Precedence: CLI flag > config file (paling dekat: dari cwd naik sampai home) > default built-in. Config opsional: tanpa `.nmhrc` semua tetap aman pakai default; `--config <file>` mengganti lokasi lookup.

---

11. Tech Stack Rekomendasi

- Runtime: Node.js >= 18 (native `fs.rm`, `fs/promises`, `path`).
- Bahasa: TypeScript ESM.
- Parsing arg: `cac` atau `commander` (pilih salah satu, konsisten).
- Interaktivitas: `prompts` atau `@clack/prompts` (wizard/checkbox/spinner).
- Trash: `trash` (cross-platform).
- Glob: `fast-glob` atau `tinyglobby`.
- Tabel: `cli-table3` / `consola`.
- Size formatting: custom util (biar ringan) — `1024`-based, 1 desimal.
- Build/publish: `tsup`, publish ke npm dengan bin `nmh` + `node-modules-hunter`.
- Zero-dependency sebisa mungkin untuk core; deps hanya untuk UX (prompts, trash, glob).

---

12. Struktur Proyek (saran)

```
node-modules-hunter/
├── src/
│   ├── cli.ts            # entry, routing command/flag
│   ├── commands/
│   │   ├── scan.ts
│   │   ├── search.ts
│   │   ├── map.ts
│   │   ├── clean.ts
│   │   └── wizard.ts
│   ├── core/
│   │   ├── walker.ts     # directory walk + depth + exclude
│   │   ├── sizer.ts      # streaming size calc + animate events
│   │   ├── deleter.ts    # hard/trash + guards + concurrency
│   │   ├── pm-detect.ts  # lockfile → PM
│   │   ├── guards.ts     # safety checks + exit codes
│   │   └── render.ts     # table/tree/json output
│   └── utils/
├── package.json
└── README.md
```

---

13. Error Handling & Edge Cases

- Permission denied (EACCES): tampilkan path + saran (`sudo` hanya untuk `-g`), lanjut folder lain, exit code `4` di akhir.
- Path tidak ada: error jelas, exit `1`.
- Glob tidak match: warning "no match for pattern X", exit `2`.
- Direktori sibuk/file lock (Windows EPERM): retry 3x dengan backoff, lalu report skip.
- Non-TTY: auto non-interactive — prompt apapun → default aman (`dry-run` untuk delete) + warning.
- Banyak target (1000+ folder): stream output, jangan buffer semua; progress bar wajib.

---

14. UX / Output Contoh

```bash
$ nmh scan ./my-repo --size total --animate
🔍 Scanning ./my-repo ...
⠋ Found 12 node_modules — 2.41 GB
✅ Done in 3.2s

┌──────────────────────────────────────┬──────────┬────────┬──────┐
│ Path                                 │ Size     │ Pkgs   │ PM   │
├──────────────────────────────────────┼──────────┼────────┼──────┤
│ packages/web/node_modules            │ 1.20 GB  │ 1843   │ pnpm │
│ packages/api/node_modules            │ 640 MB   │ 912    │ npm  │
│ apps/mobile/node_modules             │ 511 MB   │ 1204   │ yarn │
└──────────────────────────────────────┴──────────┴────────┴──────┘
💾 Total: 2.41 GB across 12 folders

$ nmh --dir=./my-repo/packages/*/node_modules --delete=hard --dry-run
[DRY RUN] Would DELETE 12 folders (2.41 GB):
  ✗ packages/web/node_modules (1.20 GB, pnpm)
  ✗ packages/api/node_modules (640 MB, npm)
  ...
Run again without --dry-run to execute.
```

---

15. Roadmap

Fase	Fitur	
MVP (v0.1)	scan, size, delete hard/trash, wizard, help/version, guards dasar, npm/pnpm detect	
v0.2	✅ SELESAI — search (+--search), map (+--tree/--depend declared-level), --pm filter semua PM incl. tag [vp], -r recursive audit, --exclude/--keep/--depth/--expand (85 test hijau)	
v0.3	✅ SELESAI — `stats` dasar (rank per-installation Σ size, dup factor instances/unique, waste dedup khusus versi-identik via lower-median, top-N + `--top`, per-package size di `--tree`; `--by type` → v0.4 warning+fallback), `stats -g` global lintas PM (probe `root -g`/`yarn global dir`/`bun pm -g` + fallback path, top-level only + versi, dead bin-symlink check, savings lintas-PM = min size, read-only tanpa elevate), `--save-report`/`--report` (scan-only, `.json`/`.md`/`.txt` by extension, gagal menulis tidak mengubah exit code), `--animate` (auto = hanya TTY, selalu mati di `--json`, config `animate:false`), config `.nmhrc`/`.nmhrc.json` + `--config` (114 test hijau)	
v0.4	✅ SELESAI — baseline & compare (`--save-baseline`/`--compare`/`--history`: snapshot totals + per-package di `~/.nmh/baselines/<name>.json` schema 1, delta total/per-node_modules/`package movers`, warning pertumbuhan >30%, nama divalidasi tanpa path-traversal), dedup suggestion (per-copy: node_modules host + PM + size + manifest project & range per dep-field, hint bijak: range sama → hoist/dedupe, beda → sejajarkan manifest dulu, tanpa deklarasi → transitif; symlink tidak pernah terhitung sebagai copy yang dapat di-dedup), `--why`/`nmh why` (instansi + deklarasi + required-by dari manifest **sendiri** tiap sibiling tanpa nenek moyang; orphan ditandai; linked tanpa size), `--by type` sungguhan (bucket per dep-field terdeklarasi + `transitif`, view terfokus), `--phantom`/`--dead` audit regex (node:/./subpath/@scope dilipat, peer tidak pernah dead, fokus per-flag, JSON membawa keduanya), `--update-check` (opt-in, cache 24 jam, env escape hatch `NMH_REGISTRY_JSON` untuk mirror/test, gagal sunyi tidak mengubah exit code) — level manifest; parser lockfile penuh (pnpm/yaml) → v0.5. 137 test hijau
v0.5	✅ SELESAI — license scan (`--licenses`/`--by licenses` = view terfokus: sumber data field `license` package.json SAJA — semua bentuk bersejarah dinormalisasi string/`{type}`/`[{type}]`, tanpa sniff file LICENSE; bucket `unknown` selalu terakhir; ⚠ copyleft (GPL/AGPL/LGPL/MPL) hanya saat jadi production dependencies; manifest instansi dibaca sekali berbagi dengan versi), Bloat Score `--score` (experimental — komposit offline 0–100: waste%→ maks 40 pt, dup factor→20, dead%→20 (audit `--phantom/--dead` dijalankan implisit untuk komponen dead, tanpa di-print), size/512 MB→20; grade A–F kelipatan 20; komponen eksplisit di JSON), CO2 `--co2` (experimental, clearly-labeled: ~2 g CO2e/GB·tahun simpan, ~10 g/GB redownload; format jujur sampai sub-gram), deprecated check `--online` (offline-first dari field `deprecated` manifest terinstal; yang kosong → registry fallback lazy: unik per name@version, cap 25 fetch/jalan, cache 30 hari `~/.nmh/cache/registry-deprecated/`, env `NMH_REGISTRY_URL` mirror/test, gagal jaringan sunyi), treemap `nmh treemap <dirs>` (1 file HTML self-contained — vanilla JS tanpa dep & tanpa jaringan; squarified dua level node_modules→paket, tooltip hover path+size, symlink = sliver putus-putus; jamin cell tak pernah hilang (sliver ≥0.5px); `--out <file>` default `nmh-treemap.html`, `--json` = data mentah; menolak `--save-report`), `--save-report`/`--report` diperluas ke `map`/`search`/`stats` (semantik identik scan: salin output yang dicetak, format by ekstensi, strip ANSI, gagal tulis = warning, exit code tetap). 178 test hijau
v0.6	✅ SELESAI — graf lockfile grade `--graph` **tanpa dependency runtime baru** (§17 keputusan #20: dispatcher baca satu lockfile npm → yarn v1 → pnpm → bun; `package-lock.json` v2/v3, `yarn.lock` v1 + manifest saudara untuk root, `pnpm-lock.yaml` mini-YAML subset (v9 `snapshots:` edges / v6 `packages:` edges, kunci peer direduksi ke nama), `bun.lock` jsonc-text; `bun.lockb` binary & lockfile pecah/gede >8 MB → manifest-grade jujur; model per nama: edges + BFS depth histogram, workspace/link di-skip, node tanpa jalur dari root = `unreachable`), `nmh why` required-by naik ke grade `lockfile` (requirer transitif ditemukan — transitive bukan lagi "orphan"; field berlabel `lockfile`, fallback sibling-manifest tetap), `--reinstall` (keputusan #21 — naif berlabel jelas: pkg×60 ms + totalSize/50 MB/s + native×3 s proxy 12 keluarga; semua asumsi di JSON). 206 test hijau
v0.7	✅ SELESAI — wizard §7.5 menu lengkap (banner box → quick scan depth 3 → menu panah 7 entri: hapus semua / pilih manual / search / map / laporan detail / settings read-only / keluar; aksi read-only loop kembali ke menu; delete tetap guard → mode → confirm → execute dan keluar dengan ringkasan freed + recovery log; non-TTY: banner satu baris + read-only scan, `--json` menekan banner supaya payload mesin bersih), `nmh version` kaya (tool, node+abi, platform+arch, kernel+distro, stdout-tty; `--json` = payload mesin), banner util tangan sendiri (box-drawing, lebar emoji dihitung 2 sel, nol dependency baru). 213 test hijau
v0.7.1	✅ SELESAI — dua perbaikan keandalan scan. (1) Walker dijadwalkan ulang ke antrean BFS dengan slot per readdir (slot tidak pernah memegang subtree): walker lama bisa DEADLOCK (circular wait: gelombang readdir menghabiskan 16 slot dengan parent yang menunggu anak yang diantrekan di belakangnya → scan berhenti senyap, exit 0, tanpa output) pada tree lebar seperti pnpm workspace 12 package — dilaporkan nyata via `--dir=./soundfx`; regresi test geometri bushy ditambahkan. (2) Klasifikasi anak folder tidak lagi percaya `d_type` dirent: Android FUSE/sdcardfs melabel file hardlink store pnpm sebagai symlink (112 dari 125 dirent di `typescript/lib` salah label — `lstat` membuktikannya file nyata), sehingga seluruh virtual store terukur 650 KB alih-alih ~63 MB; walker/sizer/packages kini memakai `fs.lstat` untuk semua keputusan file/dir/link + sizer mendapat dedupe hardlink ala `du` per entry (inode sama di beberapa path `.pnpm` dihitung sekali: 91 → 63 MB, kini setara `du -sb`). 214 test hijau
v0.8.0	✅ SELESAI — wizard auto-scope: cwd polos (tidak punya node_modules dalam kedalaman 3) naik sekali ke project root terdekat — ancestor ber-manifest (package.json / package-lock.json / npm-shrinkwrap.json / pnpm-lock.yaml / pnpm-workspace.yaml / yarn.lock / bun.lock[b], batas 8 hop; ancestor ber-manifest yang kosong diskip agar monorepo root tetap terjangkau) — lalu seluruh menu & rescan memakai root itu; probe unsized, scope dibekukan sekali per sesi; catatan dim di TTY, peringatan di non-TTY, `--json` tetap payload murni. 216 test hijau
v0.9.0	✅ SELESAI — keluarga `nmh config` (info · set · add · remove · unset) kelola file `.nmhrc` dari CLI tanpa edit-JSON manual: list keys via `--default-exclude`/`--default-keep` (set = ganti penuh, add = append dedupe, remove = buang item / bare flag = kosongkan list, unset = hapus kunci), key skalar `--depth`/`--default-mode`/`--log-dir`/`--animate`/`--color`/`--update-check` (negasi diterima; validasi meniru loader — nilai buruk exit 1 tanpa menyentuh file); target tulis default `$HOME/.nmhrc`, `--config <file>` mengelola file itu khusus (langsung dibuat bila absen), key asing di file **dipertahankan saat tulis** (toleransi loader), `--delete` ditolak di keluarga ini; plus token spesial **`self`** di `exclude`/`keep`: guard level-scan — entry di dalam (atau tepat di) subtree cwd digugurkan sebelum filter, delete pipeline, dan wizard picks (jalankan nmh dari dalam project → project itu menolak di-scan/di-hapus seutuhnya, apa pun target `--dir`), via config file maupun runtime `--exclude self`/`--keep self`; token dihapus dari exclude yang menyusup ke walker (bare name `self` tak boleh tafsir glob). Dua jebakan cac di-snap: negation pairs (–-no-color/--animate) di-default true oleh cac → forwarding hanya bila eksplisit via argv sniffing; bare `--depth` di keluarga config = kunci unset, validasi numerik global di-bypass. 227 test hijau
v1.0	stabil API, docs lengkap, publish npm	

---

16. Acceptance Criteria (MVP)

- `nmh` tanpa argumen menampilkan wizard fungsional.
- `nmh scan <dir>` menampilkan tabel size/PM yang akurat (toleransi size ±rekursi symlink).
- `nmh --dir=A,B --delete=hard --yes` menghapus semua target `node_modules` yang valid, dan menolak path berbahaya (guard test: `/`, `$HOME`, folder bukan `node_modules`).
- `--delete=trash` memindahkan ke OS trash, bukan hapus permanen.
- Lockfile npm/pnpm/yarn/bun terdeteksi dengan benar di ≥95% kasus test fixture.
- `--dry-run` tidak melakukan penghapusan sama sekali (testable: hitung folder sebelum/sesudah).
- Exit codes sesuai §6.8.
- Non-TTY mode tidak hang menunggu input.
- Test suite (unit + e2e lewat binary asli) hijau penuh: 36 test saat v0.1, 85 test saat v0.2, 114 test saat v0.3, 137 test saat v0.4, 178 test saat v0.5, 206 test saat v0.6, 213 test saat v0.7, 214 test saat v0.7.1, 216 test saat v0.8.0, 227 test saat v0.9.0 — fixture monorepo deterministik berisi keempat keluarga PM, symlink pnpm, `.pnpm` store, nested `node_modules`, dan victim symlink-loop (guard ELOOP).
- `nmh stats <dir>` menghasilkan: total size, instance vs unique count, duplication factor, waste size, top-5 per size — dan angka size konsisten dengan `--size total` (selisih <2%).
- `--compare` menampilkan delta yang benar terhadap baseline tersimpan (committed: `--save-baseline`, `--compare`, `--history`).
- `nmh stats [dir]` tanpa subflag mencetak seluruh seksi report (bukan ringkasan terpilih).
- `nmh stats -g` berjalan read-only tanpa `[dir]`, menampilkan semua package global lintas PM, menampilkan warning permission sesuai §6.5, dan tidak auto-elevate sudo.
- v0.3 tamat: `stats` & `stats -g`, report export scan-only, `--animate` gate, config file (§10) — kriteria `--compare`/baseline (§8.3) termasuk di v0.4.
- v0.4 tamat: baseline & compare & history, dedup suggestion (level manifest-range), `--why` (required-by dari manifest sendiri), `--by type` sungguhan, `--phantom`/`--dead` audit best-effort, `--update-check` opt-in.
- v0.5 tamat: license scan (`--licenses`/`--by licenses`: field package.json saja, `unknown` terakhir, ⚠ copyleft di production deps), `--score` komposit experimental (grade A–F, komponen eksplisit di JSON), `--co2` estimasi berlabel jelas, deprecated check `--online` (offline-first + registry fallback lazy cache 30 hari), `nmh treemap` (1 file HTML self-contained tanpa dep, layout squarified deterministik), `--save-report` untuk map/search/stats (semantik identik scan).
- v0.6 tamat: graf lockfile `--graph` (npm v2/v3 + yarn v1 + pnpm mini-YAML + bun jsonc-text via dispatcher, tanpa dependency runtime baru; model per nama + BFS depth; v1/binary/pecah → manifest-grade jujur), `--why` lockfile-grade (requirer transitif ditemukan; fallback manifest-sibling), `--reinstall` naif berlabel (60 ms/pkg + 50 MB/s + 3 s/native; asumsi lengkap di JSON).
- v0.7 tamat: wizard §7.5 menu lengkap (banner → quick scan → panah: hapus semua / pilih manual / search / map / laporan detail / settings read-only / keluar; read-only loop kembali ke menu), banner box TTY + satu baris non-TTY (`--json` tetap bersih), `nmh version` kaya (node+abi/platform+arch/kernel+distro/tty dgn `--json` payload mesin).
- v0.7.1 tamat: walker re-schedule slot-per-readdir (antrean BFS, tanpa recursive limiter) — mematikan deadlock circular-wait pada tree rimbun (gejala: scan senyap + exit 0); walker/sizer/packages memakai `fs.lstat` untuk klasifikasi file/dir/link (dirent `d_type` bisa dipalsukan FS — Android FUSE melabel file hardlink pnpm sebagai symlink) + dedupe hardlink per entry ala `du -sb` (91 → 63 MB pada same tree); regresi test geometri bushy masuk suite.
- v0.8.0 tamat: wizard auto-scope — descend-first sebagai kebiasaan lama; cwd polos naik sekali ke project root terdekat (manifest ≤8 hop, ancestor kosong diskip); scope dibekukan per sesi (rescan tidak memanjat ulang); 2 test e2e climb masuk suite.
- v0.9.0 tamat: `nmh config` (info·set·add·remove·unset) — `.nmhrc` korbel dari CLI (list via `--default-exclude`/`--default-keep`, set=ganti/add=dedupe/remove=buang|bare-kosongkan/unset=hancur kunci; scalars `--depth`/`--default-mode`/`--log-dir`/`--animate`/`--color`/`--update-check`; target `$HOME/.nmhrc` atau `--config <file>`; unknown key dipertahankan; validasi exit 1) + token **`self`** di exclude/keep — scan-level guard di subtree cwd (entry di dalam cwd turun sebelum filter/delete/wizard); 11 test e2e family+`self` masuk suite; smoke pada repo asli: control 20 folder/63,3 MB vs `--exclude=self` → 0 entry.

---

17. Keputusan (tercatat saat implementasi — dulunya Open Questions)

| # | Pertanyaan | Keputusan |
| --- | --- | --- |
| 1 | Nama bin final? | `nmh` bin utama + alias `node-modules-hunter` — dua-duanya terpasang. |
| 2 | Default delete mode di wizard? | `trash` (aman), pre-highlighted; user tetap bebas ganti mode. |
| 3 | Lockfile vp (vite+)? | vp adalah **wrapper, bukan package manager** — tidak ada `vp-lock.yaml`. Deteksi lewat manifest (deklarasi `vite-plus` / `@voidzero-dev/vite-plus-core`), hasilnya tag `[vp]` di atas PM dasar yang sah. |
| 4 | Suggestion dedup diprioritaskan? | Tidak — tetap v0.4, tetap "lockfile-aware" **level manifest**: analisa per-copy pakai range yang dideklarasi project (klim menuju manifest penanda), bukan parser lockfile penuh; tabel pnpm-lock.yaml/yarn.lock bisa memperdalam di v0.5. |
| 5 | Logging `~/.nmh/logs/`? | DEFAULT ON untuk setiap operasi delete (hard maupun trash) → `~/.nmh/logs/delete-*.json` (recovery reference). |
| 6 | CO2 & Bloat Score resmi? | Flag experimental saat fiturnya dibangun (v0.5) — bukan metrik resmi di output normal. |
| 7 | Phantom/dead: regex atau parser? | Best-effort regex tanpa dependency baru; parser "beneran" ditunda sampai ada kebutuhan nyata. |
| 8 | Bentuk metrik `stats`? | Rank grup **by name** (Σ semua instance); waste dedup per `(name, versi eksak)` = (copy−1) × lower-median size; `dupFactor` = instances/unique (1 desimal); symlinks dihitung sizeless. v0.3 pakai size *measured*, bukan estimasi lockfile. |
| 9 | Cakupan `stats -g` (§8.4)? | Read-only via command `stats -g` (+ `--pm`): probe root global per PM (`npm root -g`, `pnpm root -g`, `yarn global dir`, `bun pm -g`) dengan fallback path bawaan, hanya paket top-level (nama+versi+size); dedup lintas-PM pakai size instance pertama, savings = min; dead global = cek symlink bin per manifest (best-effort, tanpa sudo). |
| 10 | Cakupan `--save-report`/`--report`? | Hanya `scan` (map/search/stats menyusul di v0.4): salin output yang dicetak ke file, format dari ekstensi `.json`/`.md`/`.txt`; `.md`/`.txt` dipulu strip ANSI, `.json` = payload `--json`; gagal menulis = warning, exit code tidak berubah. |
| 11 | Gate `--animate`? | `auto` = hanya TTY; `--animate` memaksa on meski pipe (argv-explicit menang atas cac default maupun config), `--json` selalu mematikan counter biar stdout tetap bersih; `.nmhrc animate:false` mematikan default. |
| 12 | Semantik required-by `--why` (§8.6#5)? | Requirer diambil dari **manifest-nya sendiri saja** (own-manifest), tanpa klim ke manifest leluhur — project yang menyatakan lodash tidak disalahkan ke semua sibling; deklarasi project-level dihitung terpisah (klim `depSpecFor`); orphan copy diberi label; instansi symlink dicantumkan tapi tanpa size. |
| 13 | `--update-check` cache/reachable? | Opt-in (flag atau `.nmhrc updateCheck:true`), cache `~/.nmh/cache/update-check.json` 24 jam, notice **stderr** (stdout tetap bersih untuk `--json`), kegagalan jaringan sunyi + tidak mengubah exit code; env `NMH_REGISTRY_JSON` menunjuk registry lain (mirror/test). |
| 14 | Formula Bloat Score? | `--score` experimental: waste% → maks 40 pt, (dupFactor−1)×60 → maks 20 pt, dead% → maks 20 pt, (totalSize/512 MB)×20 → maks 20 pt; total hangus di 100; grade A<20, B<40, C<60, D<80, sisanya F. dead = modul dead (sekali per nama) ÷ instance terukur — hitung kasar eksperimental, bukan audit; audit dijalankan implisit oleh `--score` (komponen dead dipakai untuk skor, tidak di-print — tambah `--dead` untuk daftar). Seluruh komponen eksplisit di JSON. |
| 15 | Faktor konversi CO2? | ~2 g CO2e per GB idle per tahun (grid + amortisasi embodied; rentang publikasi LCA ~0.7–5, diambil tengah) dan ~10 g CO2e per GB transfer (satu redownload; rentang kuotasi ~5–50) — selalu tampil berlabel "estimasi kasar, bukan audit karbon"; format jujur sampai sub-gram (3 desimal) supaya repo kecil tidak menampilkan 0 g palsu; konstanta di-export untuk test. |
| 16 | Sumber data license scan? | Field `license`/`licenses` package.json SAJA — semua bentuk bersejarah dinormalisasi (string, `{type}`, `licenses:[{type}]`) — TANPA sniff file LICENSE; field absen/tak terbaca → bucket `unknown` yang selalu sort terakhir. Copyleft (GPL/AGPL/LGPL/MPL) ditandai ⚠ hanya saat instance dideklarasi di `dependencies` (peer tak pernah). Manifest instansi dibaca SEKALI di loop stats dan berbagi dengan pembacaan versi. |
| 17 | Mesin deprecated `--online`? | Offline-first: npm menulis field `deprecated` ke manifest saat instalasi; instansi tanpa catatan → registry `/<name>/<version>` lazy (dedup per name@version, cap 25 fetch per run, timeout 4 s, cache 30 hari `~/.nmh/cache/registry-deprecated/<name>@<version>.json` termasuk jawaban "absen", env `NMH_REGISTRY_URL` untuk mirror/test, gagal jaringan sunyi & exit code tetap). Package age/supply-chain age ditunda ke v1.0. |
| 18 | Bentuk treemap? | `nmh treemap <dirs>`: satu file HTML self-contained (vanilla JS, nol dependency runtime, tanpa jaringan) — layout squarified dua level (node_modules → paket top-level, weight = size; symlink = weight kecil + sel putus-putus), tooltip hover = displayPath + size, header total + timestamp. Algoritma menjamin setiap item ter-place (sisa box di-clamp minimal 0.5 px — cell ekstrem tidak pernah di-drop). Deterministik (sort stabil berdasar label). Output: `--out <file>` (default `nmh-treemap.html` di cwd), `--json` = data mentah; `--treemap <file>` = flag bentuk; read-only vs scan; menolak `--save-report` (file HTML = report-nya). |
| 19 | Ekspansi `--save-report`? | `map`/`search`/`stats` menerima `--save-report`/`--report` dengan semantik yang sama persis dengan scan (keputusan #10): salin konten yang dicetak (`.json` = payload `--json`, `.md`/`.txt` dipulu strip ANSI), gagal menulis = warning dan exit code tidak berubah, validasi ekstensi tetap global. `treemap` menolak flag ini — file HTML-nya sendiri sudah adalah report. |
| 20 | Graf lockfile (`--graph` + basis `--why`)? | Parser **tanpa dependency runtime baru**, membaca SATU lockfile per project (dispatcher npm → yarn → pnpm → bun): `package-lock.json` v2/v3 (packages map; v1 npm-6 ditolak jujur), `yarn.lock` v1 (state machine; root deps dari package.json saudara), `pnpm-lock.yaml` (mini-YAML subset — indent-stack + inline flow; v9 edges dari `snapshots:`, v6 dari `packages:`; kunci peer `pkg@ver(/peer@x)` direduksi ke nama; rootDirect bersumber dari importer `.`), `bun.lock` text jsonc-ish (workspaces `.` + entries object-array; `bun.lockb` binary → manifest-grade). Model graph **per nama**: edges (root = `«root»`, field tetap eksplisit) + BFS depth 1..N (hingga 64 hop), workspace/link di-skip, node tanpa jalur dari root = `unreachable` (optional/peer pruning) — dedupe per nama, bukan per path, didokumentasi sebagai penyederhanaan. File >8 MB / JSON patah / shape aneh → null (manifest-grade, tetap tampil). `nmh why` memakai edges ini saat ada lockfile: required-by berpindah ke grade `lockfile` (requirer transitif ditemukan, field berlabel `lockfile`), scan manifest-sibling tetap fallback. JSON `stats` membawa `graph` + mode `graph`. |
| 21 | Model `--reinstall`? | NAIF dengan kontrak terbuka: `detik = pkg × 60 ms + totalSize / 50 MB/s + native × 3 s`. Proxy native = nama paket mencocokkan 12 keluarga berat-native (`sharp`, `grpc`, `better-sqlite3`, `sqlite3`, `canvas`, `bcrypt`, `node-pty`, `tree-sitter`, `fsevents`, `fibers`, `node-sass`, `oracledb`), case-insensitive, distinct-name. Semua asumsi dikirim di JSON (`msPerPackage`, `bytesPerSecond`, `nativeMs`, `formula`) dan label `(naif)` tercetak di section — bukan benchmark, hanya skala "worth it gak". |
| 22 | Wizard §7.5 penuh + banner + `nmh version` kaya? | v0.7: menu panah 7 entri — hapus semua / pilih manual / search / map / laporan detail (full stats) / settings read-only / keluar — aksi read-only loop kembali ke menu (rescan tiap kunjungan supaya daftar selalu segar), delete flow tetap guard → mode (`trash` pre-selected) → confirm → execute lalu keluar dengan ringkasan freed + recovery log. Settings read-only menampilkan `.nmhrc` aktif (sumber + nilai) karena keputusan permanen tetap di config file, bukan menu. Kontrak non-TTY "tidak pernah hang" dipertahankan: banner SATU baris + read-only scan; `--json` menekan banner → stdout murni payload scan. `nmh version` naik kelas (node + abi + platform/arch + kernel + distro + stdout-tty; `--json` = JSON penuh; `nmh version --json` juga berlaku). Banner digambar manual (box-drawing; lebar emoji dihitung 2 sel) — tanpa dependency runtime baru; `nmh --version` bentuk penuh sama. |
| 23 | Walker: recursive limiter atau antre manual? | **Antrean BFS manual, slot per readdir** (v0.7.1). Walker lama menahan slot limiter sambil `await` anak-anak yang juga diantrekan di limiter yang sama — ketika gelombang readdir menghabiskan 16 slot dengan parent yang menunggu anak yang diantrekan di belakangnya (circular wait), scan mati senyap: exit 0, tanpa output sama sekali. Kasus nyata: pnpm workspace 12 package (`--dir=./soundfx` di `/home`). Zat pemanis masalah: `fs/promises` berjalan di threadpool libuv yang **tidak menahan event loop hidup** — jadi Node keluar di tengah pekerjaan menggantung. Struktur baru: tugas limiter = SATU readdir; anak (termasuk dive `node_modules` saat `-r`) masuk ke antrean tugas; selesai = antre kosong DAN slot aktif 0. Geometri bushy (12 package × 6 subdir × 6 subdir) jadi regresi test (`walker-bushy`). Catatan jujur: readdir per-direktori yang macet dari mount yang rusak masih bisa menjeda scan — di luar cakupan; diungkap bila datang di lapangan. |
| 24 | Klasifikasi file/folder pakai `dirent` d_type atau `lstat`? | **Selalu `fs.lstat`** (v0.7.1, semua file walker/sizer/packages). Di FS tertentu (FUSE/sdcardfs Android) `d_type` file hardlink store pnpm dilaporkan sebagai symlink: 112 dari 125 dirent di `.pnpm/…/typescript/lib` salah label — `lstat` membuktikannya file nyata (`_tsc.js` 6,2 MB). Percaya d_type membuat sizer diam-diam melewatkan hampir semua isi `.pnpm` (folder terukur 650 KB vs `du -sb` 66 MB); `toybox find -type f` tertipu serupa (87 file), sementara GNU `du` (jalur lstat/fts) selalu benar. Sizer kini juga menduaka hardlink **per entry** (`nlink>1` + `dev:ino`) sehingga angkanya setara `du -sb` pada layout `.pnpm` (91 → 63 MB pada tree yang sama). Trade-off jujur: satu `lstat` per anak (beban kecil), dan dedupe tidak lintas entry — store global yang dibagikan antar entry tetap dihitung masing-masing, sebab tiap entry adalah unit penghapusan mandiri. |
| 25 | Wizard saat cwd polos: diam atau naik? | **Naik sekali ke project root terdekat** (v0.8.0). Urutan: descend normal dulu (kedalaman 3) — hanya kalau hasilnya kosong, naik ≤8 hop; kualifikasi root = manifest (package.json, package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, pnpm-workspace.yaml, yarn.lock, bun.lock, bun.lockb); ancestor ber-manifest tanpa node_modules diskip agar root monorepo tetap terjangkau; probe unsized (walk readdir), ukur tetap lewat collectScan; scope dibekukan sekali di awal sesi — rescan loop TIDAK memanjat ulang supaya pasca-delete tidak berpindah tempat secara kejutan. TTY: catatan dim menyebut root baru; non-TTY: baris peringatan; `--json`: tetap payload murni. |
| 26 | Cara mengelola `.nmhrc` dari CLI + cegah "ngnuke project sendiri"? | **Keluarga `nmh config` + token `self`** (v0.9.0). (a) `nmh config info/set/add/remove/unset` — tulis JSON tanpa prompt; target default `$HOME/.nmhrc` (prediktabe, tidak mencemari repo yang tengah dibuka), `--config <file>` mengelola file eksplisit (dibuat bila absen); body file dibaca mentah lalu di-patch — key asing yang loader abaikan **tetap dipertahankan** penulisnya; validasi meniru `parseConfigBody` (ConfigError → exit 1, file tidak tersentuh); ops list: `set` = ganti penuh, `add` = append dedupe, `remove` = buang item (idempotent) atau bare flag = kosongkan, `unset` = hapus kunci; `--delete` ditolak di keluarga ini. Dua jebakan cac disnap: negation pairs (`--no-color`, `--animate/--no-animate`) term-default `true` di flags → forwarding hanya jika eksplisit di argv; bare `--depth` dalam keluarga config = kunci unset (validasi numerik global dibypass untuk subcommand ini). (b) Token **`self`** dalam `exclude`/`keep` = guard scan-level di `applyFilters`: entry yang path-nya di dalam atau tepat di subtree cwd digugurkan SEBELUM matchers lain → scan, delete, wizard picks, dan filter-inferennya semua ikut; `self` juga dibuang dari exclude yang diteruskan ke walker supaya bare-name `self` tidak pernah tafsir literal-glob. (c) Kejujuran: wizard yang kena auto-scope + self menuju "0 entry" tetap berpesan nothing found (scope probe berjalan tanpa excludes — dibiarkan, didokumen). |

Status: v0.1 MVP + v0.2 (search & `--search`, map & `--tree` & `--depend` declared-level, `--pm` incl. tag `[vp]`, `-r`, `--exclude`, `--keep`, `--depth`, `--expand`) + v0.3 (`stats` dasar & `stats -g`, report export scan-only, `--animate`, config file) + v0.4 (baseline & compare & history, dedup suggestion manifest-level, `--why`, `--by type`, `--phantom`/`--dead`, `--update-check`) + v0.5 (license scan `--licenses`, Bloat Score `--score` & CO2 `--co2` experimental, deprecated check `--online`, `nmh treemap` export, `--save-report` map/search/stats) + v0.6 (graf lockfile `--graph` npm/yarn/pnpm/bun + `--why` lockfile-grade + `--reinstall` naif) + v0.7 (wizard §7.5 menu penuh, banner TTY/non-TTY, `nmh version` kaya + `--json`) + v0.7.1 (fix walker deadlock — re-schedule slot-per-readdir; sizer/packages: klasifikasi `lstat` + dedupe hardlink ala `du`) + v0.8.0 (wizard auto-scope ke project root) + v0.9.0 (`nmh config` info·set·add·remove·unset + token `self` guard scan-level) selesai — suite 227 test hijau (unit + e2e via binary asli).

---

Dokumen ini adalah PRD awal. Agent coding wajib baca keseluruhan dokumen, mengimplementasikan sesuai urutan Roadmap MVP, dan menanyakan klarifikasi hanya untuk §17 bila benar-benar blocking.