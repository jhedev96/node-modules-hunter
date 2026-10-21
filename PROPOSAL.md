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
5. Tidak ada tool yang ringan, satu perintah, dan cross-package-manager.

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
`--pm`	`npm` \| `pnpm` \| `yarn` \| `bun` \| `vp` (vite+)	Filter/filter-by package manager, ditentukan dari lockfile di folder induk (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `vp-lock.yaml`). Tanpa nilai: list semua PM yang terdeteksi.	
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
`--depth`	`<n>`	Batasi kedalaman scan (default tanpa `-r`: 1 level project; dengan `-r`: 4).	
`--json`	boolean	Output JSON (untuk dipipe ke jq / dipakai script lain).	
`--tree`	boolean	Output tree view hasil map (alternatif dari tabel).	
`--report` \| `--save-report`	`<file>`	Simpan hasil scan ke file (md/json/txt).	
`--update-check`	boolean	Cek update tool (non-blocking, cached 24h).	
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
vp (vite+)	`vp-lock.yaml` (placeholder — sesuaikan format aktual)	Treat sebagai PM turunan; reuse strategi pnpm-like kalau struktur mirip.	

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

Precedence: CLI flag > config file > default built-in.

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
v0.2	search, map, --depend, --pm filter semua PM, --recursive, --dry-run, --json	
v0.3	--global, --animate polish, config file, report export, tree view, `stats` dasar (size breakdown, dup factor, top-N)	
v0.4	lockfile-aware dedup suggestion, `--depend` enriched (inbound map), `--why`, phantom/dead deps audit, baseline & `--compare`	
v0.4	lockfile-aware dedup suggestion ("package X ada 14 copy, 300 MB bisa dihemat"), update-check	
v0.5	Bloat/Health Score, license scan, deprecated check (`--online`), treemap export, `--co2` estimate	
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
- `nmh stats <dir>` menghasilkan: total size, instance vs unique count, duplication factor, waste size, top-5 per size — dan angka size konsisten dengan `--size total` (selisih <2%).
- `--compare` menampilkan delta yang benar terhadap baseline tersimpan.
- `nmh stats [dir]` tanpa subflag mencetak seluruh seksi report (bukan ringkasan terpilih).
- `nmh stats -g` berjalan read-only tanpa `[dir]`, menampilkan semua package global lintas PM, menampilkan warning permission sesuai §6.5, dan tidak auto-elevate sudo.

---

17. Open Questions (untuk lu putusin sebelum coding)

1. Nama bin final: `nmh` aja, atau tetap full `node-modules-hunter` sebagai bin utama?
2. Default delete mode di wizard: `trash` (aman) atau tetap wajib user pilih tiap kali?
3. Lockfile vp (vite+) format aktualnya apa? — perlu riset kecil, sementara treat sebagai alias pnpm-like.
4. Fungsionalitas "suggestion dedup" masuk v0.4 — setuju atau diprioritaskan lebih awal?
5. Logging ke `~/.nmh/logs/` — default on atau opt-in?
6. Estimasi CO2 & Bloat Score — masuk sebagai fitur resmi atau experimental flag?
7. Audit phantom/dead deps perlu static import scan — setuju best-effort (regex), atau pakai parser beneran (biar lebih akurat tapi nambah dependency berat)?

---

Dokumen ini adalah PRD awal. Agent coding wajib baca keseluruhan dokumen, mengimplementasikan sesuai urutan Roadmap MVP, dan menanyakan klarifikasi hanya untuk §17 bila benar-benar blocking.