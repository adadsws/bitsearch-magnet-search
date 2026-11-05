// 已验证 infohash 的 Torrent 文件表是完整来源；API 路径只用于选择更熟悉的显示名称。
function normalizeFilePath(value) {
  return String(value ?? "").replaceAll("\\", "/").split("/").filter(Boolean).join("/").normalize("NFKC").toLowerCase();
}

function mergeFileSizes(apiFiles, metadataFiles) {
  const apiEntries = apiFiles.map(file => ({file, path: typeof file === "string" ? file : file?.path || file?.name || ""}));
  const apiByPath = new Map(), suffixCount = new Map();
  apiEntries.forEach((entry, index) => {
    const key = normalizeFilePath(entry.path);
    if (!apiByPath.has(key)) apiByPath.set(key, []);
    apiByPath.get(key).push(index);
  });
  for (const metadata of metadataFiles) {
    const parts = normalizeFilePath(metadata.path).split("/");
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/");
      suffixCount.set(suffix, (suffixCount.get(suffix) || 0) + 1);
    }
  }
  const used = new Set(), files = [], seen = new Set();
  let matched = 0;
  for (const metadata of metadataFiles) {
    const raw = String(metadata.path || ""), key = normalizeFilePath(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let matchIndex = -1;
    const parts = key.split("/");
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/"), indices = apiByPath.get(suffix) || [];
      if (suffixCount.get(suffix) === 1 && indices.length === 1 && !used.has(indices[0])) {
        matchIndex = indices[0];
        break;
      }
    }
    // 相同文件名出现在多个目录时，不猜测其 API 对应路径。
    if (matchIndex >= 0) {
      used.add(matchIndex);
      matched++;
    }
    const match = apiEntries[matchIndex];
    const displayPath = match && !match.path.includes("�") ? match.path : raw;
    const fields = match && typeof match.file === "object" ? match.file : {};
    files.push({...fields, path: displayPath, size: metadata.size});
  }
  return {files, filled: files.length, matched, unmatchedApi: apiEntries.length - matched};
}

// 任一后代文件缺大小时，文件夹合计大小保持未知；文件数量仍可确定。
function summarizeFileTree(branch) {
  let count = branch.files.size, bytes = 0, unknown = false;
  for (const size of branch.files.values()) {
    if (size == null || !Number.isFinite(Number(size))) unknown = true;
    else bytes += Number(size);
  }
  for (const child of branch.folders.values()) {
    const total = summarizeFileTree(child);
    count += total.count;
    if (total.bytes == null) unknown = true;
    else bytes += total.bytes;
  }
  branch.total = {count, bytes: unknown ? null : bytes};
  return branch.total;
}

// 只在同一目录内排序，保留父子关系；未知大小固定排在有大小条目之后。
function sortedFileEntries(branch, key = "name", direction = "asc") {
  const entries = [
    ...[...branch.folders].map(([name, child]) => ({name, folder: true, child, bytes: child.total.bytes, count: child.total.count})),
    ...[...branch.files].map(([name, size]) => ({name, folder: false, bytes: size, count: 1})),
  ];
  const sign = direction === "desc" ? -1 : 1;
  return entries.sort((a, b) => {
    if (key === "name" && a.folder !== b.folder) return a.folder ? -1 : 1;
    if (key === "size") {
      if (a.bytes == null || b.bytes == null) {
        if (a.bytes == null && b.bytes != null) return 1;
        if (b.bytes == null && a.bytes != null) return -1;
      } else if (a.bytes !== b.bytes) return sign * (a.bytes - b.bytes);
    } else if (key === "count" && a.count !== b.count) return sign * (a.count - b.count);
    else if (key === "name") return sign * a.name.localeCompare(b.name, "zh-Hans", {numeric: true});
    return a.name.localeCompare(b.name, "zh-Hans", {numeric: true});
  });
}

if (typeof module !== "undefined") module.exports = {normalizeFilePath, mergeFileSizes, summarizeFileTree, sortedFileEntries};
