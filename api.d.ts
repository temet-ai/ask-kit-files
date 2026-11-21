// Every path is a string: absolute, "~/Documents/x.pdf", or relative to the folder the agent runs in
// (a name such as "Downloads/x.pdf" is also looked for under each root). Every path must sit inside
// a root: the home folder and the agent's folder, or what the setting FILES_ROOTS names.
// A call that is refused or finds nothing returns {error, ...} with what is near it; it does not throw,
// except for a path outside the roots or a private one (those throw with the reason).
// `now` on any call is the moment ages are measured from (an ISO date); leave it out for the real time.

interface FileRow {
  path: string;      // with ~ for the home folder
  bytes: number; size: string;
  modified: string;  // ISO, UTC
  age: string;       // "3 days ago"
  kind?: "folder";
  created?: string;  // only with by: "created"
}

// What a walk looked at and what it left out. Read it: a walk that stopped early says so in `stopped`
// and its result is partial.
interface WalkReport {
  searched?: { folders: number; entries: number; ms: number };
  stopped?: string;
  skipped?: {
    private?: number; privateIn?: string[];  // credential, key, browser, mail and history files: counted, never named
    pruned?: number;                         // node_modules, .git, .cache, target and the like (all: true includes them)
    otherMounts?: number;                    // other disks (mounts: true includes them)
    unreadable?: number; links?: number; tooDeep?: number;
  };
}

type When = string | number | Date; // "today", "yesterday", "this week", "last week", "this month", "2026-11-12", "3 days", "36h", "2 weeks ago"
type Size = string | number;        // "500KB", "10MB", "1.5GB" or bytes
type Kind = "document" | "image" | "archive" | "video" | "audio" | "code" | "data" | "pdf" | "folder";

