import { basename, join } from 'node:path';
import type { ResolveContext } from './context.js';
import { parseFrontmatter } from './frontmatter.js';
import { listDir, readText, statPath } from './fs.js';
import type { Entry, EntryKind, Frontmatter, Scope, ScopeLevel, Status, ToolId } from './model.js';

export interface EntryInput {
  tool: ToolId;
  kind: EntryKind;
  path: string;
  status: Status;
  reason: string;
  docUrl?: string;
  name?: string;
  description?: string;
  tags?: string[];
  globs?: string[];
  matchesTarget?: boolean;
  /** Skip reading the file (for entries that represent a missing or virtual file). */
  virtual?: boolean;
  content?: string;
}

export interface LoadedFile {
  frontmatter: Frontmatter | null;
  body: string;
  bytes: number;
  malformed: boolean;
}

export function loadFile(path: string): LoadedFile | null {
  const text = readText(path);
  if (text === null) return null;
  const parsed = parseFrontmatter(text);
  return {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    bytes: Buffer.byteLength(text, 'utf8'),
    malformed: parsed.malformed,
  };
}

export function makeEntry(
  ctx: ResolveContext,
  input: EntryInput,
  loaded?: LoadedFile | null,
): Entry {
  const entry: Entry = {
    id: `${input.tool}:${input.kind}:${input.path}`,
    tool: input.tool,
    kind: input.kind,
    path: input.path,
    displayPath: ctx.display(input.path),
    status: input.status,
    reason: input.reason,
  };
  if (input.docUrl) entry.docUrl = input.docUrl;
  if (input.tags?.length) entry.tags = [...input.tags];
  if (input.globs?.length) entry.globs = [...input.globs];
  if (input.matchesTarget !== undefined) entry.matchesTarget = input.matchesTarget;

  const file = input.virtual ? null : (loaded ?? loadFile(input.path));
  if (file) {
    entry.bytes = file.bytes;
    if (file.frontmatter) entry.frontmatter = file.frontmatter;
    if (file.malformed) entry.tags = [...(entry.tags ?? []), 'malformed-frontmatter'];
    const desc = file.frontmatter?.description;
    if (typeof desc === 'string' && desc.trim()) entry.description = desc.trim();
    if (ctx.includeContent) entry.content = truncate(file.body, ctx.maxContentBytes);
  } else if (!input.virtual) {
    entry.bytes = statPath(input.path).size;
  }
  if (input.content !== undefined && ctx.includeContent)
    entry.content = truncate(input.content, ctx.maxContentBytes);
  if (input.description) entry.description = input.description;
  if (input.name) entry.name = input.name;
  else if (file?.frontmatter && typeof file.frontmatter.name === 'string')
    entry.name = file.frontmatter.name;
  else entry.name = basename(input.path);
  return entry;
}

function truncate(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  return text.slice(0, max) + '\n…[truncated by rulescope]';
}

export function makeScope(
  ctx: ResolveContext,
  tool: ToolId,
  level: ScopeLevel,
  label: string,
  dir: string,
): Scope {
  return {
    id: `${tool}:${level}:${dir}`,
    tool,
    level,
    label,
    dir,
    displayDir: ctx.display(dir),
    entries: [],
  };
}

/** Find SKILL.md files under a skills root, up to three levels deep (skills may be nested). */
export function findSkillFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    const st = statPath(dir);
    if (!st.isDir) return;
    for (const name of listDir(dir)) {
      const full = join(dir, name);
      if (name === 'SKILL.md' && statPath(full).isFile) out.push(full);
      else if (statPath(full).isDir && !name.startsWith('.')) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
