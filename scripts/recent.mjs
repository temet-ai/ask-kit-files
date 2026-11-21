export const meta = {
  purpose:
    "What changed in a folder lately: the files modified in the last few days, grouped by sub-folder, with the newest files listed. The answer to 'what changed in ~/Documents this week', 'what did I touch yesterday', 'what is new in Downloads'. It sees modified times only: a deleted file leaves nothing to see.",
  params: { under: "the folder; default the agent's folder", since: "default 7 days; a date, today, yesterday, this week, last week, or an age such as 36h", before: "optional end of the window", kind: "document, image, archive, video, audio, code, data (a list is fine)", limit: "files listed, default 20", all: "true to include node_modules, .git and caches", now: "the moment ages are measured from (ISO date)" },
  returns: "{verdict, under, since, changed, folders:[{folder, files, newest, newestAge}], files:[{path, size, modified, age}], more, searched, stopped?}",
  example: 'await scripts.run("recent", { under: "~/Documents", since: "this week" })',
};

export default async function ({ files }, { under, since = "7 days", before, kind, limit = 20, all, now } = {}) {
  const base = under ?? files.workdir;
  const r = await files.find({ under: base, modifiedSince: since, modifiedBefore: before, kind, sort: "newest", limit: 5000, all: all === true || all === "true", now });
  if (r.error) return { verdict: r.error, ...r };
  const root = r.under[0];
  const groups = new Map();
  for (const f of r.files) {
    const rel = f.path.startsWith(`${root}/`) ? f.path.slice(root.length + 1) : f.path;
    const folder = rel.includes("/") ? rel.split("/")[0] : ".";
    const g = groups.get(folder) ?? { folder, files: 0, newest: f.modified, newestAge: f.age };
    g.files++;
    groups.set(folder, g);
  }
  const n = Number(limit);
  const w = String(since).trim();
  const span = /^(since|this|last|past|in the|during|within) /i.test(w) ? w : /^(\d+(\.\d+)?\s*[a-z]|an? |one |two |three |few |couple)/i.test(w) ? `in the last ${w.replace(/ ago$/, "")}` : /^(today|yesterday)$/i.test(w) ? w : `since ${w}`;
  const verdict = r.matched
    ? `${r.matched} files changed in ${root} ${span}, in ${groups.size} ${groups.size === 1 ? "folder" : "folders"}; the newest is ${r.files[0].path} (${r.files[0].age})${r.stopped ? "; the search stopped early, so this is partial" : ""}`
    : `no file in ${root} changed ${span}${r.stopped ? " (the search stopped early, so this is partial)" : ""}`;
  return {
    verdict,
    under: r.under,
    since,
    changed: r.matched,
    folders: [...groups.values()].sort((a, b) => b.files - a.files).slice(0, 15),
    files: r.files.slice(0, n).map(({ path, size, modified, age }) => ({ path, size, modified, age })),
    more: Math.max(0, r.matched - n),
    searched: r.searched,
    ...(r.stopped ? { stopped: r.stopped } : {}),
  };
}
