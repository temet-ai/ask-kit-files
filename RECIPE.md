# Recipe: the files kit

## What it answers

Where a file is (by name, kind, size, time), what uses the space under a folder, what changed in
a folder since a time, which files hold some text (PDF and office files through their text),
what a document, a zip or a tar archive holds, which files are copies. It also acts: move, copy,
rename, make a folder, trash, delete for good, extract.

## What it needs

- ask-kit 0.3 or later (`min_ask_kit = "0.3.0"`). No tokens.
- Settings: `WORKDIR` (detected: the folder the agent runs in) and `FILES_ROOTS` (default `~`).
- Optional programs, looked up on PATH: `pdftotext` (poppler) for PDF text, `rg` for content
  search, `tar` for tar.bz2, tar.xz and tar.zst, `plocate` or `locate` (Linux) or `mdfind`
  (macOS) for a name index. Without one the call says what is missing.

## What it reads and runs

Reads: directory listings and `lstat` of every folder under the allowed roots; the first 4 KB of a
file to find its type; whole text files (up to 32 MB), zip and tar structures and entries, and
the XML parts of Word, Excel, PowerPoint and OpenDocument files. Runs, with `execFile` and an
argument array, a timeout and SIGKILL: `pdftotext -layout`, `rg --files-with-matches`, `tar -tf`
and `tar -xkf` for the formats Node does not unpack, `plocate`, `locate` and `mdfind`. No shell.

Never read, listed or searched (`SECRET_NAME`, `SECRET_APPDIR` in `files.mjs`): `.env*`, `*.pem`,
`*.key` and similar, `id_*`, names containing credential, secret, token, passw, passphrase,
backup codes, recovery keys, 2fa, seed phrase; `.netrc`, `.npmrc`, `.pgpass` and other tool
credential files; shell, prompt and editor history; browser cookie, login and key databases;
folders `.ssh`, `.gnupg`, `.aws`, `.kube`, `.mozilla`, `.thunderbird`, password stores and mail;
the app folders of browsers, chat clients and credential tools under `~/.config` and
`~/.local/share`; `~/.claude.json`. A text with a private key block is refused.

Bounds: a walk is breadth-first, 16 levels deep, 1.5 million entries and 10 seconds by default
(`ms` raises it, up to 120 s), and says in `stopped` when it ended early. Content search is 15 s
and files up to 5 MB; document search reads the newest 300 documents.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.files`, name `files`, `says`, `keywords`,
`route_hint`, `cite`, `acts` listing the seven `files.*` changing calls, the settings above, one
`[[sources]]` of kind `module`, name `files`, module `files.mjs`, api `api.d.ts`,
`instructions = "instructions.md"`, and two reading `[[actions]]`: `space` and `recent`).

`files.mjs` exports `make({settings, push, cwd, act})` returning the `files` global.
Every path goes through `locate`: `~` expanded, resolved to a real path (links followed in the
part that exists), required to sit inside a root, not virtual (`/proc`, `/sys`, `/dev`, `/run`) and
not private. `walk` is the one folder walker (prune lists, other mounts, hidden option, budgets,
private entries counted and never named). On it: `find` (name words, glob or regex; kind,
extension, size, time; exact name first), `info` (type from the first bytes), `read` and `outline`
(through `textOf`: text, `pdftotext`, or the XML of the office format; redacted per line),
`grep` (`rg` for candidates, then Node reads each candidate; a Node walk when `rg` is absent),
`du` (per-folder totals, hard links once, private bytes counted not named), `list` (zip central
directory, tar stream), `duplicates` (size, then first and last 64 KB, then sha256) and the
changing calls, which throw `not in this ask: ...` unless `act`.

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and
`export default async function ({files}, params)`, each returning a one-line `verdict` first):
`find`, `recent`, `space`, `mentions`, `peek`, `duplicates`. `instructions.md` has the structure of
the other kits: scripts first, what a partial result means, credentials off limits, changing only
what was asked and reading the state back, the answer format.

## Bench

`node bench/fixture/build.mjs` builds `bench/fixture/home` (Discworld files: PDF, docx, xlsx, zip,
tar.gz, a duplicate PNG, an mp4, and made-up credential files). `bench/questions.json` has
eleven shots (`do`, with `now` fixed) and nine model questions (`q`). `ask-kit kit test files`
runs them from the kit's folder.

## Results

Each shot's expectations were matched against its script's output on 2026-11-21 (Linux). No model
run has been made yet.
