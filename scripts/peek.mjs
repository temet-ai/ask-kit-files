export const meta = {
  purpose:
    "What one file holds, whatever it is: a PDF, Word, Excel, PowerPoint or OpenDocument file gives its type, size, pages, headings and its first lines; an archive (zip, tar, tar.gz, docx) gives what is inside and how big it unpacks; a text file its headings and first lines; an image, video or audio file its type and size. The answer to 'what is in thud-rules.pdf', 'what is in this zip', 'what is this file'. Credential files give size and dates only.",
  params: { path: "the file", lines: "first lines of text to include, default 30", match: "for an archive, only entries whose name matches this text or /regex/", now: "the moment ages are measured from (ISO date)" },
  returns: "{verdict, path, type, size, modified, age, pages?, totalLines?, headings?, text? (the first lines), next?} for a document; {verdict, format, entries, unpacked, top, files:[{name, size}]} for an archive; {verdict, type, size} for the rest",
  example: 'await scripts.run("peek", { path: "~/Downloads/thud-rules.pdf" })',
};

export default async function ({ files }, { path, lines = 30, match, now } = {}) {
  if (!path) throw new Error("peek needs `path`: the file to look at");
  const i = files.info(path, { now });
  if (i.error) return { verdict: i.error, ...i };
  if (i.private) return { verdict: `${i.path} is off limits (credentials, keys, mail or history); only its size (${i.size}) and date (${i.modified}) are given`, ...i };
  if (i.kind === "folder") return { verdict: `${i.path} is a folder of ${i.size} with ${i.entries} entries (${i.filesInAll} files inside); scripts find and space look in it`, ...i };
  if (/archive|ZIP|wheel|Android package/.test(i.type ?? "") && !/Word|Excel|PowerPoint|OpenDocument|EPUB/.test(i.type)) {
    const a = await files.list(path, { match, now, limit: 60 });
    if (!a.error) return { verdict: `${a.path} is a ${a.format} archive of ${a.size}: ${a.entries} ${a.entries === 1 ? "file" : "files"}${a.folders ? ` and ${a.folders} ${a.folders === 1 ? "folder" : "folders"}` : ""}${a.unpacked ? `, ${a.unpacked} unpacked` : ""}; top level: ${(a.top ?? []).slice(0, 3).join(", ")}${(a.top ?? []).length > 3 ? ` and ${a.top.length - 3} more` : ""}`, ...a };
  }
  const o = await files.outline(path);
  const r = await files.read(path, { lines: Number(lines), now });
  if (r.error && !r.type) return { verdict: r.error, ...r };
  if (r.error) return { verdict: /not a text file/.test(r.error) ? `${i.path} is ${i.type}, ${i.size}, modified ${i.age}; it holds no text this kit can read${/old Microsoft/.test(i.type) ? " (old binary Office format)" : ""}` : `${i.path} is ${i.type} (${i.size}); ${r.error}`, path: i.path, type: i.type, size: i.size, modified: i.modified, age: i.age, ...(r.need ? { need: r.need } : {}) };
  return {
    verdict: `${i.path} is ${/^[AEIOU]/.test(i.type) ? "an" : "a"} ${i.type}, ${i.size}${r.pages ? `, ${r.pages} ${r.pages === 1 ? "page" : "pages"}` : ""}, ${r.totalLines} lines of text, modified ${i.age}${o.headings?.length ? `; headings: ${o.headings.slice(0, 5).map((h) => h.text.replace(/^#+\s*/, "")).join(" / ")}` : ""}`,
    path: i.path, type: i.type, size: i.size, modified: i.modified, age: i.age,
    ...(r.pages ? { pages: r.pages, pageFirstLines: (o.pages ?? []).map((x) => x.first) } : {}),
    totalLines: r.totalLines,
    ...(o.headings?.length ? { headings: o.headings } : {}),
    ...(r.note ? { note: r.note } : {}),
    text: r.text,
    ...(r.next ? { next: r.next, left: r.left } : {}),
  };
}
