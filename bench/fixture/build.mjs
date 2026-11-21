// Builds the bench fixture: bench/fixture/home, laid out like a small home folder, with files from
// Terry Pratchett's Discworld. Run it before the bench: `node bench/fixture/build.mjs`.
//
// The files are committed. This script writes any that are missing (`--force` rewrites them all)
// and then sets every file's modified time, because git does not keep modified times and the
// bench asks about them. The bench passes `now: "2026-11-20T12:00:00Z"`, so ages are fixed too.
// Every password, key and token in here is made up, to prove that such files are skipped.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const home = path.join(path.dirname(fileURLToPath(import.meta.url)), "home");
const force = process.argv.includes("--force");

// ---- writers for the binary files ----

/** A PDF with one text stream per page, in Helvetica. */
function pdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (const lines of pages) {
    const esc = (s) => s.replace(/[\\()]/g, "\\$&");
    const stream = `BT\n/F1 12 Tf\n72 720 Td\n16 TL\n${lines.map((l) => `(${esc(l)}) Tj T*`).join("\n")}\nET`;
    const content = objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A zip of [name, content] pairs, deflated, all dated 2026-11-02 10:30. */
function zip(entries) {
  const time = (10 << 11) | (30 << 5);
  const date = ((2026 - 1980) << 9) | (11 << 5) | 2;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const body = Buffer.from(content);
    const dir = name.endsWith("/");
    const packed = dir ? Buffer.alloc(0) : zlib.deflateRawSync(body, { level: 9 });
    const n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(dir ? 0 : 8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(zlib.crc32(body), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(body.length, 22);
    head.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    head.copy(c, 8, 6, 30);
    c.writeUInt32LE(dir ? 0x10 : 0, 38);
    c.writeUInt32LE(offset, 42);
    parts.push(head, n, packed);
    central.push(c, n);
    offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** A gzipped ustar archive of [name, content] pairs, all dated 2026-10-19T22:00:00Z. */
function tarGz(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const body = Buffer.from(content);
    const dir = name.endsWith("/");
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write(dir ? "0000755\0" : "0000644\0", 100);
    h.write("0001750\0", 108);
    h.write("0001750\0", 116);
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write(`${Math.floor(Date.UTC(2026, 9, 19, 22) / 1000).toString(8).padStart(11, "0")}\0`, 136);
    h.write("        ", 148);
    h.write(dir ? "5" : "0", 156);
    h.write("ustar\0" + "00", 257);
    h.write("vimes", 265);
    h.write("watch", 297);
    h.write(`${[...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** A PNG of one colour, 8 by 8 pixels. */
function png(r, g, b) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([r, g, b])))]);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

/** 300 KB that starts like an MP4 and then holds bytes from a fixed generator. */
function video() {
  const b = Buffer.alloc(300 * 1024);
  Buffer.from([0, 0, 0, 0x18]).copy(b, 0);
  b.write("ftypisom", 4, "latin1");
  let x = 12;
  for (let i = 24; i < b.length; i++) b[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16;
  return b;
}

const docx = () =>
  zip([
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    [
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Letter to the Patrician</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Dear Lord Vetinari, </w:t></w:r><w:r><w:t>the Watch asks for twelve new crossbows &amp; a kettle.</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Costs</w:t></w:r></w:p>' +
        "<w:p><w:r><w:t>Crossbows:</w:t><w:tab/><w:t>AM$ 240</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Kettle:</w:t><w:tab/><w:t>AM$ 3</w:t></w:r></w:p>" +
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Signed</w:t></w:r></w:p>' +
        "<w:p><w:r><w:t>Sam Vimes, Commander, Ankh-Morpork City Watch</w:t></w:r></w:p>" +
        "</w:body></w:document>",
    ],
  ]);

const xlsx = () =>
  zip([
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Guild fees" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'],
    ["xl/sharedStrings.xml", '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5"><si><t>Guild</t></si><si><t>Fee (AM$)</t></si><si><t>Thieves</t></si><si><t>Assassins</t></si><si><t>Seamstresses</t></si></sst>'],
    ["xl/worksheets/sheet1.xml", '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>400</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>950</v></c></row><row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4"><v>120</v></c></row></sheetData></worksheet>'],
  ]);

// ---- the files: path, modified time (UTC), content ----

const roster = `# Night Watch roster

Week of Grune 14. Changes go through Sergeant Colon.

## Pseudopolis Yard

- Commander Sam Vimes: days
- Captain Carrot Ironfoundersson: nights
- Sergeant Angua von Uberwald: nights

## Treacle Mine Road

- Sergeant Fred Colon: desk
- Corporal Nobby Nobbs: gate duty, when he can be found
- Constable Cheery Littlebottom: forensics

## Notes

Constable Visit is on leave. Detritus has the Shades on Octeday.
`;

const report = `WATCH-12: dragon over the Shades

Reported by Captain Carrot at 22:15.
A small swamp dragon was seen over the Shades and set fire to a cabbage cart.
Nobody was hurt. The cart belonged to a Mr Dibbler, who is asking for AM$ 30.
Lord Vetinari was informed the same night.
Next step: Lady Sybil's Sunshine Sanctuary for Sick Dragons will collect the dragon.
`;

const notes = `Clacks tower notes

The tower at Sto Lat drops every third message when it rains.
Engineer on call: Adora Belle Dearheart.
password: swordfish-gnu-terry
Relay: https://vimes:hunter2-fake@clacks.example.com/relay
Ask Ponder Stibbons about the Hex link.
`;

const files = [
  ["Documents/watch/night-watch-roster.md", "2026-11-20T08:15:00Z", roster],
  ["Documents/watch/WATCH-12-report.txt", "2026-11-18T16:40:00Z", report],
  ["Documents/watch/clacks-notes.txt", "2026-11-05T11:00:00Z", notes],
  ["Documents/invoices/invoice-040-harry-king.txt", "2026-09-14T09:00:00Z", "Invoice 040\nTo: Harry King, King of the Golden River\nFor: one month of night soil removal from the Watch House\nTotal: AM$ 85\nPaid.\n"],
  ["Documents/invoices/invoice-041-vetinari.pdf", "2026-10-03T10:00:00Z", () => pdf([["Invoice 041", "To: Lord Vetinari, The Patrician's Palace, Ankh-Morpork", "For: repairs to the Watch House roof after WATCH-12", "Total: AM$ 1,200", "Due: 1 December"]])],
  ["Documents/letters/letter-to-the-patrician.docx", "2026-11-10T14:00:00Z", docx],
  ["Documents/guild-fees.xlsx", "2026-08-01T12:00:00Z", xlsx],
  ["Documents/clacks-token.txt", "2026-10-01T12:00:00Z", "FAKE-TOKEN-not-real-0000\n"],
  ["Downloads/thud-rules.pdf", "2026-11-12T09:30:00Z", () => pdf([["The Rules of Thud", "A game for two players: one takes the dwarfs, one the trolls.", "The board has 32 dwarfs, 8 trolls and the Thudstone."], ["Winning", "A full game is two battles, with the sides exchanged.", "Koom Valley is remembered by both sides."]])],
  ["Downloads/watch-archive.zip", "2026-11-02T10:30:00Z", () => zip([["watch/", ""], ["watch/roster-old.md", "# Old roster\n\nCaptain Quirke had the Day Watch.\n"], ["watch/reports/WATCH-07.txt", "WATCH-07: a troll sat on the Brass Bridge and would not move.\n"], ["README.txt", "Papers from the old Watch House in Treacle Mine Road.\n"]])],
  ["Downloads/patrol-logs.tar.gz", "2026-10-20T07:00:00Z", () => tarGz([["patrol-logs/", ""], ["patrol-logs/monday.log", "22:00 Carrot: all quiet on Short Street\n23:10 Angua: followed a smell to the docks\n"], ["patrol-logs/tuesday.log", "21:30 Nobby: gate locked, mostly\n"]])],
  ["Downloads/thud-tournament.mp4", "2026-07-07T18:00:00Z", video],
  ["Downloads/dragon-errol.png", "2026-11-15T13:00:00Z", () => png(120, 160, 60)],
  ["Pictures/errol.png", "2026-06-01T10:00:00Z", () => png(120, 160, 60)],
  ["Pictures/lady-sybil.png", "2026-06-02T10:00:00Z", () => png(200, 120, 160)],
  [".env", "2026-11-19T10:00:00Z", "# Made up for the bench. Not a real credential.\nCLACKS_PASSWORD=swordfish-gnu-terry\n"],
  [".ssh/id_ed25519", "2026-01-01T00:00:00Z", "FAKE KEY FOR THE BENCH. Not a private key.\n"],
  [".bash_history", "2026-11-19T23:00:00Z", "clacks --password swordfish-gnu-terry send GNU\n"],
  ["node_modules/left-pad/index.js", "2026-11-19T09:00:00Z", "module.exports = (s, n) => String(s).padStart(n);\n"],
  [".cache/thumbnails/errol.thumb", "2026-11-19T09:00:00Z", "thumb\n"],
];

let written = 0;
for (const [rel, when, content] of files) {
  const file = path.join(home, ...rel.split("/"));
  if (force || !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "function" ? content() : content);
    written++;
  }
  const t = new Date(when);
  fs.utimesSync(file, t, t);
}
console.log(`fixture at ${home}: ${files.length} files, ${written} written, modified times set`);
