# ask-kit-files

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about the files on your machine that are not a repository's code: where a file
is, what uses the disk space, what changed in a folder lately, which documents mention
something, what a PDF, Word, Excel, PowerPoint or archive file holds. A cheap model walks the
folders and reads the documents outside your agent's context and answers with full paths, page
and line numbers, sizes and dates.

Questions it is built for, which an agent otherwise answers with a string of `find`, `du`,
`grep`, `pdftotext` and `unzip` calls:

- Which documents under `~/Documents` mention Vetinari, PDFs and Word files included?
- What is taking up the space in `~/Downloads`, and which of it is a copy?
- What is inside `watch-archive.zip`, and what does the invoice PDF say?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) 0.3 or later. Walking folders,
reading text, Word, Excel, PowerPoint and OpenDocument files, listing zip and tar archives and
finding copies use Node's own modules. Programs that add to it, used when they are installed:
`pdftotext` (the text of PDF files), `rg` (faster content search), `tar` (tar.bz2, tar.xz and
tar.zst archives), `plocate` or `locate` (a name index, asked when a search ran out of time).

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-files
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-files        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-files --yes  # installs and enables it
```

Restart your agents so `ask` lists `files`.

Settings: `FILES_ROOTS` is a comma-separated list of the folders the kit may look in (default
`~`, your home folder); the folder the agent runs in is always allowed. A path outside them is
refused. `WORKDIR` is the folder relative paths resolve against; it is detected.

## What it carries

`files.mjs` holds the calls the investigator uses: `find`, `grep`, `read`, `outline`, `info`,
`du`, `list` (archives) and `duplicates`, and the changing ones below. `api.d.ts` documents each.

Scripts, each of which also runs with no model (`ask-kit run files <script> key=value`):

| Script | Answers |
|---|---|
| `find` | where a file is: by name words, a glob or a regex, by kind, extension, size and modified time, newest first |
| `recent` | what changed in a folder since a time, grouped by sub-folder |
| `space` | what uses the space under a folder: sub-folders, biggest files, bytes by kind, free disk space, optionally big files nobody has touched for a while |
| `mentions` | which files hold some text, with the matching lines; PDF, Word, Excel, PowerPoint and OpenDocument files are searched through their text |
| `peek` | what one file holds: headings and first lines of a document, the entries of an archive, the type and size of anything else |
| `duplicates` | groups of byte-identical files, biggest waste first |

Searches skip `node_modules`, `.git`, caches, package stores and the session folders of coding
agents (the `sessions` and `mike` kits cover those); `space` counts them. Every search is bounded in
depth, entries and time, and a result says when it stopped early.

## What it can change

When asked, the investigator can move, copy, rename and make folders, move to the trash, delete
for good, and unpack archives. These calls throw unless the caller asked for a change.

- Nothing is overwritten. A target that exists is reported as a failure.
- `trash` is the way to delete: it uses the desktop's trash with the origin recorded, so the file
  can be put back. `remove` needs `permanently: true` (and `recursive: true` for a folder with
  content), which the instructions allow only when the caller wrote that they want it deleted
  for good.
- The folders the kit works in are not moved, renamed or removed.
- `extract` takes zip, tar and tar.gz in Node and the other tar formats through `tar`. It
  extracts nothing when any file would be overwritten, leaves out names that would leave the
  target folder and links, and stops at 4 GB.

Reading is held to reading. The kit never reads what holds credentials: `.env` files, keys,
anything under `.ssh`, `.gnupg`, `.aws` and `.kube`, token, password and backup-code files, shell
and prompt history, browser profiles, mail and password stores. They are not listed, searched or
read, and a result counts them (`skipped.private`). `info` gives such a file's size and dates.
In text that is read, passwords, tokens and key blocks are replaced with `<redacted>`. The
rules go by file names and by patterns in the text, so a secret in a file with an ordinary name
and an unusual format can get through.

## How well it works

`bench/questions.json` holds eleven shots that run with no model against `bench/fixture/home`, a
small made-up home folder (build it with `node bench/fixture/build.mjs`, which also sets the
modified times), and nine questions for a model about the same folder. On 2026-11-21 on
Linux each script was run on the fixture and on real folders, and each shot's expectations
matched its output. The changing calls were run on a scratch folder: holds with `act` off, refusals
of paths outside the roots and of credential files, nothing overwritten, a zip and a tar with
`../` names and a link, and the trash record.

No model has been run on the nine questions. The macOS name index (`mdfind`) and trash
(`~/.Trash`) are written and have not been run on a Mac.

[RECIPE.md](RECIPE.md) says what the kit reads and runs and how to rebuild it. MIT licence.