declare const files: {
  // The folders this kit may look in, and the agent's folder.
  roots: string[]; workdir: string;
  // The extensions behind each kind.
  kinds: Record<string, string>;

  // Find files or folders. Returns at most `limit` (50) rows in `files`, `matched` is the full count, `more` what was cut.
  //  name: words that must all be in the file name or its path (any case), a glob ("*.pdf", "inv-0??*"), or a /regex/.
  //        A name equal to the whole file name (with or without extension) comes first; `match` says which rule matched.
  //  kind: one or several of Kind; ext: extensions ("pdf", ["docx","xlsx"]). kind "folder" finds folders.
  //  modifiedSince / modifiedBefore: When. minSize / maxSize: Size. by: "created" tests the creation time instead of the modified time.
  //  under: a folder or a list of them (default every root). depth (16), ms (time budget, 10000), all (include node_modules, .git, caches),
  //  mounts (cross to other disks). sort: "newest" (default), "oldest", "biggest", "smallest", "name".
  // When the walk ran out of time and the machine has plocate, locate or mdfind, it asks that index too; `index` says so.
  find(o?: { name?: string; kind?: Kind | Kind[]; ext?: string | string[]; modifiedSince?: When; modifiedBefore?: When; minSize?: Size; maxSize?: Size; by?: "created"; under?: string | string[]; depth?: number; ms?: number; all?: boolean; mounts?: boolean; sort?: "newest" | "oldest" | "biggest" | "smallest" | "name"; limit?: number; now?: string }):
    Promise<{ under: string[]; match?: string; alsoByWords?: number; matched: number; files: FileRow[]; more: number; index?: string; error?: string; folder?: string; has?: string[] } & WalkReport>;

  // One file or folder: kind, size, dates, permissions, and for a file its real type from its first bytes (a file named .pdf that is
  // not one says so); for a folder its total size, entries, and newest file. Works on private paths too, but gives only size and dates.
  info(path: string, o?: { now?: string; ms?: number }): { path: string; kind: "file" | "folder" | "link" | "special"; bytes?: number; size?: string; modified: string; age: string; type?: string; ext?: string | null; entries?: number; folders?: number; files?: number; filesInAll?: number; newestFile?: string; newestAge?: string; private?: true; note?: string; error?: string; has?: string[] };

  // The text of a file: plain text, PDF (needs pdftotext), docx, xlsx (sheets as tab-separated rows), pptx (per slide), odt, ods, odp.
  // Lines start..start+lines-1 (start 1, lines 200, at most 5000, and about `max` characters, default 20000). `next` is where to
  // continue when `left` lines remain. PDFs: `pages` and the `page` the start is on. numbered: true prefixes "N: ".
  // Passwords, tokens and key blocks in the text are replaced by <redacted>. A private file throws; a file that is not text returns {error, type}.
  read(path: string, o?: { start?: number; lines?: number; max?: number; numbered?: boolean; now?: string }): Promise<FileRow & { type?: string; pages?: number; page?: number; totalLines?: number; start?: number; end?: number; next?: number; left?: number; note?: string; text?: string; error?: string; need?: string }>;

  // The headings of a document (Markdown # lines, Word and OpenDocument headings, slide and sheet titles) with their line numbers; for a PDF
  // also each page's first line. Use it before read() on a long document, then read({start}) at the line you need.
  outline(path: string, o?: { max?: number }): Promise<{ path: string; type?: string; totalLines?: number; pages?: { page: number; line: number; first: string }[]; headings?: { line: number; text: string }[]; moreHeadings?: number; error?: string }>;

  // Which files hold some text. pattern: a string, a /regex/, or an array that a file must ALL hold. Case ignored (ignoreCase: false).
  // Plain text files are searched; PDFs and office files only with docs: true (their text is extracted, newest first, up to maxDocs 300).
  // under, kind, ext, depth, all, mounts, ms (15000), maxSize (5MB) as in find. hidden: false skips hidden files and folders
  // (.config, .local; default true, so they are searched) and is much faster over a home folder. limit 30 files, perFile 5 lines each.
  // Files are listed newest first, with line numbers and the matching lines (redacted). `documents` says whether documents were searched.
  grep(pattern: string | string[], o?: { under?: string | string[]; kind?: Kind | Kind[]; ext?: string | string[]; docs?: boolean; hidden?: boolean; ignoreCase?: boolean; limit?: number; perFile?: number; maxSize?: Size; maxDocs?: number; depth?: number; ms?: number; all?: boolean; mounts?: boolean; now?: string }):
    Promise<{ pattern: string | string[]; under: string[]; engine: "rg" | "node"; matchedFiles: number; files: (FileRow & { type?: string; hits: number; lines: { line: number; text: string }[] })[]; more: number; documents: string | { found: number; searched: number; left?: string; notRead?: Record<string, number> }; stopped?: string } & WalkReport>;

  // What uses the space under a folder (default the first root): total, the biggest sub-folders to `depth` (2) with their share, the biggest
  // files (`top` 15), bytes by kind, and the disk's total and free space. Private files count toward their folder and are not named.
  // Hard links count once; sparse files count what they hold on disk. node_modules and caches ARE counted here.
  du(path?: string, o?: { depth?: number; top?: number; ms?: number; mounts?: boolean; now?: string }): { path: string; bytes: number; size: string; files: number; foldersInAll: number; filesDirectlyInIt: string; folders: { path: string; bytes: number; size: string; percent: number; files: number }[]; moreFolders: number; biggestFiles: { path: string; bytes: number; size: string; percent: number; modified: string; age: string }[]; byKind: Record<string, string>; private?: string; disk?: { total: string; free: string; usedPercent: number | null }; error?: string } & WalkReport;

  // What an archive holds without unpacking it: zip (also docx, xlsx, jar, epub), tar, tar.gz; tar.bz2, tar.xz and tar.zst through the tar
  // program (names only). Returns the counts, the top-level names, and `files` (name, size, modified), cut at `limit` (200).
  // match: a string or /regex/ on the entry names. 7z and rar are not read: the result says so.
  list(path: string, o?: { limit?: number; match?: string; now?: string }): Promise<FileRow & { format: string | null; entries?: number; folders?: number; unpackedBytes?: number; unpacked?: string; packed?: string; encrypted?: string; top?: string[]; matching?: number; files?: { name: string; size?: string; modified?: string; encrypted?: true; linkTo?: string }[]; more?: number; note?: string; stopped?: string; error?: string; need?: string }>;

  // Groups of identical files (same size, then same content by sha256) under a folder (default every root), biggest waste first.
  // minSize (1 byte), kind, ext, limit 20 groups, ms 30000. Hard links of one file are not copies.
  duplicates(under?: string | string[], o?: { minSize?: Size; kind?: Kind | Kind[]; ext?: string | string[]; limit?: number; ms?: number; depth?: number; all?: boolean; mounts?: boolean; now?: string }): { under: string[]; filesCompared: number; groupCount: number; wastedBytes: number; wasted: string; groups: { bytes: number; size: string; copies: number; wasted: string; sha256?: string; unconfirmed?: string; files: { path: string; modified: string; age: string }[]; moreFiles?: number }[]; more: number; unchecked?: string } & WalkReport;

  // Which optional programs are installed (pdftotext, rg, tar, plocate, locate, mdfind) and what each is for.
  programs(): Record<string, { present: boolean; use: string }>;

  // A time in words as a window {since, before} in ms, and as the start of it.
  window(text: When, now?: number): { since: number; before: number | null };
  when(text: When, now?: number): number;
  human(bytes: number): string;
  ago(ms: number, now?: number): string;

  // ---- changing calls: they throw "not in this ask: ..." unless the caller asked for a change ----
  // Nothing is overwritten: a target that exists is a failure, not a replacement. Each returns {ok: true, ...} or {ok: false, error}.
  // move, rename, trash and remove refuse a root folder itself.

  // Move a file or folder to `to`: into it when `to` is a folder that exists, else to that name. Across disks it copies, then removes the source.
  move(from: string, to: string): { ok: boolean; moved?: string; to?: { path: string; kind: string; size?: string }; error?: string };
  // Copy a file or folder (a folder with everything in it), same rules as move.
  copy(from: string, to: string): { ok: boolean; copied?: string; to?: { path: string; kind: string; size?: string }; error?: string };
  // Rename in place: newName has no folder in it.
  rename(path: string, newName: string): { ok: boolean; renamed?: string; to?: { path: string }; error?: string };
  // Make a folder and its parents; existed: true when it is there already.
  mkdir(path: string): { ok: boolean; made?: string; existed?: boolean; error?: string };
  // Move to the trash (the desktop's own, with its origin recorded, so it can be put back). The normal way to delete.
  trash(path: string): Promise<{ ok: boolean; trashed?: { path: string }; in?: string; restore?: string; error?: string }>;
  // Delete for good. Needs { permanently: true }, which only the caller's own words ("delete it permanently") justify; a folder with
  // content also needs recursive: true.
  remove(path: string, o: { permanently: true; recursive?: boolean }): { ok: boolean; removedForGood?: { path: string }; error?: string };
  // Unpack a zip, tar or tar.gz (tar.bz2, tar.xz, tar.zst through tar) into `to` (default a new folder beside it named like the archive).
  // Refuses when any file would be overwritten (it extracts nothing then), skips names that leave the folder and links, caps at 4 GB.
  extract(archive: string, to?: string): Promise<{ ok: boolean; extracted?: string; to?: string; files?: number; size?: string; leftOut?: Record<string, number>; error?: string; exist?: string[] }>;
};
