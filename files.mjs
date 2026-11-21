// Files anywhere on the user's machine, for ask-kit: find them by name, kind, time and size, read
// their text (plain text, PDF through pdftotext, office files through their own XML), search
// their content, see what uses the space, list archives and find duplicates. With act it also
// moves, copies, renames, makes folders, trashes, removes and extracts.
//
// Walking, stat, hashing, zip and tar reading are Node's own, so the kit needs nothing installed on
// Linux or macOS. Optional programs are used when present and named when absent:
// pdftotext (PDF text), rg (content search), tar (bz2, xz and zst archives), mdfind, plocate or
// locate (a name index, asked when a walk ran out of time).
//
// Four rules:
//  - every path is resolved and must sit inside a root (FILES_ROOTS, and the caller's folder);
//  - credentials, keys, browser profiles, password stores, mail and shell history are never read or
//    listed, because what the investigator reads goes to a cloud model;
//  - every walk is bounded in depth, entries and time, and says when it stopped early;
//  - nothing is ever overwritten, and nothing is deleted for good unless the call says so.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// ---------- sizes, times ----------

export const human = (n) => {
  if (n == null || Number.isNaN(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100} ${units[i]}`;
};

export const plural = (n, word, many) => `${n} ${n === 1 ? word : (many ?? `${word}s`)}`;

/** "3 days ago" for a time in ms, seen from `now`. */
export const ago = (ms, now = Date.now()) => {
  const d = now - ms;
  if (d < -60_000) return "in the future";
  if (d < 60_000) return "just now";
  const steps = [[3_600_000, 60_000, "minute"], [86_400_000, 3_600_000, "hour"], [60 * 86_400_000, 86_400_000, "day"], [730 * 86_400_000, 30.44 * 86_400_000, "month"], [Infinity, 365.25 * 86_400_000, "year"]];
  for (const [below, unit, word] of steps) if (d < below) return `${plural(Math.floor(d / unit), word)} ago`;
};

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const UNIT_MS = { s: 1000, sec: 1000, second: 1000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000, w: 7 * 86_400_000, wk: 7 * 86_400_000, week: 7 * 86_400_000, mo: 30.44 * 86_400_000, month: 30.44 * 86_400_000, y: 365.25 * 86_400_000, yr: 365.25 * 86_400_000, year: 365.25 * 86_400_000 };
const WHEN_FORMS = 'a date ("2026-11-12", "2026-11-12T09:00:00Z"), "today", "yesterday", "this week", "last week", "this month", "last month", "this year", "last year", or an age ("3 days", "36h", "2 weeks ago")';

/**
 * A time in words as a window {since, before} in ms. `before` is null when the window runs to now.
 * "last week" starts on the Monday of the previous calendar week and runs to now, so it holds both
 * "the week before this one" and "the last seven days".
 */
export function window(text, now = Date.now()) {
  if (text instanceof Date) return { since: text.getTime(), before: null };
  if (typeof text === "number") return { since: text, before: null };
  const s = String(text ?? "").trim().toLowerCase().replace(/^(since|in the|in|during|within|from|the)\s+/, "").replace(/\s+/g, " ");
  if (!s) throw new Error(`a time is needed: ${WHEN_FORMS}`);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const midnight = day.getTime();
  const monday = midnight - ((day.getDay() + 6) % 7) * 86_400_000;
  const first = (monthsBack) => new Date(day.getFullYear(), day.getMonth() - monthsBack, 1).getTime();
  if (s === "today") return { since: midnight, before: null };
  if (s === "yesterday") return { since: midnight - 86_400_000, before: midnight };
  if (s === "now") return { since: now, before: null };
  if (s === "this week") return { since: monday, before: null };
  if (/^(last|past|previous) week$/.test(s) || s === "week") return { since: monday - 7 * 86_400_000, before: null };
  if (s === "this month") return { since: first(0), before: null };
  if (/^(last|past|previous) month$/.test(s) || s === "month") return { since: first(1), before: null };
  if (s === "this year") return { since: new Date(day.getFullYear(), 0, 1).getTime(), before: null };
  if (/^(last|past|previous) year$/.test(s) || s === "year") return { since: new Date(day.getFullYear() - 1, 0, 1).getTime(), before: null };
  const age = s.match(/^(?:(?:last|past|previous) )?(\d+(?:\.\d+)?|an?|one|two|three|couple of|few)? ?([a-z]+?)s?(?: ago)?$/);
  if (age && UNIT_MS[age[2]]) {
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3, "couple of": 2, few: 3 };
    const n = age[1] == null ? 1 : (words[age[1]] ?? Number(age[1]));
    return { since: now - n * UNIT_MS[age[2]], before: null };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`);
    if (!Number.isNaN(t)) return { since: t, before: t + 86_400_000 };
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split("-").map(Number);
    return { since: Date.UTC(y, m - 1, 1), before: Date.UTC(y, m, 1) };
  }
  const t = Date.parse(String(text).trim());
  if (!Number.isNaN(t) && /\d{4}/.test(s)) return { since: t, before: null };
  throw new Error(`cannot read "${text}" as a time; give ${WHEN_FORMS}`);
}

/** A time in words, a Date or ms as ms: the start of its window. */
export const when = (x, now = Date.now()) => window(x, now).since;

const toNow = (x) => {
  if (x == null || x === "") return Date.now();
  const t = x instanceof Date ? x.getTime() : typeof x === "number" ? x : Date.parse(String(x));
  if (Number.isNaN(t)) throw new Error(`now: "${x}" is not a date; give one like 2026-11-20T12:00:00Z`);
  return t;
};

/** "10MB", "1.5 GB", 2048 as bytes. */
export const bytesOf = (x) => {
  if (x == null || x === "") return null;
  if (typeof x === "number") return x;
  const m = String(x).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgtp]?)i?b?$/i);
  if (!m) throw new Error(`cannot read "${x}" as a size; give bytes or a size such as "500KB", "10MB", "1.5GB"`);
  return Math.round(Number(m[1]) * 1024 ** " kmgtp".indexOf(m[2].toLowerCase() || " "));
};

// ---------- what is never read ----------

// Names that hold credentials wherever they are. Tested on every path segment.
const SECRET_NAME = new RegExp(
  [
    "^\\.env($|[._-])|^\\.envrc$",
    "\\.(pem|key|p12|pfx|jks|keystore|kdbx?|ovpn|ppk|keychain(-db)?|mbox|agekey)$",
    "^id_[a-z0-9_-]+(\\.pub)?$|^ssh_host_.*_key",
    "credential|secret|token(?!iz)|passw|passphrase",
    "backup[-_ ]?codes?|recovery[-_ ]?(codes?|keys?)|(^|[-_ .])(2fa|totp|mfa)([-_ .]|$)|seed[-_ ]?phrase|mnemonic|^\\.claude\\.json",
    "^[._]?netrc$|^\\.npmrc$|^\\.yarnrc(\\.yml)?$|^\\.pypirc$|^\\.git-credentials$|^\\.pgpass$|^\\.my\\.cnf$|^\\.s3cfg$|^\\.boto$|^\\.htpasswd$|^\\.dockercfg$|^\\.vault-token$|^kubeconfig",
    "^\\.[a-z_-]*history$|^fish_history$|^\\.histfile$|^\\.zhistory$|^\\.lesshst$|^\\.viminfo$|^ConsoleHost_history\\.txt$|^history\\.jsonl$",
    "^(cookies|login data|web data|logins\\.json|key[34]\\.db|cookies\\.sqlite|places\\.sqlite|wallet\\.dat)(-journal|-wal|-shm)?$",
    "^auth\\.json$|^hosts\\.yml$|^\\.?oauth.*\\.(json|ya?ml)$",
    // Folders that are credential, mail or key stores under any parent.
    "^\\.(ssh|gnupg|aws|azure|kube|oci|password-store|pki|mozilla|thunderbird|mail|1password|electrum|bitcoin|ethereum|terraform\\.d)$|^maildir$|^keychains$|^keyrings$",
  ].join("|"),
  "i",
);
// App folders that hold profiles, sessions and tokens, when they sit in a place apps keep data.
const SECRET_APPDIR =
  /(^|\/)(\.config|\.local\/share|Library|Library\/(Application Support|Containers|Group Containers)|AppData\/(Local|Roaming|LocalLow)|\.var\/app\/[^/]+\/(config|data)|snap\/[^/]+\/[^/]+(\/\.config)?)\/(1Password|gcloud|gh|glab-cli|anthropic|Claude|Codex|github-copilot|google-chrome[^/]*|chromium[^/]*|BraveSoftware|microsoft-edge[^/]*|vivaldi[^/]*|opera[^/]*|Google\/Chrome[^/]*|Microsoft\/(Edge|Credentials|Protect|Vault)|Mozilla|Firefox|Safari|Cookies|Messages|Mail|Thunderbird|evolution|discord|Slack|Signal|Telegram[^/]*|op|rclone|sops|ask-kit|openrouter|Bitwarden[^/]*|KeePass[^/]*|keepassxc|Code|JetBrains|configstore|doctl|heroku|stripe|netlify|hub)(\/|$)/i;
const SECRET_PATH = /(^|\/)\.docker\/config\.json$/i;
const WHY_SECRET = "credentials, keys, browser profiles, password stores, mail and shell history are never read or listed, because what this kit reads goes to a cloud model";

// Pruned from walks unless `all` is set: big trees that are not the user's documents.
const PRUNE = new Set(["node_modules", ".git", ".hg", ".svn", ".cache", ".npm", ".pnpm-store", ".yarn", ".cargo", ".rustup", ".gradle", ".m2", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "target", ".next", ".nuxt", ".turbo", ".steam", "steamapps", ".wine", ".nvm", ".bun", ".asdf", ".pyenv", ".rbenv", ".nix-profile", ".var", "Pods", "DerivedData", ".Trash", ".Spotlight-V100", ".fseventsd", "lost+found", "site-packages", ".terraform"]);
// Folders pruned by their path: other programs' data, and the session transcripts of coding agents
// (the sessions and mike kits answer about those).
const PRUNE_PATHS = "\\.local/share/(Steam|flatpak|containers|Trash)|\\.(claude|codex)/(projects|sessions|\\.cache|shell-snapshots|todos)|Library/Caches|snap/[^/]+/\\d+";
const PRUNE_PATH = new RegExp(`(^|/)(${PRUNE_PATHS})$`);
const PRUNE_UNDER = new RegExp(`(^|/)(${PRUNE_PATHS})(/|$)`);
const VIRTUAL = /^\/(proc|sys|dev|run)(\/|$)/;

// ---------- kinds and types ----------

export const KINDS = {
  document: "pdf doc docx odt rtf txt md markdown pages tex epub xls xlsx ods ppt pptx odp key numbers",
  image: "jpg jpeg png gif webp heic heif bmp tiff tif svg raw cr2 nef arw dng ico avif psd xcf",
  archive: "zip tar gz tgz bz2 tbz2 xz txz zst 7z rar jar iso dmg deb rpm apk whl",
  video: "mp4 mkv mov avi webm m4v wmv flv mpg mpeg",
  audio: "mp3 flac wav ogg m4a aac opus wma aiff",
  code: "js mjs cjs ts tsx jsx py rs go java c h cpp hpp cs rb sh bash php swift kt lua sql html css",
  data: "json jsonl ndjson csv tsv xml yaml yml toml parquet sqlite sqlite3 db",
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, list]) => list.split(" ").map((e) => [e, k])));
const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
};
const kindOf = (name) => KIND_OF.get(extOf(name)) ?? "other";

const ZIP_TYPES = { docx: "Word document (docx)", xlsx: "Excel workbook (xlsx)", pptx: "PowerPoint presentation (pptx)", odt: "OpenDocument text (odt)", ods: "OpenDocument spreadsheet (ods)", odp: "OpenDocument presentation (odp)", epub: "EPUB book", jar: "Java archive (jar)", apk: "Android package (apk)", whl: "Python wheel" };
const TEXT_TYPES = { md: "Markdown text", markdown: "Markdown text", json: "JSON text", csv: "CSV text", tsv: "TSV text", yaml: "YAML text", yml: "YAML text", toml: "TOML text", html: "HTML text", htm: "HTML text", xml: "XML text", svg: "SVG image (XML text)", log: "log text" };

