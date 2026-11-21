export const meta = {
  purpose:
    "What uses the disk space under a folder: its total, the biggest sub-folders with their share, the biggest files, bytes by kind (document, video, archive...), and the disk's free space. The answer to 'what is taking up space in my home folder', 'why is Downloads so big', 'what can I delete'. With `stale`, also the big files nobody has modified for a while. Counts node_modules and caches, which find leaves out.",
  params: { path: "the folder; default the home folder", depth: "levels of sub-folders to list, default 2", top: "folders and files listed, default 12", stale: "also list files over 10MB not modified for this long, e.g. 6 months", now: "the moment ages are measured from (ISO date)" },
  returns: "{verdict, path, size, files, folders:[{path, size, percent, files}], biggestFiles:[{path, size, percent, age}], byKind, disk:{total, free, usedPercent}, stale?:[{path, size, age}], private?, stopped?}",
  example: 'await scripts.run("space", { path: "~/Downloads", stale: "6 months" })',
};

export default async function ({ files }, { path = "~", depth = 2, top = 12, stale, now } = {}) {
  const r = files.du(path, { depth: Number(depth), top: Number(top), now });
  if (r.error) return { verdict: r.error, ...r };
  const f0 = r.folders[0];
  const b0 = r.biggestFiles[0];
  let old;
  if (stale) {
    const s = await files.find({ under: path, modifiedBefore: stale, minSize: "10MB", sort: "biggest", limit: 8, all: true, now });
    old = { count: s.matched, list: s.files.map(({ path, size, age }) => ({ path, size, age })) };
  }
  const verdict = `${r.path} holds ${r.size} in ${r.files} files${f0 ? `; the biggest folder is ${f0.path} (${f0.size}, ${f0.percent}%)` : ""}${b0 ? `; the biggest file is ${b0.path} (${b0.size})` : ""}${r.disk ? `; the disk has ${r.disk.free} free (${r.disk.usedPercent}% used)` : ""}${r.stopped ? "; the walk stopped early, so the sizes are a lower bound" : ""}${old ? `; ${old.count} files over 10MB are older than ${stale}` : ""}`;
  return {
    verdict,
    path: r.path,
    size: r.size,
    files: r.files,
    folders: r.folders.map(({ path, size, percent, files }) => ({ path, size, percent, files })),
    moreFolders: r.moreFolders,
    biggestFiles: r.biggestFiles.map(({ path, size, percent, age }) => ({ path, size, percent, age })),
    byKind: r.byKind,
    ...(r.disk ? { disk: r.disk } : {}),
    ...(old ? { stale: old.list, staleCount: old.count } : {}),
    ...(r.private ? { private: r.private } : {}),
    ...(r.stopped ? { stopped: r.stopped } : {}),
  };
}
