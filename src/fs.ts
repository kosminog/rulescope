import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface FileStat {
  exists: boolean;
  isFile: boolean;
  isDir: boolean;
  size: number;
}

const statCache = new Map<string, FileStat>();

export function statPath(path: string): FileStat {
  const cached = statCache.get(path);
  if (cached) return cached;
  let result: FileStat;
  try {
    const s = statSync(path);
    result = { exists: true, isFile: s.isFile(), isDir: s.isDirectory(), size: s.size };
  } catch {
    result = { exists: false, isFile: false, isDir: false, size: 0 };
  }
  statCache.set(path, result);
  return result;
}

export function clearFsCache(): void {
  statCache.clear();
}

export function isFile(path: string): boolean {
  return statPath(path).isFile;
}

export function isDir(path: string): boolean {
  return statPath(path).isDir;
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(text));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Settings files are occasionally written with comments; tolerate them. */
function stripJsonComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

export function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/** Immediate subdirectories, sorted. */
export function listSubdirs(path: string): string[] {
  return listDir(path).filter((name) => isDir(join(path, name)));
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'DerivedData',
]);

/**
 * Walk directories below root up to `depth` levels, calling `visit` for each.
 * Skips dependency and build directories. Returns directories in traversal order.
 */
export function walkDown(
  root: string,
  depth: number,
  visit: (dir: string, level: number) => void,
): void {
  const walk = (dir: string, level: number): void => {
    if (level > depth) return;
    visit(dir, level);
    for (const name of listSubdirs(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      walk(join(dir, name), level + 1);
    }
  };
  walk(root, 0);
}

/** Directories from the filesystem root down to and including `dir`. */
export function chainFromRoot(dir: string): string[] {
  const chain: string[] = [];
  let current = resolve(dir);
  for (;;) {
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

/** Find the nearest ancestor (or `dir` itself) containing a `.git` entry. */
export function findGitRoot(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (statPath(join(current, '.git')).exists) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Recursively list files under `dir` whose name matches `test`. Follows symlinks. */
export function findFiles(dir: string, test: (name: string) => boolean, maxDepth = 6): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number): void => {
    if (level > maxDepth) return;
    for (const name of listDir(d)) {
      const full = join(d, name);
      const st = statPath(full);
      if (st.isFile && test(name)) out.push(full);
      else if (st.isDir && !SKIP_DIRS.has(name)) walk(full, level + 1);
    }
  };
  walk(dir, 0);
  return out;
}

export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