/** A file's type from its first bytes: {type, text (whether it reads as text)}. */
function sniffBytes(b, name) {
  const ext = extOf(name);
  if (!b.length) return { type: "empty file", text: true };
  const at = (sig, off = 0) => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
  const str = (s, off = 0) => b.length >= off + s.length && b.toString("latin1", off, off + s.length) === s;
  const bin = (type) => ({ type, text: false });
  if (str("%PDF-")) return bin("PDF document");
  if (at([0x50, 0x4b, 0x03, 0x04]) || at([0x50, 0x4b, 0x05, 0x06])) return bin(ZIP_TYPES[ext] ?? "ZIP archive");
  if (at([0x1f, 0x8b])) return bin(/\.(tar\.gz|tgz)$/i.test(name) ? "gzip-compressed tar archive" : "gzip-compressed file");
  if (str("BZh")) return bin("bzip2-compressed file");
  if (at([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return bin("xz-compressed file");
  if (at([0x28, 0xb5, 0x2f, 0xfd])) return bin("zstd-compressed file");
  if (at([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return bin("7z archive");
  if (str("Rar!")) return bin("RAR archive");
  if (str("ustar", 257)) return bin("tar archive");
  if (at([0x89, 0x50, 0x4e, 0x47])) return bin("PNG image");
  if (at([0xff, 0xd8, 0xff])) return bin("JPEG image");
  if (str("GIF8")) return bin("GIF image");
  if (str("RIFF") && str("WEBP", 8)) return bin("WebP image");
  if (str("RIFF") && str("WAVE", 8)) return bin("WAV audio");
  if (str("RIFF") && str("AVI ", 8)) return bin("AVI video");
  if (str("BM") && ext === "bmp") return bin("BMP image");
  if (str("II*\u0000") || str("MM\u0000*")) return bin("TIFF image");
  if (str("ftyp", 4)) {
    const brand = b.toString("latin1", 8, 12);
    return bin(/hei[cfx]|mif1|avif/.test(brand) ? "HEIF/AVIF image" : /M4A/.test(brand) ? "M4A audio" : brand.startsWith("qt") ? "QuickTime video" : "MP4 video");
  }
  if (at([0x1a, 0x45, 0xdf, 0xa3])) return bin(ext === "webm" ? "WebM video" : "Matroska video");
  if (str("ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ext === "mp3")) return bin("MP3 audio");
  if (str("fLaC")) return bin("FLAC audio");
  if (str("OggS")) return bin("Ogg audio or video");
  if (str("\u007fELF")) return bin("ELF program or library");
  if (at([0xcf, 0xfa, 0xed, 0xfe]) || at([0xca, 0xfe, 0xba, 0xbe]) || at([0xfe, 0xed, 0xfa, 0xcf])) return bin(ext === "class" ? "Java class" : "Mach-O program or library");
  if (str("MZ") && /^(exe|dll|sys|msi|efi)$/.test(ext)) return bin("PE program or library (exe, dll)");
  if (str("SQLite format 3\u0000")) return bin("SQLite database");
  if (at([0xd0, 0xcf, 0x11, 0xe0])) return bin("old Microsoft Office file (doc, xls or ppt)");
  if (str("{\\rtf")) return { type: "RTF document", text: true };
  if (at([0xff, 0xfe]) || at([0xfe, 0xff])) return { type: "UTF-16 text", text: true, utf16: at([0xff, 0xfe]) ? "le" : "be" };
  let odd = 0;
  for (const c of b) {
    if (c === 0) return bin("binary data");
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) odd++;
  }
  if (odd > b.length / 20) return bin("binary data");
  const head = b.toString("utf8", 0, 200).trimStart().toLowerCase();
  if (head.startsWith("#!")) return { type: `script (${head.slice(2, 60).split("\n")[0].trim()})`, text: true };
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return { type: "HTML text", text: true };
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return { type: TEXT_TYPES[ext] ?? "XML text", text: true };
  return { type: TEXT_TYPES[ext] ?? (KIND_OF.get(ext) === "code" ? `source code (${ext})` : "plain text"), text: true };
}

// ---------- redaction of text that is read ----------

const KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const TOKEN_SHAPES = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
const ASSIGNED = /((?:passw(?:or)?d|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization)[\w-]*["']?\s*[:=]\s*(?:bearer\s+)?["']?)([^\s"',;]{4,})/gi;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;
/** A line with passwords, tokens and URL passwords replaced. */
export const redact = (line) => line.replace(TOKEN_SHAPES, "<redacted>").replace(URL_PASSWORD, "$1<redacted>$3").replace(ASSIGNED, "$1<redacted>");

// ---------- zip and tar, read in Node ----------

const MAX_ENTRY = 256 * 1024 * 1024;

/** The entries of a zip from its central directory. Throws with the reason when it is not a readable zip. */
function zipOpen(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        e = i;
        break;
      }
    }
    if (e < 0) throw new Error("not a zip file (no end-of-central-directory record)");
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const loc = e - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error("a zip64 file whose locator is missing");
      const off64 = Number(tail.readBigUInt64LE(loc + 8));
      const rec = Buffer.alloc(56);
      fs.readSync(fd, rec, 0, 56, off64);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error("a zip64 file whose end record is missing");
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOff = Number(rec.readBigUInt64LE(48));
    }
    if (cdSize > 128 * 1024 * 1024) throw new Error(`its directory is ${human(cdSize)}, more than this kit reads`);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const flags = cd.readUInt16LE(p + 8);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      for (let x = p + 46 + nameLen; x + 4 <= p + 46 + nameLen + extraLen; ) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) (usize = Number(cd.readBigUInt64LE(q))), (q += 8);
          if (csize === 0xffffffff) (csize = Number(cd.readBigUInt64LE(q))), (q += 8);
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      const t = cd.readUInt16LE(p + 12);
      const d = cd.readUInt16LE(p + 14);
      const two = (n) => String(n).padStart(2, "0");
      // Zip times are local times with no zone; they are shown as written.
      const modified = d ? `${1980 + (d >> 9)}-${two((d >> 5) & 15)}-${two(d & 31)} ${two(t >> 11)}:${two((t >> 5) & 63)}` : null;
      const mode = cd.readUInt32LE(p + 38) >>> 16;
      entries.push({ name, size: usize, packed: csize, method: cd.readUInt16LE(p + 10), offset, modified, dir: name.endsWith("/"), encrypted: (flags & 1) === 1, link: (mode & 0o170000) === 0o120000 });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, count };
  } finally {
    fs.closeSync(fd);
  }
}

/** One zip entry's bytes. Throws for an encrypted entry, an unknown method or one over `max` bytes. */
function zipRead(file, entry, max = MAX_ENTRY) {
  if (entry.encrypted) throw new Error(`${entry.name} is encrypted`);
  if (entry.size > max) throw new Error(`${entry.name} is ${human(entry.size)}, more than the ${human(max)} this kit unpacks at once`);
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.offset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.name}: its local header is missing`);
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = Buffer.alloc(entry.packed);
    fs.readSync(fd, raw, 0, entry.packed, start);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(max, 1) });
    throw new Error(`${entry.name} uses compression method ${entry.method}, which this kit does not unpack`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Walk a tar or tar.gz as a stream. onEntry({name, size, type, modified, linkTo}) may return a sink
 * {write(chunk), end()} to receive a file's bytes, or false to stop. Resolves {entries, stopped}.
 */
async function tarWalk(file, onEntry, { gzip, deadline }) {
  const source = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  const stream = gzip ? source.pipe(zlib.createGunzip()) : source;
  let buf = Buffer.alloc(0);
  let need = null; // {left, pad, sink, meta}
  let longName = null;
  let pax = {};
  let entries = 0;
  let stopped = null;
  const text = (b, from, len) => {
    const s = b.toString("utf8", from, from + len);
    const z = s.indexOf("\u0000");
    return z < 0 ? s : s.slice(0, z);
  };
  const num = (b, from, len) => {
    if (b[from] & 0x80) {
      let n = 0;
      for (let i = from + 1; i < from + len; i++) n = n * 256 + b[i];
      return n;
    }
    return parseInt(text(b, from, len).trim() || "0", 8) || 0;
  };
  try {
    for await (const chunk of stream) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (need) {
          if (need.left) {
            if (!buf.length) break;
            const take = Math.min(need.left, buf.length);
            if (need.sink) need.sink.write(buf.subarray(0, take));
            else if (need.meta) need.meta.push(Buffer.from(buf.subarray(0, take)));
            need.left -= take;
            buf = buf.subarray(take);
            if (need.left) break;
          }
          if (buf.length < need.pad) break;
          buf = buf.subarray(need.pad);
          if (need.sink) need.sink.end();
          if (need.meta) {
            const body = Buffer.concat(need.meta).toString("utf8");
            if (need.kind === "L") longName = body.replace(/\u0000+$/, "");
            else if (need.kind === "x") for (const m of body.matchAll(/\d+ ([^=\n]+)=([^\n]*)\n/g)) pax[m[1]] = m[2];
          }
          need = null;
          continue;
        }
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((x) => x === 0)) {
          stopped = null;
          source.destroy();
          return { entries, stopped };
        }
        const flag = String.fromCharCode(h[156] || 48);
        const size = num(h, 124, 12);
        const pad = (512 - (size % 512)) % 512;
        if (flag === "L" || flag === "x" || flag === "g" || flag === "K") {
          need = { left: size, pad, meta: flag === "L" || flag === "x" ? [] : null, kind: flag };
          continue;
        }
        const prefix = text(h, 257, 5) === "ustar" ? text(h, 345, 155) : "";
        const name = pax.path ?? longName ?? (prefix ? `${prefix}/` : "") + text(h, 0, 100);
        const realSize = pax.size != null ? Number(pax.size) : size;
        const type = flag === "5" || name.endsWith("/") ? "dir" : flag === "0" || flag === "7" ? "file" : flag === "2" ? "symlink" : flag === "1" ? "hardlink" : "other";
        longName = null;
        pax = {};
        entries++;
        const sink = onEntry({ name, size: type === "file" ? realSize : 0, type, modified: num(h, 136, 12) * 1000, linkTo: type === "symlink" || type === "hardlink" ? text(h, 157, 100) : undefined, mode: num(h, 100, 8) });
        if (sink === false || (deadline && Date.now() > deadline)) {
          stopped = sink === false ? "limit" : "time";
          source.destroy();
          return { entries, stopped };
        }
        const bodySize = type === "file" || type === "other" ? realSize : 0;
        need = { left: bodySize, pad: (512 - (bodySize % 512)) % 512, sink: sink && typeof sink === "object" ? sink : null };
      }
    }
  } catch (e) {
    if (need?.sink) need.sink.end();
    return { entries, stopped: null, error: e.message };
  }
  if (need?.sink) need.sink.end();
  return { entries, stopped, ...(need?.left ? { error: "the archive ends in the middle of a file" } : {}) };
}

// ---------- text out of office files ----------

const unxml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");

function officeText(file, ext) {
  const { entries } = zipOpen(file);
  const by = new Map(entries.map((e) => [e.name, e]));
  const xml = (name) => (by.has(name) ? zipRead(file, by.get(name), 64 * 1024 * 1024).toString("utf8") : null);
  const numbered = (re) => entries.filter((e) => re.test(e.name)).sort((a, b) => Number(a.name.match(/(\d+)\.xml$/)[1]) - Number(b.name.match(/(\d+)\.xml$/)[1]));
  const lines = [];
  if (ext === "docx") {
    const doc = xml("word/document.xml");
    if (doc == null) throw new Error("no word/document.xml inside: not a Word document");
    for (const para of doc.split(/<\/w:p>/)) {
      const style = /<w:pStyle w:val="([^"]+)"/.exec(para)?.[1] ?? "";
      const level = /^(?:heading|titre|berschrift|\u00dcberschrift)\s?(\d)$/i.exec(style)?.[1] ?? (/^title$/i.test(style) ? 1 : 0);
      let t = "";
      for (const m of para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\s*\/?>|<w:cr\/>/g)) t += m[1] != null ? unxml(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n";
      if (t.trim() || lines.at(-1) !== "") lines.push(...((level && t.trim() ? `${"#".repeat(Number(level))} ` : "") + t).split("\n"));
    }
  } else if (ext === "pptx") {
    const slides = numbered(/^ppt\/slides\/slide\d+\.xml$/);
    if (!slides.length) throw new Error("no slides inside: not a PowerPoint presentation");
    slides.forEach((s, i) => {
      lines.push(`## Slide ${i + 1}`);
      for (const para of zipRead(file, s, 64 * 1024 * 1024).toString("utf8").split(/<\/a:p>/)) {
        const t = [...para.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unxml(m[1])).join("");
        if (t.trim()) lines.push(t);
      }
      lines.push("");
    });
  } else if (ext === "xlsx") {
    const shared = (xml("xl/sharedStrings.xml") ?? "").split(/<\/si>/).slice(0, -1).map((si) => [...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unxml(m[1])).join(""));
    const book = xml("xl/workbook.xml");
    if (book == null) throw new Error("no xl/workbook.xml inside: not an Excel workbook");
    const rels = new Map([...(xml("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\s[^>]*>/g)].map((m) => [/\sId="([^"]+)"/.exec(m[0])?.[1], /\sTarget="([^"]+)"/.exec(m[0])?.[1]]));
    const sheets = [...book.matchAll(/<sheet\s[^>]*>/g)].map((m) => ({ name: unxml(/\sname="([^"]*)"/.exec(m[0])?.[1] ?? ""), target: rels.get(/\sr:id="([^"]+)"/.exec(m[0])?.[1]) }));
    for (const [i, s] of sheets.entries()) {
      const target = s.target ? (s.target.startsWith("/") ? s.target.slice(1) : `xl/${s.target}`) : `xl/worksheets/sheet${i + 1}.xml`;
      const sheet = xml(target);
      lines.push(`## ${s.name || `Sheet ${i + 1}`}`);
      if (sheet == null) continue;
      let rows = 0;
      for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        if (++rows > 5000) {
          lines.push("(rows after the first 5000 are left out)");
          break;
        }
        const cells = [];
        for (const c of row[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = /(?:^|\s)r="([A-Z]+)\d+"/.exec(c[1])?.[1];
          const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
          const kind = /(?:^|\s)t="(\w+)"/.exec(c[1])?.[1];
          const v = /<v>([^<]*)<\/v>/.exec(c[2] ?? "")?.[1];
          const inline = [...(c[2] ?? "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unxml(m[1])).join("");
          if (col < 60) cells[col] = kind === "s" ? (shared[Number(v)] ?? "") : kind === "inlineStr" ? inline : kind === "b" ? (v === "1" ? "TRUE" : "FALSE") : unxml(v ?? "");
        }
        lines.push(Array.from(cells, (x) => x ?? "").join("\t").trimEnd());
      }
      lines.push("");
    }
  } else {
    const content = xml("content.xml");
    if (content == null) throw new Error("no content.xml inside: not an OpenDocument file");
    let t = "";
    let inRow = 0;
    let head = "";
    const flush = () => {
      lines.push(head + t);
      t = "";
      head = "";
    };
    for (const m of content.matchAll(/<text:h\b[^>]*>|<\/text:[hp]>|<text:tab\/>|<text:line-break\/>|<text:s\b[^>]*\/>|<\/table:table-cell>|<table:table-row\b[^>]*>|<\/table:table-row>|<table:table\s[^>]*>|<draw:page\s[^>]*>|<[^>]+>|[^<]+/g)) {
      const x = m[0];
      if (x[0] !== "<") t += unxml(x);
      else if (x.startsWith("<text:h")) head = `${"#".repeat(Number(/outline-level="(\d)"/.exec(x)?.[1] ?? 1))} `;
      else if (x === "</text:h>" || x === "</text:p>") inRow ? null : flush();
      else if (x === "<text:tab/>") t += "\t";
      else if (x === "<text:line-break/>") t += inRow ? " " : "\n";
      else if (x.startsWith("<text:s")) t += " ".repeat(Number(/text:c="(\d+)"/.exec(x)?.[1] ?? 1));
      else if (x === "</table:table-cell>") t += "\t";
      else if (x.startsWith("<table:table-row")) inRow++;
      else if (x === "</table:table-row>") {
        inRow = Math.max(0, inRow - 1);
        t = t.trimEnd();
        if (!inRow) flush();
      } else if (x.startsWith("<table:table ")) lines.push(`## ${unxml(/table:name="([^"]*)"/.exec(x)?.[1] ?? "table")}`);
      else if (x.startsWith("<draw:page ")) lines.push(`## ${unxml(/draw:name="([^"]*)"/.exec(x)?.[1] ?? "page")}`);
    }
    if (t.trim()) flush();
  }
  const all = lines.join("\n").split("\n");
  while (all.length && !all.at(-1).trim()) all.pop();
  return all;
}
const OFFICE = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);
const DOC_EXT = new Set(["pdf", ...OFFICE]);

// ---------- the global ----------

export function make({ settings = {}, push = () => {}, cwd, act = false } = {}) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const home = os.homedir();
  const realHome = real(home);
  const workdir = real(path.resolve(settings.WORKDIR || process.env.WORKDIR || cwd || process.cwd()));
  const tilde = (s) => (s === "~" ? home : s.startsWith("~/") ? path.join(home, s.slice(2)) : s);
  const inside = (root, p) => {
    const rel = path.relative(root, p);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  const named = String(settings.FILES_ROOTS || process.env.FILES_ROOTS || "~").split(",").map((s) => s.trim()).filter(Boolean).map((s) => real(path.resolve(workdir, tilde(s))));
  // The caller's folder is always a root: the agent works there already.
  const roots = [...new Set([...named, workdir])];
  // For walking everything: roots that are not inside another root.
  const outer = roots.filter((r) => !roots.some((o) => o !== r && inside(o, r)));
  const shown = (p) => (p === realHome || p === home ? "~" : inside(realHome, p) ? `~${path.sep}${path.relative(realHome, p)}` : p);
  const rootsShown = roots.map(shown).join(", ");
  const note = (kind, detail, started, code = 0, size = 0) => push({ kind: `files.${kind}`, detail: String(detail).slice(0, 200), ms: Date.now() - started, code, size });

  const secretWhy = (abs) => {
    const p = abs;
    if (SECRET_PATH.test(p)) return ".docker/config.json";
    const app = SECRET_APPDIR.exec(p);
    if (app) return `${app[2]}/${app[6] ?? ""}`.replace(/\/$/, "");
    for (const seg of p.split("/")) if (seg && SECRET_NAME.test(seg)) return seg;
    return null;
  };
  const refuseSecret = (abs, why) => {
    throw new Error(`refused: ${shown(abs)} is off limits (${why}): ${WHY_SECRET}. files.info(path) gives its size and dates; its content is not available through this kit.`);
  };

  /** A path from the caller as a real absolute path inside a root. Throws when it is outside, virtual or secret. */
  const locate = (p, { secretOk = false, what = "path" } = {}) => {
    const s = tilde(String(p ?? "").trim());
    if (!s) throw new Error(`\`${what}\` is needed: a path, absolute, with ~ or relative to ${shown(workdir)}`);
    let abs = path.resolve(workdir, s);
    if (!path.isAbsolute(s) && !fs.existsSync(abs)) {
      // "Downloads/x.pdf" asked from a project folder means the one under a root.
      for (const r of roots) {
        if (fs.existsSync(path.resolve(r, s))) {
          abs = path.resolve(r, s);
          break;
        }
      }
    }
    // Resolve links in the part that exists, so a link cannot lead out of the roots.
    let head = abs;
    const rest = [];
    while (!fs.existsSync(head) && path.dirname(head) !== head) {
      rest.unshift(path.basename(head));
      head = path.dirname(head);
    }
    const full = path.join(real(head), ...rest);
    if (VIRTUAL.test(full)) throw new Error(`refused: ${full} is a virtual filesystem (/proc, /sys, /dev, /run), not files`);
    if (!roots.some((r) => inside(r, full))) throw new Error(`refused: ${shown(full)} is outside the folders this kit may look in (${rootsShown}). The setting FILES_ROOTS names them; add the folder there to allow it.`);
    const why = secretWhy(full) ?? secretWhy(abs);
    if (why && !secretOk) refuseSecret(full, why);
    return full;
  };

  const lstat = (p) => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };
  /** Names in a missing path's folder that look like it, for the error. */
  const near = (abs) => {
    const dir = path.dirname(abs);
    const want = path.basename(abs).toLowerCase().replace(/\.[^.]+$/, "");
    try {
      const names = fs.readdirSync(dir).filter((n) => !SECRET_NAME.test(n));
      const words = want.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const close = names.filter((n) => words.some((w) => n.toLowerCase().includes(w)));
      return { folder: shown(dir), has: (close.length ? close : names).slice(0, 12) };
    } catch {
      let up = dir;
      while (!fs.existsSync(up) && path.dirname(up) !== up) up = path.dirname(up);
      return { folder: shown(dir), folderExists: false, nearestFolder: shown(up) };
    }
  };
  const missing = (abs) => ({ path: shown(abs), error: `no such file or folder: ${shown(abs)}`, ...near(abs) });

  // Optional programs, looked up on PATH once.
  const found = new Map();
  const program = (name) => {
    if (found.has(name)) return found.get(name);
    let hit = null;
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const c = path.join(dir, name);
      try {
        if (dir && fs.statSync(c).isFile()) {
          hit = c;
          break;
        }
      } catch {}
    }
    found.set(name, hit);
    return hit;
  };
  const run = (bin, args, { timeout = 30_000, max = 64 * 1024 * 1024, env } = {}) =>
    new Promise((resolve) => {
      const started = Date.now();
      execFile(bin, args, { timeout, maxBuffer: max, encoding: "utf8", killSignal: "SIGKILL", env: env ?? process.env }, (err, out, errText) => {
        const r = { code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: out ?? "", err: (errText ?? "").trim() || (err && typeof err.code !== "number" ? err.message : ""), timedOut: !!err?.killed };
        note("run", `${path.basename(bin)} ${args.join(" ")}`, started, r.code, r.out.length);
        resolve(r);
      });
    });

  /**
   * Breadth-first walk of one folder, so the nearest files are seen before the budget ends.
   * onFile(path, name, level, dirPath), onDir(path, name, level, stat), onSecret(path, isDir, dirPath).
   */
  function walk(start, o, { onFile, onDir, onSecret } = {}) {
    const t0 = Date.now();
    const deadline = o.deadline ?? t0 + (o.ms ?? 10_000);
    const depth = o.depth ?? 16;
    const maxEntries = o.maxEntries ?? 1_500_000;
    const st = o.stats ?? { folders: 0, entries: 0, secret: 0, secretIn: new Set(), pruned: 0, hidden: 0, otherMounts: 0, unreadable: 0, links: 0, tooDeep: 0, stopped: null };
    o.stats = st;
    if (st.stopped) return st;
    const startStat = lstat(start);
    if (!startStat?.isDirectory()) return st;
    const queue = [[start, 0]];
    for (let qi = 0; qi < queue.length; qi++) {
      const [dir, level] = queue[qi];
      queue[qi] = null;
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        st.unreadable++;
        continue;
      }
      st.folders++;
      for (const e of ents) {
        st.entries++;
        if (st.entries > maxEntries) st.stopped = `${maxEntries} entries were read`;
        else if ((st.entries & 127) === 0 && Date.now() > deadline) st.stopped = `the time budget of ${Math.round((deadline - t0) / 1000)} s ran out`;
        if (st.stopped) {
          st.stoppedIn = shown(dir);
          st.foldersLeft = queue.length - qi - 1;
          return st;
        }
        const p = dir.endsWith(path.sep) ? dir + e.name : dir + path.sep + e.name;
        if (e.isSymbolicLink()) {
          st.links++;
          continue;
        }
        if (o.hidden === false && e.name.startsWith(".")) {
          st.hidden++;
          continue;
        }
        const isDir = e.isDirectory();
        if (SECRET_NAME.test(e.name) || (isDir && SECRET_APPDIR.test(p)) || (e.name === "config.json" && SECRET_PATH.test(p))) {
          st.secret++;
          if (st.secretIn.size < 200) st.secretIn.add(shown(dir));
          onSecret?.(p, isDir, dir);
          continue;
        }
        if (isDir) {
          if (!o.all && (PRUNE.has(e.name) || PRUNE_PATH.test(p))) {
            st.pruned++;
            continue;
          }
          if (VIRTUAL.test(p)) continue;
          let s = null;
          if (!o.mounts || onDir) {
            s = lstat(p);
            if (!s) continue;
            if (!o.mounts && s.dev !== startStat.dev) {
              st.otherMounts++;
              continue;
            }
          }
          onDir?.(p, e.name, level + 1, s, dir);
          if (level + 1 < depth) queue.push([p, level + 1]);
          else st.tooDeep++;
        } else if (e.isFile()) onFile?.(p, e.name, level + 1, dir);
      }
    }
    return st;
  }
  const walkReport = (st, started) => ({
    searched: { folders: st.folders, entries: st.entries, ms: Date.now() - started },
    ...(st.stopped ? { stopped: `stopped early: ${st.stopped}, in ${st.stoppedIn}, with ${plural(st.foldersLeft, "folder")} not yet opened. The result is partial: name a smaller folder with \`under\`, or raise \`ms\`.` } : {}),
    skipped: {
      ...(st.secret ? { private: st.secret, privateIn: [...st.secretIn].slice(0, 6) } : {}),
      ...(st.pruned ? { pruned: st.pruned } : {}),
      ...(st.hidden ? { hidden: st.hidden } : {}),
      ...(st.otherMounts ? { otherMounts: st.otherMounts } : {}),
      ...(st.unreadable ? { unreadable: st.unreadable } : {}),
      ...(st.links ? { links: st.links } : {}),
      ...(st.tooDeep ? { tooDeep: st.tooDeep } : {}),
    },
  });
  /** Where a walk starts: one folder the caller named, or every outer root. */
  const starts = (under) => {
    if (under == null || under === "") return { dirs: outer, error: null };
    const list = [].concat(under).map((u) => locate(u, { what: "under" }));
    for (const d of list) {
      const s = lstat(d);
      if (!s) return { error: missing(d) };
      if (!s.isDirectory()) return { error: { path: shown(d), error: `${shown(d)} is a file, not a folder; \`under\` takes a folder` } };
    }
    return { dirs: list };
  };

  const exts = (ext, kind) => {
    const set = new Set();
    for (const e of [].concat(ext ?? []).flatMap((x) => String(x).split(/[\s,]+/))) if (e) set.add(e.replace(/^\*?\./, "").toLowerCase());
    let folders = false;
    for (const k of [].concat(kind ?? []).flatMap((x) => String(x).split(/[\s,]+/))) {
      if (!k) continue;
      const key = k.toLowerCase().replace(/s$/, "");
      if (key === "folder" || key === "directory" || key === "dir") folders = true;
      else if (key === "pdf" || KIND_OF.has(key)) set.add(key);
      else if (KINDS[key]) for (const e of KINDS[key].split(" ")) set.add(e);
      else throw new Error(`no kind "${k}"; have: ${Object.keys(KINDS).join(", ")}, folder (or give \`ext\`)`);
    }
    return { set: set.size ? set : null, folders };
  };

  /** A name as the caller gave it, as tests on a base name and on a path. */
  const nameTest = (name) => {
    const s = String(name).trim();
    const re = /^\/(.+)\/([a-z]*)$/.exec(s);
    if (re) {
      let r;
      try {
        r = new RegExp(re[1], re[2].includes("i") ? re[2] : `${re[2]}i`);
      } catch (e) {
        throw new Error(`name: ${s} is not a regular expression (${e.message})`);
      }
      return { how: "regular expression on the name", base: (n) => r.test(n) };
    }
    if (/[*?]/.test(s)) {
      const r = new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
      return s.includes("/") ? { how: "glob on the path", path: (p) => r.test(p) || r.test(p.split("/").slice(-s.split("/").length).join("/")) } : { how: "glob on the name", base: (n) => r.test(n) };
    }
    const lower = s.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    return { how: "words", exact: lower, words };
  };

  const row = (p, s, now, extra) => ({ path: shown(p), bytes: s.size, size: human(s.size), modified: iso(s.mtimeMs), age: ago(s.mtimeMs, now), ...extra });

  /** A name index, when the machine has one: paths whose name holds the words. Null when there is none. */
  async function indexed(words, dirs) {
    const pick = [...words].sort((a, b) => b.length - a.length)[0];
    let r = null;
    let via = null;
    if (process.platform === "darwin" && program("mdfind")) {
      via = "mdfind";
      r = await run(program("mdfind"), [...dirs.flatMap((d) => ["-onlyin", d]), "-name", pick], { timeout: 8000 });
    } else if (program("plocate") || program("locate")) {
      via = program("plocate") ? "plocate" : "locate";
      r = await run(program(via), ["-i", "-l", "5000", "--", pick], { timeout: 8000 });
    }
    if (!r) return null;
    if (r.code === 1 && !r.out && !r.err) return { via, paths: [] };
    if (r.code !== 0 && !r.out) return { via, error: r.err || `${via} exited ${r.code}`, paths: [] };
    return { via, paths: r.out.split("\n").filter(Boolean) };
  }

  async function find(o = {}) {
    const started = Date.now();
    const now = toNow(o.now);
    const { set: extSet, folders: wantFolders } = exts(o.ext, o.kind);
    const since = o.modifiedSince != null && o.modifiedSince !== "" ? when(o.modifiedSince, now) : null;
    const before = o.modifiedBefore != null && o.modifiedBefore !== "" ? when(o.modifiedBefore, now) : null;
    const minSize = bytesOf(o.minSize);
    const maxSize = bytesOf(o.maxSize);
    const limit = Math.max(1, Math.min(Number(o.limit ?? 50) || 50, 2000));
    const created = o.by === "created";
    const st = starts(o.under);
    if (st.error) return { ...st.error, files: [], matched: 0 };
    const test = o.name != null && String(o.name).trim() ? nameTest(o.name) : null;
    const buckets = { exact: [], words: [], path: [] };
    const time = (s) => (created ? Math.max(s.mtimeMs, s.birthtimeMs || 0) : s.mtimeMs);
    const consider = (p, name, isDir, s0) => {
      if (isDir !== wantFolders) return;
      if (!isDir && extSet && !extSet.has(extOf(name))) return;
      let bucket = "words";
      if (test) {
        if (test.base) {
          if (!test.base(name)) return;
        } else if (test.path) {
          if (!test.path(p)) return;
        } else {
          const lower = name.toLowerCase();
          if (lower === test.exact || lower.replace(/\.[^.]+$/, "") === test.exact) bucket = "exact";
          else if (test.words.every((w) => lower.includes(w))) bucket = "words";
          else {
            const full = p.toLowerCase();
            if (!test.words.every((w) => full.includes(w)) || !test.words.some((w) => lower.includes(w))) return;
            bucket = "path";
          }
        }
      }
      const s = s0 ?? lstat(p);
      if (!s) return;
      const t = time(s);
      if (since != null && t < since) return;
      if (before != null && t >= before) return;
      if (!isDir && minSize != null && s.size < minSize) return;
      if (!isDir && maxSize != null && s.size > maxSize) return;
      if (buckets[bucket].length < 100_000) buckets[bucket].push({ p, s, t, isDir });
    };
    const opts = { depth: o.depth, ms: o.ms, deadline: started + Math.min(Number(o.ms ?? 10_000) || 10_000, 120_000), all: !!o.all, mounts: !!o.mounts };
    for (const d of st.dirs) walk(d, opts, { onFile: (p, name) => consider(p, name, false), onDir: wantFolders ? (p, name, _l, s) => consider(p, name, true, s) : undefined });
    const stats = opts.stats;
    let index;
    if (stats?.stopped && test?.words) {
      // The walk ran out of budget: ask the machine's name index for the rest.
      const hit = await indexed(test.words, st.dirs);
      if (!hit) index = "the walk was cut short and this machine has no name index (mdfind, plocate or locate) to ask instead";
      else if (hit.error) index = `${hit.via} was asked and failed: ${hit.error}`;
      else {
        const have = new Set(Object.values(buckets).flat().map((x) => x.p));
        let added = 0;
        for (const p of hit.paths) {
          if (have.has(p) || !st.dirs.some((d) => inside(d, p)) || secretWhy(p)) continue;
          const s = lstat(p);
          if (!s || s.isSymbolicLink()) continue;
          const n = Object.values(buckets).reduce((a, b) => a + b.length, 0);
          consider(p, path.basename(p), s.isDirectory(), s);
          if (Object.values(buckets).reduce((a, b) => a + b.length, 0) > n) added++;
        }
        index = `${hit.via} (a name index, which can be out of date) added ${plural(added, "match", "matches")} beyond what the walk reached`;
      }
    }
    const used = !test?.words ? "words" : buckets.exact.length ? "exact" : buckets.words.length ? "words" : "path";
    const all = test?.words ? buckets[used] : buckets.words;
    const sort = String(o.sort ?? "newest").toLowerCase();
    const sorts = { newest: (a, b) => b.t - a.t, oldest: (a, b) => a.t - b.t, biggest: (a, b) => b.s.size - a.s.size, largest: (a, b) => b.s.size - a.s.size, smallest: (a, b) => a.s.size - b.s.size, name: (a, b) => path.basename(a.p).localeCompare(path.basename(b.p)) };
    if (!sorts[sort]) throw new Error(`no sort "${o.sort}"; have: newest, oldest, biggest, smallest, name`);
    all.sort(sorts[sort]);
    const out = {
      under: st.dirs.map(shown),
      ...(test && all.length ? { match: test.words ? (used === "exact" ? "exact name" : used === "words" ? (test.words.length > 1 ? "every word is in the name" : "the word is in the name") : "the words are in the path, at least one in the name") : test.how } : {}),
      ...(test?.words && used === "exact" && buckets.words.length ? { alsoByWords: buckets.words.length } : {}),
      matched: all.length,
      files: all.slice(0, limit).map((x) => row(x.p, x.s, now, { ...(x.isDir ? { kind: "folder" } : {}), ...(created && x.s.birthtimeMs ? { created: iso(x.s.birthtimeMs) } : {}) })),
      more: Math.max(0, all.length - limit),
      ...(index ? { index } : {}),
      ...(stats ? walkReport(stats, started) : {}),
    };
    note("find", `${o.name ?? ""} ${[...(extSet ?? [])].slice(0, 6).join(",")} under ${out.under.join(",")}`.trim(), started, 0, all.length);
    return out;
  }

  function sniff(abs, s) {
    if (!s.isFile()) return { type: s.isDirectory() ? "folder" : s.isSymbolicLink() ? "symbolic link" : "special file", text: false };
    let fd;
    try {
      fd = fs.openSync(abs, "r");
      const b = Buffer.alloc(Math.min(4096, s.size));
      const n = fs.readSync(fd, b, 0, b.length, 0);
      return sniffBytes(b.subarray(0, n), path.basename(abs));
    } catch (e) {
      return { type: `unreadable (${e.code ?? e.message})`, text: false, unreadable: true };
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }

  /** Apparent size, except for a big sparse file, which counts what it holds on disk. */
  const diskBytes = (s) => (s.blocks != null && s.size >= 1 << 20 && s.blocks * 512 < s.size ? s.blocks * 512 : s.size);
  const modeText = (m) => [..."rwxrwxrwx"].map((c, i) => (m & (0o400 >> i) ? c : "-")).join("");

  function measure(start, o = {}) {
    // Totals per folder; private folders and files are counted in their parent and not named.
    const dirs = new Map(); // path -> {bytes, files, level, parent}
    const top = [];
    const topN = o.topFiles ?? 15;
    const seen = new Set();
    const kinds = {};
    let privateBytes = 0;
    let newest = 0;
    let fileCount = 0;
    dirs.set(start, { bytes: 0, files: 0, level: 0, parent: null });
    const addFile = (p, name, dir, counted) => {
      const s = lstat(p);
      if (!s) return;
      if (s.nlink > 1) {
        const key = `${s.dev}:${s.ino}`;
        if (seen.has(key)) return;
        seen.add(key);
      }
      const b = diskBytes(s);
      const d = dirs.get(dir);
      d.bytes += b;
      d.files++;
      fileCount++;
      if (!counted) {
        privateBytes += b;
        return;
      }
      if (s.mtimeMs > newest) newest = s.mtimeMs;
      const k = kindOf(name);
      kinds[k] = (kinds[k] ?? 0) + b;
      if (top.length < topN || b > top.at(-1).b) {
        top.push({ p, b, s });
        top.sort((a, z) => z.b - a.b);
        if (top.length > topN) top.pop();
      }
    };
    const opts = { depth: 64, ms: o.ms ?? 10_000, maxEntries: o.maxEntries ?? 2_000_000, all: true, mounts: !!o.mounts };
    const privateDirs = [];
    const hard = Date.now() + opts.ms + 2000;
    walk(start, opts, {
      onFile: (p, name, _l, dir) => addFile(p, name, dir, true),
      onDir: (p, _n, level, _s, dir) => dirs.set(p, { bytes: 0, files: 0, level, parent: dir }),
      onSecret: (p, isDir, dir) => (isDir ? privateDirs.push([p, dir]) : addFile(p, "", dir, false)),
    });
    // A private folder is measured, never listed: its bytes go to the folder that holds it.
    for (const [p, dir] of privateDirs) {
      const stack = [p];
      while (stack.length && Date.now() < hard) {
        const d = stack.pop();
        let ents = [];
        try {
          ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {}
        for (const e of ents) {
          const q = path.join(d, e.name);
          if (e.isDirectory()) stack.push(q);
          else if (e.isFile()) addFile(q, "", dir, false);
        }
      }
    }
    // Children before parents: longest paths first.
    const order = [...dirs.entries()].sort((a, b) => b[1].level - a[1].level);
    for (const [, d] of order) {
      if (d.parent) {
        const up = dirs.get(d.parent);
        up.bytes += d.bytes;
        up.files += d.files;
      }
    }
    return { dirs, top, kinds, privateBytes, newest, fileCount, stats: opts.stats };
  }

  function info(p, o = {}) {
    const started = Date.now();
    const now = toNow(o.now);
    const abs = locate(p, { secretOk: true });
    const why = secretWhy(abs);
    const s = lstat(abs);
    if (!s) return missing(abs);
    const base = {
      path: shown(abs),
      kind: s.isDirectory() ? "folder" : s.isSymbolicLink() ? "link" : s.isFile() ? "file" : "special",
      bytes: s.size,
      size: human(s.size),
      modified: iso(s.mtimeMs),
      age: ago(s.mtimeMs, now),
      ...(s.birthtimeMs ? { created: iso(s.birthtimeMs) } : {}),
      accessed: iso(s.atimeMs),
      permissions: `${modeText(s.mode)} (${(s.mode & 0o777).toString(8).padStart(3, "0")})`,
    };
    note("info", shown(abs), started);
    if (why) return { ...base, private: true, note: `off limits (${why}): ${WHY_SECRET}. Only its size and dates are given.`, ...(s.isDirectory() ? { bytes: undefined, size: undefined } : {}) };
    if (s.isDirectory()) {
      let ents = [];
      try {
        ents = fs.readdirSync(abs, { withFileTypes: true });
      } catch (e) {
        return { ...base, bytes: undefined, size: undefined, error: `cannot list it: ${e.code ?? e.message}` };
      }
      const m = measure(abs, { ms: o.ms ?? 4000, topFiles: 1 });
      const total = m.dirs.get(abs);
      return {
        ...base,
        bytes: total.bytes,
        size: human(total.bytes),
        entries: ents.length,
        folders: ents.filter((e) => e.isDirectory()).length,
        files: ents.filter((e) => e.isFile()).length,
        hidden: ents.filter((e) => e.name.startsWith(".")).length,
        filesInAll: total.files,
        ...(m.newest ? { newestFile: iso(m.newest), newestAge: ago(m.newest, now) } : {}),
        ...(m.stats.stopped ? { partial: `the total is partial: ${m.stats.stopped}` } : {}),
      };
    }
    const t = sniff(abs, s);
    return { ...base, type: t.type, ext: extOf(path.basename(abs)) || null, ...(s.isSymbolicLink() ? { linkTo: (() => { try { return fs.readlinkSync(abs); } catch { return null; } })() } : {}), ...(s.nlink > 1 ? { hardLinks: s.nlink } : {}) };
  }

  // Text of the documents read last, so reading a PDF in parts runs pdftotext once.
  const textCache = new Map();
  async function textOf(abs, s) {
    const key = `${abs}:${s.size}:${s.mtimeMs}`;
    if (textCache.has(key)) return textCache.get(key);
    const name = path.basename(abs);
    const ext = extOf(name);
    const t = sniff(abs, s);
    let r;
    if (t.unreadable) r = { error: `cannot open it: ${t.type}`, type: t.type };
    else if (t.type === "PDF document") {
      const bin = program("pdftotext");
      if (!bin) r = { type: t.type, error: "this is a PDF and pdftotext is not installed, so its text cannot be read here", need: "pdftotext (the poppler-utils package on Linux, `brew install poppler` on macOS)" };
      else {
        const x = await run(bin, ["-layout", "-enc", "UTF-8", abs, "-"], { timeout: 60_000 });
        if (x.code !== 0) r = { type: t.type, error: `pdftotext failed: ${x.timedOut ? "timed out after 60 s" : x.err || `exit ${x.code}`}` };
        else {
          const pages = x.out.split("\f");
          if (pages.at(-1).trim() === "") pages.pop();
          const lines = [];
          const pageStarts = [];
          for (const pg of pages) {
            pageStarts.push(lines.length + 1);
            lines.push(...pg.replace(/\n+$/, "").split("\n"));
          }
          r = { type: t.type, lines, pages: pages.length, pageStarts, ...(lines.every((l) => !l.trim()) ? { note: "the PDF has no text layer (scanned pages or images only); OCR would be needed" } : {}) };
        }
      }
    } else if (OFFICE.has(ext) && /ZIP|document|workbook|presentation|spreadsheet|text/i.test(t.type) && !t.text) {
      try {
        r = { type: t.type, lines: officeText(abs, ext) };
      } catch (e) {
        r = { type: t.type, error: `cannot read it as ${ext}: ${e.message}` };
      }
    } else if (!t.text) {
      const hint = /archive|tar|ZIP|jar|wheel|package/i.test(t.type) ? "; files.list(path) shows what an archive holds" : /SQLite/.test(t.type) ? "; the sqlite kit reads it" : /old Microsoft Office/.test(t.type) ? "; this kit reads docx, xlsx and pptx, not the old binary formats" : "";
      r = { type: t.type, error: `not a text file (${t.type})${hint}` };
    } else {
      const cap = 32 * 1024 * 1024;
      let fd;
      try {
        fd = fs.openSync(abs, "r");
        const b = Buffer.alloc(Math.min(cap, s.size));
        const n = fs.readSync(fd, b, 0, b.length, 0);
        const body = t.utf16 === "le" ? b.toString("utf16le", 2, n) : t.utf16 === "be" ? Buffer.from(b.subarray(2, n)).swap16().toString("utf16le") : b.toString("utf8", 0, n).replace(/^\uFEFF/, "");
        const lines = body.split(/\r?\n/);
        if (lines.at(-1) === "") lines.pop();
        r = { type: t.type, lines, ...(s.size > cap ? { note: `only the first ${human(cap)} of ${human(s.size)} were read` } : {}) };
      } catch (e) {
        r = { type: t.type, error: `cannot read it: ${e.code ?? e.message}` };
      } finally {
        if (fd != null) fs.closeSync(fd);
      }
    }
    if (r.lines?.some((l) => KEY_BLOCK.test(l))) r = { type: r.type, error: `refused: it holds a private key, and ${WHY_SECRET.split(", because ")[1]}`, private: true };
    if (textCache.size >= 6) textCache.delete(textCache.keys().next().value);
    textCache.set(key, r);
    return r;
  }

  async function read(p, o = {}) {
    const started = Date.now();
    const now = toNow(o.now);
    const abs = locate(p);
    const s = lstat(abs);
    if (!s) return missing(abs);
    if (s.isDirectory()) return { path: shown(abs), error: `${shown(abs)} is a folder; files.find({under}) lists it and files.du(path) sizes it` };
    const head = row(abs, s, now);
    const t = await textOf(abs, s);
    note("read", shown(abs), started, t.error ? 1 : 0, s.size);
    if (t.error) return { ...head, ...t };
    const total = t.lines.length;
    const start = Math.max(1, Math.min(Number(o.start ?? 1) || 1, Math.max(total, 1)));
    const want = Math.max(1, Math.min(Number(o.lines ?? 200) || 200, 5000));
    const max = Math.max(200, Math.min(Number(o.max ?? 20_000) || 20_000, 200_000));
    const out = [];
    let chars = 0;
    let end = start - 1;
    for (let i = start - 1; i < total && out.length < want; i++) {
      let line = redact(t.lines[i]);
      if (line.length > 2000) line = `${line.slice(0, 2000)} ... (${line.length - 2000} more characters on this line)`;
      if (chars + line.length > max && out.length) break;
      out.push(o.numbered ? `${i + 1}: ${line}` : line);
      chars += line.length + 1;
      end = i + 1;
    }
    return {
      ...head,
      type: t.type,
      ...(t.pages ? { pages: t.pages, page: t.pageStarts.findLastIndex((x) => x <= start) + 1 } : {}),
      totalLines: total,
      start: total ? start : 0,
      end,
      ...(end < total ? { next: end + 1, left: total - end } : {}),
      ...(t.note ? { note: t.note } : {}),
      text: out.join("\n"),
    };
  }

  /** A document's headings (Markdown and office headings, PDF pages) with their line numbers. */
  async function outline(p, o = {}) {
    const abs = locate(p);
    const s = lstat(abs);
    if (!s) return missing(abs);
    if (s.isDirectory()) return { path: shown(abs), error: `${shown(abs)} is a folder` };
    const t = await textOf(abs, s);
    if (t.error) return { path: shown(abs), ...t };
    const heads = [];
    let fence = false;
    t.lines.forEach((l, i) => {
      if (/^(```|~~~)/.test(l)) fence = !fence;
      if (!fence && /^#{1,6}\s+\S/.test(l)) heads.push({ line: i + 1, text: redact(l).slice(0, 120) });
    });
    const max = Number(o.max ?? 60) || 60;
    return {
      path: shown(abs),
      type: t.type,
      totalLines: t.lines.length,
      ...(t.pages ? { pages: t.pageStarts.slice(0, max).map((line, i) => ({ page: i + 1, line, first: redact(t.lines.slice(line - 1, t.pageStarts[i + 1] ? t.pageStarts[i + 1] - 1 : undefined).find((l) => l.trim()) ?? "").trim().slice(0, 100) })) } : {}),
      headings: heads.slice(0, max),
      ...(heads.length > max ? { moreHeadings: heads.length - max } : {}),
    };
  }

  const patternOf = (x, ignoreCase) => {
    const s = String(x);
    const re = /^\/(.+)\/([a-z]*)$/.exec(s);
    try {
      if (re) return { text: re[1], literal: false, re: new RegExp(re[1], re[2].replace(/[gy]/g, "") || (ignoreCase ? "i" : "")) };
    } catch (e) {
      throw new Error(`pattern: ${s} is not a regular expression (${e.message})`);
    }
    return { text: s, literal: true, re: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "") };
  };
  const clipAround = (line, re, width = 300) => {
    if (line.length <= width) return line;
    const at = Math.max(0, (re.exec(line)?.index ?? 0) - 80);
    return `${at ? "... " : ""}${line.slice(at, at + width)}${at + width < line.length ? " ..." : ""}`;
  };

  async function grep(pattern, o = {}) {
    const started = Date.now();
    const now = toNow(o.now);
    const list = [].concat(pattern ?? []).map((x) => String(x)).filter((x) => x.trim());
    if (!list.length) throw new Error('grep needs a pattern: text, a /regex/, or an array of them that a file must all hold, e.g. files.grep("Vetinari", { under: "~/Documents" })');
    const ignoreCase = o.ignoreCase !== false;
    const pats = list.map((x) => patternOf(x, ignoreCase));
    const st = starts(o.under);
    if (st.error) return { ...st.error, files: [], matchedFiles: 0 };
    const { set: extSet } = exts(o.ext, o.kind);
    const limit = Math.max(1, Math.min(Number(o.limit ?? 30) || 30, 500));
    const perFile = Math.max(1, Math.min(Number(o.perFile ?? 5) || 5, 100));
    const maxSize = bytesOf(o.maxSize) ?? 5 * 1024 * 1024;
    const budget = Math.min(Number(o.ms ?? 15_000) || 15_000, 120_000);
    const deadline = started + budget;
    const hits = [];
    const seenPaths = new Set();
    let engine = "node";
    let stopped = null;
    let report = {};
    const linesOf = (lines) => {
      const got = [];
      let n = 0;
      const held = pats.map(() => false);
      for (let i = 0; i < lines.length; i++) {
        let any = false;
        pats.forEach((pt, k) => {
          if (pt.re.test(lines[i])) {
            held[k] = true;
            any = true;
          }
        });
        if (any) {
          n++;
          if (got.length < perFile) got.push({ line: i + 1, text: redact(clipAround(lines[i].trim(), pats.find((pt) => pt.re.test(lines[i])).re)) });
        }
      }
      return held.every(Boolean) ? { n, got } : null;
    };
    const tryText = (p, s) => {
      if (seenPaths.has(p)) return;
      let body;
      try {
        body = fs.readFileSync(p);
      } catch {
        return;
      }
      if (body.subarray(0, 8192).includes(0) || body.subarray(0, 5).toString("latin1") === "%PDF-") return;
      const text = body.toString("utf8");
      if (KEY_BLOCK.test(text)) return;
      const r = linesOf(text.split(/\r?\n/));
      if (r) {
        seenPaths.add(p);
        hits.push({ p, s, ...r });
      }
    };
    const rg = o.engine === "node" ? null : program("rg");
    if (rg) {
      engine = "rg";
      const first = [...pats].sort((a, b) => b.text.length - a.text.length)[0];
      const args = ["--files-with-matches", "--no-messages", "--no-ignore", ...(o.hidden === false ? [] : ["--hidden"]), "--max-filesize", String(maxSize), "--max-depth", String(o.depth ?? 16)];
      if (ignoreCase) args.push("-i");
      if (!o.mounts) args.push("--one-file-system");
      if (!o.all) for (const d of PRUNE) args.push("-g", `!**/${d}/**`);
      if (!o.all) for (const g of ["**/.local/share/Steam/**", "**/.local/share/flatpak/**", "**/.local/share/containers/**", "**/.claude/projects/**", "**/.claude/shell-snapshots/**", "**/.codex/sessions/**", "**/.claude/todos/**"]) args.push("-g", `!${g}`);
      if (extSet) for (const e of extSet) args.push("-g", `*.${e}`, "-g", `*.${e.toUpperCase()}`);
      args.push(first.literal ? "-F" : "-e", ...(first.literal ? ["-e"] : []), first.text, "--", ...st.dirs);
      const r = await run(rg, args, { timeout: Math.max(1000, budget - 2000) });
      if (r.code > 1 && !r.out && !r.timedOut) engine = "node"; // rg could not take the pattern: walk instead
      else {
        if (r.timedOut) stopped = `rg was stopped after ${Math.round((budget - 2000) / 1000)} s; the result is partial: name a smaller folder with \`under\`, or raise \`ms\``;
        const cands = [];
        for (const p of r.out.split("\n")) {
          // A private file that matched is dropped without a count: a count would tell what it holds.
          if (!p || secretWhy(p)) continue;
          if (!o.all && PRUNE_UNDER.test(p)) continue;
          const s = lstat(p);
          if (s?.isFile()) cands.push({ p, s });
        }
        cands.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
        for (const c of cands) {
          if (Date.now() > deadline) {
            stopped ??= "the time budget ran out while reading the matching files";
            break;
          }
          tryText(c.p, c.s);
        }
        report = {};
      }
    }
    if (engine === "node") {
      const opts = { depth: o.depth, deadline, all: !!o.all, mounts: !!o.mounts, hidden: o.hidden };
      for (const d of st.dirs)
        walk(d, opts, {
          onFile: (p, name) => {
            const e = extOf(name);
            if (extSet ? !extSet.has(e) : DOC_EXT.has(e) || ["image", "video", "audio", "archive"].includes(KIND_OF.get(e))) return;
            const s = lstat(p);
            if (s && s.size <= maxSize && s.size > 0) tryText(p, s);
          },
        });
      report = walkReport(opts.stats, started);
      stopped = report.stopped ?? null;
      delete report.stopped;
    }
    // Documents: PDF and office files are searched through their extracted text when asked.
    let docs;
    if (o.docs) {
      const docOpts = { depth: o.depth, deadline: Math.max(deadline, Date.now() + 3000), all: !!o.all, mounts: !!o.mounts, hidden: o.hidden };
      const found = [];
      for (const d of st.dirs) walk(d, docOpts, { onFile: (p, name) => DOC_EXT.has(extOf(name)) && (!extSet || extSet.has(extOf(name))) && found.push(p) });
      const stats = found.map((p) => ({ p, s: lstat(p) })).filter((x) => x.s).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
      const maxDocs = Number(o.maxDocs ?? 300) || 300;
      const docDeadline = Math.max(deadline, Date.now() + 5000);
      docs = { found: stats.length, searched: 0 };
      const failed = {};
      for (const { p, s } of stats) {
        if (docs.searched >= maxDocs || Date.now() > docDeadline) break;
        if (s.size > 64 * 1024 * 1024) {
          failed["over 64 MB"] = (failed["over 64 MB"] ?? 0) + 1;
          continue;
        }
        docs.searched++;
        const t = await textOf(p, s);
        if (t.error) {
          const k = t.need ? "pdftotext is not installed" : t.error.replace(/:.*/s, "").slice(0, 60);
          failed[k] = (failed[k] ?? 0) + 1;
          continue;
        }
        const r = linesOf(t.lines);
        if (r && !seenPaths.has(p)) {
          seenPaths.add(p);
          hits.push({ p, s, ...r, doc: t.type });
        }
      }
      if (docs.searched < stats.length) docs.left = `${stats.length - docs.searched} documents were not searched (the newest ${docs.searched} were); name a smaller folder or raise \`ms\` or \`maxDocs\``;
      if (Object.keys(failed).length) docs.notRead = failed;
      if (docOpts.stats?.stopped) stopped ??= `the walk for documents stopped early: ${docOpts.stats.stopped}`;
    }
    hits.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
    const out = {
      pattern: list.length === 1 ? list[0] : list,
      ...(list.length > 1 ? { rule: "a file must hold every pattern; the lines shown hold any of them" } : {}),
      under: st.dirs.map(shown),
      engine,
      matchedFiles: hits.length,
      files: hits.slice(0, limit).map((h) => ({ ...row(h.p, h.s, now), ...(h.doc ? { type: h.doc } : {}), hits: h.n, lines: h.got })),
      more: Math.max(0, hits.length - limit),
      ...(docs ? { documents: docs } : { documents: "PDF and office files were not searched; pass docs: true to search their text" }),
      ...(stopped ? { stopped } : {}),
      ...report,
    };
    note("grep", `${list.join(" & ")} under ${out.under.join(",")}`, started, 0, hits.length);
    return out;
  }

  function du(p, o = {}) {
    const started = Date.now();
    const now = toNow(o.now);
    const abs = locate(p ?? roots[0], { what: "path" });
    const s = lstat(abs);
    if (!s) return missing(abs);
    if (!s.isDirectory()) return { ...row(abs, s, now), kind: "file", note: "a file, not a folder" };
    const depth = Math.max(1, Math.min(Number(o.depth ?? 2) || 2, 8));
    const top = Math.max(1, Math.min(Number(o.top ?? 15) || 15, 100));
    const m = measure(abs, { ms: Math.min(Number(o.ms ?? 10_000) || 10_000, 120_000), mounts: !!o.mounts, topFiles: top });
    const total = m.dirs.get(abs);
    const pct = (b) => (total.bytes ? Math.round((b / total.bytes) * 100) : 0);
    const folders = [...m.dirs.entries()].filter(([, d]) => d.level >= 1 && d.level <= depth && d.bytes > 0).sort((a, b) => b[1].bytes - a[1].bytes);
    let disk;
    try {
      const f = fs.statfsSync(abs);
      disk = { total: human(f.blocks * f.bsize), free: human(f.bavail * f.bsize), usedPercent: f.blocks ? Math.round((1 - f.bfree / f.blocks) * 100) : null };
    } catch {}
    const direct = total.bytes - [...m.dirs.values()].filter((d) => d.level === 1).reduce((a, d) => a + d.bytes, 0);
    const out = {
      path: shown(abs),
      bytes: total.bytes,
      size: human(total.bytes),
      files: total.files,
      foldersInAll: m.dirs.size - 1,
      filesDirectlyInIt: human(direct),
      folders: folders.slice(0, top).map(([q, d]) => ({ path: path.relative(abs, q), bytes: d.bytes, size: human(d.bytes), percent: pct(d.bytes), files: d.files })),
      moreFolders: Math.max(0, folders.length - top),
      biggestFiles: m.top.map((x) => ({ path: path.relative(abs, x.p), bytes: x.b, size: human(x.b), percent: pct(x.b), modified: iso(x.s.mtimeMs), age: ago(x.s.mtimeMs, now) })),
      byKind: Object.fromEntries(Object.entries(m.kinds).sort((a, b) => b[1] - a[1]).filter(([, b]) => b > 0).slice(0, 8).map(([k, b]) => [k, `${human(b)} (${pct(b)}%)`])),
      ...(m.privateBytes ? { private: `${human(m.privateBytes)} is in credential, browser, mail or history files, which are counted in their folder and not listed` } : {}),
      ...(disk ? { disk } : {}),
      ...walkReport(m.stats, started),
    };
    delete out.skipped.private;
    delete out.skipped.privateIn;
    if (out.stopped) out.stopped = out.stopped.replace("The result is partial", "The sizes are a lower bound");
    note("du", shown(abs), started, 0, total.files);
    return out;
  }

  const archiveKind = (abs, s) => {
    const name = path.basename(abs).toLowerCase();
    const t = sniff(abs, s).type;
    if (/ZIP|docx|xlsx|pptx|odt|ods|odp|EPUB|jar|apk|wheel/.test(t)) return "zip";
    if (t === "tar archive") return "tar";
    if (/^gzip/.test(t)) return /\.(tar\.gz|tgz)$/.test(name) ? "tar.gz" : "gz";
    if (/^bzip2/.test(t)) return /\.(tar\.bz2|tbz2?)$/.test(name) ? "tar.bz2" : "bz2";
    if (/^xz/.test(t)) return /\.(tar\.xz|txz)$/.test(name) ? "tar.xz" : "xz";
    if (/^zstd/.test(t)) return /\.(tar\.zst|tzst)$/.test(name) ? "tar.zst" : "zst";
    if (/7z/.test(t)) return "7z";
    if (/RAR/.test(t)) return "rar";
    return name.endsWith(".tar") ? "tar" : null;
  };
  const notArchive = (abs, s, kind) => {
    const t = sniff(abs, s).type;
    if (kind === "7z" || kind === "rar") return `a ${kind} archive: this kit reads zip and tar archives only. The 7z program lists it (\`7z l\`).`;
    if (kind && ["gz", "bz2", "xz", "zst"].includes(kind)) return `one compressed file (${t}), not an archive of several`;
    return `not an archive this kit reads (${t}); it lists zip (also docx, xlsx, jar, epub), tar, tar.gz, tar.bz2, tar.xz and tar.zst`;
  };

  async function list(p, o = {}) {
    const started = Date.now();
    const now = toNow(o.now);
    const abs = locate(p, { what: "archive" });
    const s = lstat(abs);
    if (!s) return missing(abs);
    if (s.isDirectory()) return { path: shown(abs), error: `${shown(abs)} is a folder, not an archive` };
    const kind = archiveKind(abs, s);
    const head = { ...row(abs, s, now), format: kind };
    const limit = Math.max(1, Math.min(Number(o.limit ?? 200) || 200, 5000));
    const match = o.match ? patternOf(o.match, true).re : null;
    let entries = [];
    let extra = {};
    try {
      if (kind === "zip") {
        const z = zipOpen(abs);
        entries = z.entries.map((e) => ({ name: e.name, bytes: e.size, modified: e.modified, dir: e.dir, ...(e.encrypted ? { encrypted: true } : {}) }));
        if (z.entries.some((e) => e.encrypted)) extra.encrypted = "some entries are encrypted: their names are listed, their content needs the password";
        extra.packed = human(z.entries.reduce((a, e) => a + e.packed, 0));
      } else if (kind === "tar" || kind === "tar.gz") {
        const r = await tarWalk(abs, (h) => (entries.length < 200_000 ? void entries.push({ name: h.name, bytes: h.size, modified: iso(h.modified), dir: h.type === "dir", ...(h.linkTo ? { linkTo: h.linkTo } : {}) }) : false), { gzip: kind === "tar.gz", deadline: started + 20_000 });
        if (r.error) return { ...head, error: `cannot read the archive: ${r.error}`, entriesRead: entries.length };
        if (r.stopped) extra.stopped = r.stopped === "time" ? "stopped after 20 s: the archive holds more entries than were read" : "stopped at 200000 entries";
      } else if (kind && kind.startsWith("tar.")) {
        const tar = program("tar");
        if (!tar) return { ...head, error: `a ${kind} archive needs the tar program to list, and tar is not installed`, need: "tar" };
        const r = await run(tar, ["-tf", abs], { timeout: 30_000 });
        if (r.code !== 0) return { ...head, error: `tar could not list it: ${r.timedOut ? "timed out after 30 s" : r.err || `exit ${r.code}`}` };
        entries = r.out.split("\n").filter(Boolean).map((name) => ({ name, dir: name.endsWith("/") }));
        extra.note = "listed with tar: names only, no sizes";
      } else return { ...head, error: notArchive(abs, s, kind) };
    } catch (e) {
      return { ...head, error: `cannot read the archive: ${e.message}` };
    }
    const files = entries.filter((e) => !e.dir);
    const shownEntries = (match ? entries.filter((e) => match.test(e.name)) : entries).filter((e) => !e.dir || match);
    const tops = {};
    for (const e of entries) {
      const first = e.name.replace(/^\.\//, "").split("/")[0];
      if (first) tops[first] = (tops[first] ?? 0) + (e.dir ? 0 : 1);
    }
    const totalBytes = files.reduce((a, e) => a + (e.bytes ?? 0), 0);
    note("list", shown(abs), started, 0, entries.length);
    return {
      ...head,
      entries: files.length,
      folders: entries.length - files.length,
      ...(files[0]?.bytes != null ? { unpackedBytes: totalBytes, unpacked: human(totalBytes) } : {}),
      ...extra,
      top: Object.entries(tops).slice(0, 30).map(([name, n]) => (n > 1 || entries.some((e) => e.name.replace(/^\.\//, "").startsWith(`${name}/`)) ? `${name}/ (${plural(n, "file")})` : name)),
      ...(match ? { matching: shownEntries.length } : {}),
      files: shownEntries.slice(0, limit).map((e) => ({ name: e.name, ...(e.bytes != null ? { size: human(e.bytes) } : {}), ...(e.modified ? { modified: e.modified } : {}), ...(e.encrypted ? { encrypted: true } : {}), ...(e.linkTo ? { linkTo: e.linkTo } : {}) })),
      more: Math.max(0, shownEntries.length - limit),
    };
  }

  const hashPart = (p, size) => {
    const block = 64 * 1024;
    const fd = fs.openSync(p, "r");
    try {
      const h = crypto.createHash("sha256");
      const b = Buffer.alloc(Math.min(block, size));
      h.update(b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)));
      if (size > block) h.update(b.subarray(0, fs.readSync(fd, b, 0, b.length, Math.max(block, size - block))));
      return h.digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  };
  const hashFull = (p, deadline) => {
    const fd = fs.openSync(p, "r");
    try {
      const h = crypto.createHash("sha256");
      const b = Buffer.alloc(1 << 20);
      for (let n, i = 0; (n = fs.readSync(fd, b, 0, b.length, null)) > 0; i++) {
        h.update(n === b.length ? b : b.subarray(0, n));
        if ((i & 63) === 63 && Date.now() > deadline) return null;
      }
      return h.digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  };

  function duplicates(under, o = {}) {
    const started = Date.now();
    const now = toNow(o.now);
    const st = starts(under ?? null);
    if (st.error) return { ...st.error, groups: [] };
    const minSize = Math.max(1, bytesOf(o.minSize) ?? 1);
    const limit = Math.max(1, Math.min(Number(o.limit ?? 20) || 20, 200));
    const budget = Math.min(Number(o.ms ?? 30_000) || 30_000, 300_000);
    const { set: extSet } = exts(o.ext, o.kind);
    const bySize = new Map();
    const inodes = new Set();
    let files = 0;
    const opts = { depth: o.depth, deadline: started + budget / 3, all: !!o.all, mounts: !!o.mounts };
    for (const d of st.dirs)
      walk(d, opts, {
        onFile: (p, name) => {
          if (extSet && !extSet.has(extOf(name))) return;
          const s = lstat(p);
          if (!s || s.size < minSize) return;
          if (s.nlink > 1) {
            const key = `${s.dev}:${s.ino}`;
            if (inodes.has(key)) return; // another name of the same file, not a copy
            inodes.add(key);
          }
          files++;
          const g = bySize.get(s.size);
          if (g) g.push({ p, s });
          else bySize.set(s.size, [{ p, s }]);
        },
      });
    // Biggest first, so the budget goes to the copies that waste the most.
    const sized = [...bySize.entries()].filter(([, g]) => g.length > 1).sort((a, b) => b[0] * (b[1].length - 1) - a[0] * (a[1].length - 1));
    const deadline = started + budget;
    const groups = [];
    let unchecked = 0;
    let unconfirmed = 0;
    for (const [size, g] of sized) {
      if (Date.now() > deadline) {
        unchecked++;
        continue;
      }
      const parts = new Map();
      for (const f of g) {
        try {
          const h = hashPart(f.p, size);
          parts.set(h, [...(parts.get(h) ?? []), f]);
        } catch {}
      }
      for (const [part, same] of parts) {
        if (same.length < 2) continue;
        const full = new Map();
        let confirmed = true;
        if (size > 128 * 1024) {
          for (const f of same) {
            let h = null;
            try {
              h = hashFull(f.p, deadline);
            } catch {
              continue;
            }
            if (h == null) {
              confirmed = false;
              break;
            }
            full.set(h, [...(full.get(h) ?? []), f]);
          }
        } else full.set(part, same); // the two blocks cover the whole file
        if (!confirmed) {
          unconfirmed++;
          groups.push({ size, files: same, hash: null });
          continue;
        }
        for (const [h, fs2] of full) if (fs2.length > 1) groups.push({ size, files: fs2, hash: h });
      }
    }
    groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
    const wasted = groups.filter((g) => g.hash).reduce((a, g) => a + g.size * (g.files.length - 1), 0);
    note("duplicates", st.dirs.map(shown).join(","), started, 0, groups.length);
    return {
      under: st.dirs.map(shown),
      filesCompared: files,
      groupCount: groups.length,
      wastedBytes: wasted,
      wasted: human(wasted),
      groups: groups.slice(0, limit).map((g) => ({
        bytes: g.size,
        size: human(g.size),
        copies: g.files.length,
        wasted: human(g.size * (g.files.length - 1)),
        ...(g.hash ? { sha256: g.hash.slice(0, 16) } : { unconfirmed: "same size and same first and last 64 KB; the full comparison did not fit the time budget" }),
        files: g.files.sort((a, b) => a.s.mtimeMs - b.s.mtimeMs).slice(0, 12).map((f) => ({ path: shown(f.p), modified: iso(f.s.mtimeMs), age: ago(f.s.mtimeMs, now) })),
        ...(g.files.length > 12 ? { moreFiles: g.files.length - 12 } : {}),
      })),
      more: Math.max(0, groups.length - limit),
      ...(unchecked ? { unchecked: `${plural(unchecked, "group")} of same-sized files were not compared: the time budget of ${Math.round(budget / 1000)} s ran out (raise \`ms\`, or \`minSize\`)` } : {}),
      ...(unconfirmed ? { unconfirmed } : {}),
      ...walkReport(opts.stats ?? { folders: 0, entries: 0, secretIn: new Set() }, started),
    };
  }

  /** Which optional programs this machine has, and what each is used for. */
  const programs = () => {
    const uses = { pdftotext: "the text of PDF files", rg: "fast content search (without it the search is done in Node, more slowly)", tar: "listing and extracting tar.bz2, tar.xz and tar.zst archives", mdfind: "a name index on macOS", plocate: "a name index on Linux", locate: "a name index on Linux" };
    return Object.fromEntries(Object.entries(uses).map(([name, use]) => [name, { present: !!program(name), use }]));
  };

  // ---------- acting ----------

  const refusal = (what) => () => {
    throw new Error(`not in this ask: ${what} changes things, and the caller did not ask for a change (act: true)`);
  };
  const acts = {
    move: refusal("files.move (moving a file or folder)"),
    copy: refusal("files.copy (copying a file or folder)"),
    rename: refusal("files.rename (renaming a file or folder)"),
    mkdir: refusal("files.mkdir (making a folder)"),
    trash: refusal("files.trash (moving a file or folder to the trash)"),
    remove: refusal("files.remove (deleting a file or folder for good)"),
    extract: refusal("files.extract (unpacking an archive)"),
  };
  if (act) {
    const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
    const source = (p, what) => {
      const abs = locate(p, { what });
      if (roots.includes(abs)) throw new Error(`refused: ${shown(abs)} is one of the folders this kit works in, and is not moved, renamed or removed`);
      return abs;
    };
    /** Where `from` lands for a `to` the caller gave: inside `to` when it is a folder that exists. */
    const landing = (from, to) => {
      const t = locate(to, { what: "to" });
      const s = lstat(t);
      const dest = s?.isDirectory() ? path.join(t, path.basename(from)) : t;
      if (dest !== t) locate(dest);
      return dest;
    };
    const describe = (p) => {
      const s = lstat(p);
      return s ? { path: shown(p), kind: s.isDirectory() ? "folder" : "file", ...(s.isDirectory() ? {} : { bytes: s.size, size: human(s.size) }) } : { path: shown(p), gone: true };
    };
    const copyTree = (from, dest) => fs.cpSync(from, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    const moveTo = (from, dest) => {
      try {
        fs.renameSync(from, dest);
      } catch (e) {
        if (e.code !== "EXDEV") throw e;
        // Another filesystem: copy, then remove the source only when the copy is whole.
        copyTree(from, dest);
        fs.rmSync(from, { recursive: true, force: true });
      }
    };

    acts.move = (from, to) => {
      const started = Date.now();
      const a = source(from, "from");
      if (!lstat(a)) return fail(`nothing to move: ${missing(a).error}`, near(a));
      const dest = landing(a, to);
      if (lstat(dest)) return fail(`the target exists and is not overwritten: ${shown(dest)}`);
      if (!lstat(path.dirname(dest))) return fail(`the target folder does not exist: ${shown(path.dirname(dest))} (files.mkdir makes it)`);
      if (inside(a, dest)) return fail(`${shown(dest)} is inside ${shown(a)}: a folder cannot be moved into itself`);
      try {
        moveTo(a, dest);
      } catch (e) {
        return fail(`could not move it: ${e.message}`);
      }
      note("move", `${shown(a)} -> ${shown(dest)}`, started);
      return { ok: true, moved: shown(a), to: describe(dest) };
    };
    acts.copy = (from, to) => {
      const started = Date.now();
      const a = locate(from, { what: "from" });
      if (!lstat(a)) return fail(`nothing to copy: ${missing(a).error}`, near(a));
      const dest = landing(a, to);
      if (lstat(dest)) return fail(`the target exists and is not overwritten: ${shown(dest)}`);
      if (!lstat(path.dirname(dest))) return fail(`the target folder does not exist: ${shown(path.dirname(dest))} (files.mkdir makes it)`);
      if (inside(a, dest)) return fail(`${shown(dest)} is inside ${shown(a)}: a folder cannot be copied into itself`);
      try {
        copyTree(a, dest);
      } catch (e) {
        return fail(`could not copy it: ${e.message}`);
      }
      note("copy", `${shown(a)} -> ${shown(dest)}`, started);
      return { ok: true, copied: shown(a), to: describe(dest) };
    };
    acts.rename = (p, newName) => {
      const started = Date.now();
      const a = source(p, "path");
      const name = String(newName ?? "");
      if (!name || name === "." || name === ".." || /[/\\]/.test(name)) throw new Error("rename takes a new name with no folder in it, e.g. files.rename(\"~/Downloads/scan.pdf\", \"invoice-041.pdf\"); files.move puts a file in another folder");
      if (!lstat(a)) return fail(`nothing to rename: ${missing(a).error}`, near(a));
      const dest = locate(path.join(path.dirname(a), name));
      if (lstat(dest)) return fail(`a file or folder with that name exists and is not overwritten: ${shown(dest)}`);
      try {
        fs.renameSync(a, dest);
      } catch (e) {
        return fail(`could not rename it: ${e.message}`);
      }
      note("rename", `${shown(a)} -> ${name}`, started);
      return { ok: true, renamed: shown(a), to: describe(dest) };
    };
    acts.mkdir = (p) => {
      const started = Date.now();
      const a = locate(p);
      const s = lstat(a);
      if (s) return s.isDirectory() ? { ok: true, existed: true, path: shown(a) } : fail(`a file with that name exists: ${shown(a)}`);
      try {
        fs.mkdirSync(a, { recursive: true });
      } catch (e) {
        return fail(`could not make it: ${e.message}`);
      }
      note("mkdir", shown(a), started);
      return { ok: true, made: shown(a) };
    };
    acts.trash = async (p) => {
      const started = Date.now();
      const a = source(p, "path");
      const s = lstat(a);
      if (!s) return fail(`nothing to trash: ${missing(a).error}`, near(a));
      const was = describe(a);
      const free = (dir, name) => {
        let n = name;
        for (let i = 2; lstat(path.join(dir, n)); i++) n = `${name}.${i}`;
        return n;
      };
      try {
        if (process.platform === "darwin") {
          const dir = path.join(home, ".Trash");
          fs.mkdirSync(dir, { recursive: true });
          const dest = path.join(dir, free(dir, path.basename(a)));
          moveTo(a, dest);
          note("trash", shown(a), started);
          return { ok: true, trashed: was, in: shown(dest), note: "it is in the Trash; Finder's Put Back does not know where it came from" };
        }
        // The freedesktop.org trash: files/<name> and info/<name>.trashinfo with where it came from.
        const dir = path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "Trash");
        fs.mkdirSync(path.join(dir, "files"), { recursive: true });
        fs.mkdirSync(path.join(dir, "info"), { recursive: true });
        let name = path.basename(a);
        const d = new Date();
        const two = (n) => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
        const infoText = `[Trash Info]\nPath=${a.split("/").map(encodeURIComponent).join("/")}\nDeletionDate=${stamp}\n`;
        for (let i = 2; ; i++) {
          try {
            if (lstat(path.join(dir, "files", name))) throw Object.assign(new Error("taken"), { code: "EEXIST" });
            fs.writeFileSync(path.join(dir, "info", `${name}.trashinfo`), infoText, { flag: "wx" });
            break;
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
            name = `${path.basename(a)}.${i}`;
          }
        }
        const dest = path.join(dir, "files", name);
        try {
          moveTo(a, dest);
        } catch (e) {
          fs.rmSync(path.join(dir, "info", `${name}.trashinfo`), { force: true });
          throw e;
        }
        note("trash", shown(a), started);
        return { ok: true, trashed: was, in: shown(dest), restore: "the desktop's trash can put it back; its origin is recorded" };
      } catch (e) {
        return fail(`could not move it to the trash: ${e.message}. Nothing else was changed.`);
      }
    };
    acts.remove = (p, o = {}) => {
      const started = Date.now();
      if (o?.permanently !== true) throw new Error("remove deletes for good and needs { permanently: true }, which is given only when the caller's own words say to delete permanently. Otherwise use files.trash(path).");
      const a = source(p, "path");
      const s = lstat(a);
      if (!s) return fail(`nothing to remove: ${missing(a).error}`, near(a));
      const was = describe(a);
      try {
        if (s.isDirectory()) {
          const n = fs.readdirSync(a).length;
          if (n && o.recursive !== true) return fail(`${shown(a)} is a folder with ${plural(n, "entry", "entries")}; pass { permanently: true, recursive: true } to delete it and everything in it`);
          fs.rmSync(a, { recursive: true });
        } else fs.unlinkSync(a);
      } catch (e) {
        return fail(`could not remove it: ${e.message}`);
      }
      note("remove", shown(a), started);
      return { ok: true, removedForGood: was };
    };
    acts.extract = async (archive, to) => {
      const started = Date.now();
      const a = locate(archive, { what: "archive" });
      const s = lstat(a);
      if (!s) return fail(`no archive: ${missing(a).error}`, near(a));
      if (s.isDirectory()) return fail(`${shown(a)} is a folder, not an archive`);
      const kind = archiveKind(a, s);
      if (!kind || ["gz", "bz2", "xz", "zst", "7z", "rar"].includes(kind)) return fail(notArchive(a, s, kind));
      const dest = locate(to ?? path.join(path.dirname(a), path.basename(a).replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|tzst|[a-z0-9]+)$/i, "")), { what: "to" });
      const ds = lstat(dest);
      if (ds && !ds.isDirectory()) return fail(`the target is a file: ${shown(dest)}`);
      // Where an entry lands; null for a name that would leave the target or is private.
      const target = (name) => {
        const clean = name.replace(/^(\.\/)+/, "");
        if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) return null;
        const t = path.join(dest, ...clean.split("/"));
        return inside(dest, t) ? t : null;
      };
      const left = { unsafeNames: 0, links: 0, other: 0 };
      let written = 0;
      let bytes = 0;
      const made = new Set();
      const mk = (d) => {
        if (!made.has(d)) {
          fs.mkdirSync(d, { recursive: true });
          made.add(d);
        }
      };
      try {
        if (kind === "zip") {
          const z = zipOpen(a);
          const plan = [];
          for (const e of z.entries) {
            const t = target(e.name);
            if (!t) left.unsafeNames++;
            else if (e.link) left.links++;
            else plan.push([e, t]);
          }
          const clash = plan.filter(([e, t]) => !e.dir && lstat(t)).map(([, t]) => shown(t));
          if (clash.length) return fail(`${plural(clash.length, "file")} of the archive exist in the target and are not overwritten; nothing was extracted`, { exist: clash.slice(0, 10) });
          if (plan.some(([e]) => e.encrypted)) return fail("the archive is encrypted; this kit does not take passwords. Nothing was extracted.");
          const total = plan.reduce((n, [e]) => n + e.size, 0);
          if (total > 4 * 1024 ** 3) return fail(`the archive unpacks to ${human(total)}, more than the 4 GB this kit extracts; use unzip`);
          for (const [e, t] of plan) {
            if (e.dir) mk(t);
            else {
              mk(path.dirname(t));
              const body = zipRead(a, e);
              fs.writeFileSync(t, body, { flag: "wx" });
              written++;
              bytes += body.length;
            }
          }
        } else if (kind === "tar" || kind === "tar.gz") {
          // First pass: names only, so nothing is written when a target exists.
          const names = [];
          const pre = await tarWalk(a, (h) => void names.push(h), { gzip: kind === "tar.gz", deadline: started + 60_000 });
          if (pre.error || pre.stopped) return fail(`cannot read the archive: ${pre.error ?? "it took more than 60 s to list"}`);
          const clash = names.filter((h) => h.type === "file" && target(h.name) && lstat(target(h.name))).map((h) => shown(target(h.name)));
          if (clash.length) return fail(`${plural(clash.length, "file")} of the archive exist in the target and are not overwritten; nothing was extracted`, { exist: clash.slice(0, 10) });
          const total = names.reduce((n, h) => n + h.size, 0);
          if (total > 4 * 1024 ** 3) return fail(`the archive unpacks to ${human(total)}, more than the 4 GB this kit extracts; use tar`);
          const r = await tarWalk(
            a,
            (h) => {
              const t = target(h.name);
              if (!t) return void left.unsafeNames++;
              if (h.type === "dir") return void mk(t);
              if (h.type !== "file") return void (h.type === "other" ? left.other++ : left.links++);
              mk(path.dirname(t));
              const fd = fs.openSync(t, "wx");
              written++;
              return { write: (c) => void ((bytes += c.length), fs.writeSync(fd, c)), end: () => (fs.closeSync(fd), fs.utimesSync(t, new Date(), new Date(h.modified))) };
            },
            { gzip: kind === "tar.gz", deadline: started + 300_000 },
          );
          if (r.error) return fail(`the archive broke off: ${r.error}`, { extractedSoFar: written, to: shown(dest) });
        } else {
          const tar = program("tar");
          if (!tar) return fail(`a ${kind} archive needs the tar program, and tar is not installed`);
          if (ds && fs.readdirSync(dest).length) return fail(`a ${kind} archive is unpacked by tar, which this kit runs only into a new or empty folder; ${shown(dest)} has files in it`);
          mk(dest);
          const r = await run(tar, ["-xkf", a, "-C", dest], { timeout: 300_000 });
          if (r.code !== 0) return fail(`tar could not extract it: ${r.timedOut ? "timed out after 300 s" : r.err || `exit ${r.code}`}`, { to: shown(dest) });
          const m = measure(dest, { ms: 5000, topFiles: 1 });
          written = m.fileCount;
          bytes = m.dirs.get(dest).bytes;
        }
      } catch (e) {
        return fail(`extraction stopped: ${e.code === "EEXIST" ? `a file exists and is not overwritten (${e.path ? shown(e.path) : e.message})` : e.message}`, { extractedSoFar: written, to: shown(dest) });
      }
      note("extract", `${shown(a)} -> ${shown(dest)}`, started, 0, bytes);
      const skipped = Object.fromEntries(Object.entries(left).filter(([, n]) => n));
      return { ok: true, extracted: shown(a), to: shown(dest), files: written, bytes, size: human(bytes), ...(Object.keys(skipped).length ? { leftOut: skipped, note: "entries whose name would leave the target folder, and links, are never extracted" } : {}) };
    };
  }

  return {
    roots: roots.map(shown),
    workdir: shown(workdir),
    kinds: KINDS,
    find,
    info,
    read,
    outline,
    grep,
    du,
    list,
    duplicates,
    programs,
    human,
    ago,
    when,
    window,
    ...acts,
  };
}
