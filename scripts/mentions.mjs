export const meta = {
  purpose:
    "Which files mention some text, with the matching lines: plain text, Markdown, and by default the text inside PDF, Word, Excel, PowerPoint and OpenDocument files. The answer to 'which documents mention Vetinari', 'where did I write about the Hex link', 'which invoice has AM$ 1,200'. Give several texts and a file must hold all of them. Passwords and tokens in the lines are redacted; credential files are never searched.",
  params: { text: "a string, a /regex/, or a list that each file must all hold", under: "a folder (or a list); default every root", kind: "narrow to document, code, data... (a list is fine)", ext: "narrow to extensions", docs: "false to skip PDF and office files, default true", hidden: "true to search hidden files and folders (.config, .local...); by default they are skipped", limit: "files returned, default 20", now: "the moment ages are measured from (ISO date)" },
  returns: "{verdict, matchedFiles, files:[{path, size, modified, age, type?, hits, lines:[{line, text}]}], more, documents:{found, searched, left?, notRead?}, stopped?}",
  example: 'await scripts.run("mentions", { text: "Vetinari", under: "~/Documents" })',
};

export default async function ({ files }, { text, under, kind, ext, docs = true, hidden = false, limit = 20, now } = {}) {
  if (text == null || text === "") throw new Error("mentions needs `text`: what to look for");
  const r = await files.grep(text, { under, kind, ext, docs: docs !== false && docs !== "false", limit: Number(limit), perFile: 3, hidden: hidden === true || hidden === "true", now });
  if (r.error) return { verdict: r.error, ...r };
  const d = typeof r.documents === "object" ? r.documents : null;
  const caveat = [r.stopped && "the search stopped early, so this is partial", d?.left && "some documents were not searched", d?.notRead && `${Object.values(d.notRead).reduce((a, b) => a + b, 0)} documents could not be read (${Object.keys(d.notRead).join("; ")})`].filter(Boolean).join("; ");
  const what = [].concat(text).map((t) => `"${t}"`).join(" and ");
  const verdict = r.matchedFiles
    ? `${r.matchedFiles} ${r.matchedFiles === 1 ? "file mentions" : "files mention"} ${what} under ${r.under.join(", ")}; the newest is ${r.files[0].path} (${r.files[0].age})${caveat ? `; ${caveat}` : ""}`
    : `no file mentions ${what} under ${r.under.join(", ")}${caveat ? `; ${caveat}` : ""}`;
  return { verdict, ...r };
}
