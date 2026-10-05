import picomatch from 'picomatch';
import { relative, isAbsolute } from 'node:path';

/**
 * Match a file against rule globs the way agent tools do: patterns are relative
 * to the project root, a bare `*.ts` matches at any depth, and a directory
 * pattern such as `src/` matches everything under it.
 */
export function matchesAnyGlob(globs: string[], file: string, root: string): boolean {
  if (globs.length === 0) return false;
  const rel = isAbsolute(file) ? relative(root, file) : file;
  const normalized = rel.split('\\').join('/');
  for (const glob of globs) {
    const patterns = expandGlob(glob);
    if (picomatch.isMatch(normalized, patterns, { dot: true })) return true;
  }
  return false;
}

function expandGlob(glob: string): string[] {
  const g = glob.trim().replace(/^\.\//, '');
  if (g === '') return [];
  const out = [g];
  if (!g.includes('/')) out.push(`**/${g}`);
  if (g.endsWith('/')) out.push(`${g}**`);
  return out;
}
