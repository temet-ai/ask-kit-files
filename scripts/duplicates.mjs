export const meta = {
  purpose:
    "Files that exist more than once: groups of byte-identical files under a folder, biggest waste first, with where each copy is and how old. The answer to 'do I have duplicates in Downloads', 'which copies can I delete', 'why do I have two errol.png'. Compares size, then content (sha256); hard links of one file are not copies. Changes nothing.",
  params: { under: "the folder (or a list); default every root", minSize: "ignore files smaller than this, default 1 byte; use 1MB for big waste", kind: "narrow to image, video, document... (a list is fine)", limit: "groups listed, default 10", now: "the moment ages are measured from (ISO date)" },
  returns: "{verdict, filesCompared, groupCount, wasted, groups:[{size, copies, wasted, sha256, files:[{path, modified, age}]}], more, unchecked?, stopped?}",
  example: 'await scripts.run("duplicates", { under: "~/Downloads", minSize: "1MB" })',
};

export default async function ({ files }, { under, minSize, kind, limit = 10, now } = {}) {
  const r = files.duplicates(under, { minSize, kind, limit: Number(limit), now });
  if (r.error) return { verdict: r.error, ...r };
  const g = r.groups[0];
  const partial = r.stopped || r.unchecked ? "; the search ran out of time, so this is partial" : "";
  const verdict = r.groupCount
    ? `${r.groupCount} ${r.groupCount === 1 ? "group" : "groups"} of identical files under ${r.under.join(", ")} waste ${r.wasted}; the biggest is ${g.copies} copies of ${g.files[0].path.split("/").pop()} (${g.size} each)${partial}`
    : `no identical files among ${r.filesCompared} compared under ${r.under.join(", ")}${partial}`;
  return { verdict, ...r };
}
