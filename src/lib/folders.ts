export interface FolderStatLike {
  count: number;
  path: string;
}

export interface FolderBranchOption {
  count: number;
  depth: number;
  path: string;
}

export function normalizeFolderPath(path: string): string {
  const trimmed = path.trim().replace(/^["']|["']$/g, '');
  if (trimmed === '/' || trimmed === '\\') return trimmed;
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function splitFolderPath(path: string): string[] {
  return normalizeFolderPath(path).split(/[\\/]+/).filter(Boolean);
}

function getPathPrefix(path: string, depth: number): string {
  const normalizedPath = normalizeFolderPath(path).replaceAll('\\', '/');
  const isAbsolute = normalizedPath.startsWith('/');
  const parts = splitFolderPath(normalizedPath);
  const prefix = parts.slice(0, depth).join('/');
  return isAbsolute ? `/${prefix}` : prefix;
}

export function getFolderBranchOptions(stats: FolderStatLike[]): FolderBranchOption[] {
  const branchCounts = new Map<string, { count: number; depth: number }>();

  for (const stat of stats) {
    const normalizedPath = normalizeFolderPath(stat.path);
    const depth = splitFolderPath(normalizedPath).length;

    for (let index = 1; index <= depth; index += 1) {
      const path = getPathPrefix(normalizedPath, index);
      if (!path) continue;

      const existing = branchCounts.get(path);
      branchCounts.set(path, {
        count: (existing?.count ?? 0) + stat.count,
        depth: index
      });
    }
  }

  return Array.from(branchCounts.entries())
    .map(([path, value]) => ({ path, count: value.count, depth: value.depth }))
    .sort((left, right) => (
      left.path.localeCompare(right.path) ||
      left.depth - right.depth
    ));
}
