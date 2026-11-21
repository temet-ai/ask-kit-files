export const meta = {
  purpose:
    "Find files or folders by name, kind, size and time, newest first. The answer to 'where is the invoice from Harry King', 'which PDFs did I download this week', 'the biggest videos', 'a file I saved last month called thud'. Searches the home folder and the agent's folder unless `under` names one. Names are words (all must be in the name or path), a glob or a /regex/. Credential files are never listed.",
  params: {
    name: "words that must all be in the name or path, a glob such as *.pdf, or a /regex/",
    kind: "document, image, archive, video, audio, code, data, pdf or folder (a list is fine)",
    ext: "extensions, e.g. docx or [\"docx\",\"xlsx\"]",
    since: "modified since: a date, today, yesterday, this week, last week, this month, or an age such as 3 days",
    before: "modified before the same kinds of value",
    minSize: "e.g. 100MB", maxSize: "e.g. 1KB",
    under: "a folder (or a list) to search instead of every root",
    sort: "newest (default), oldest, biggest, smallest or name",
    by: "created to use the creation time for since and before",
    limit: "rows returned, default 25", all: "true to look inside node_modules, .git and caches too", now: "the moment ages are measured from (ISO date)",
  },
  returns: "{verdict, under, match, matched, files:[{path, size, bytes, modified, age}], more, searched, stopped?, skipped, index?} or {verdict, error, folder, has:[names near it]}",
  example: 'await scripts.run("find", { name: "invoice", kind: "document", since: "this month" })',
};

export default async function ({ files }, p = {}) {
  const { name, kind, ext, since, before, minSize, maxSize, under, sort, by, limit = 25, all, now } = p;
  if (!name && !kind && !ext && !since && !before && !minSize && !maxSize) throw new Error("find needs at least one of name, kind, ext, since, before, minSize or maxSize");
  const r = await files.find({ name, kind, ext, modifiedSince: since, modifiedBefore: before, minSize, maxSize, under, sort, by, limit: Number(limit), all: all === true || all === "true", now });
  if (r.error) return { verdict: r.error, ...r };
  const what = [name && `"${name}"`, kind, ext && `.${[].concat(ext).join("/.")}`, since && (/^(since|this|last|past|in the|during|within) /i.test(String(since)) || /^(today|yesterday)$/i.test(String(since)) ? String(since) : /^(\d+(\.\d+)?\s*[a-z]|an? )/i.test(String(since)) ? `in the last ${since}` : `since ${since}`), before && `before ${before}`, minSize && `over ${minSize}`, maxSize && `under ${maxSize}`].filter(Boolean).join(" ");
  const top = r.files[0];
  const verdict = r.matched
    ? `${r.matched} ${r.matched === 1 ? "match" : "matches"} for ${what} in ${r.under.join(", ")}; ${sort === "oldest" ? "oldest" : sort === "biggest" ? "biggest" : "first"}: ${top.path} (${top.size}, ${top.age})${r.stopped ? "; the search stopped early, so this is partial" : ""}`
    : `nothing matches ${what} in ${r.under.join(", ")}${r.stopped ? "; the search stopped early, so this is partial" : r.skipped?.pruned ? `; ${r.skipped.pruned} caches and dependency folders were not searched (all: true includes them)` : ""}`;
  return { verdict, ...r };
}
