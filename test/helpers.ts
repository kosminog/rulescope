import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import {
  resolveReport,
  walkEntries,
  type Entry,
  type Report,
  type ToolId,
  type ResolveAllOptions,
} from '../src/index.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Create an isolated temp root holding a fake home and a fake project. */
export function sandbox(): { root: string; home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'rulescope-'));
  created.push(root);
  const home = join(root, 'home');
  const project = join(root, 'home', 'work', 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, home, project };
}

/** Write files from a {relativePath: content} map under `root`. */
export function tree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
}

export function run(options: ResolveAllOptions & { cwd: string; home: string }): Report {
  return resolveReport({ env: {}, platform: 'linux', includeContent: true, ...options });
}

export function entries(report: Report, tool: ToolId): Entry[] {
  const t = report.tools.find((r) => r.tool === tool);
  if (!t) throw new Error(`no report for ${tool}`);
  return [...walkEntries(t)];
}

export function byPath(list: Entry[], suffix: string): Entry {
  const hit = list.find((e) => e.path.endsWith(suffix));
  if (!hit)
    throw new Error(`no entry ending with ${suffix}; have ${list.map((e) => e.path).join(', ')}`);
  return hit;
}

export function statuses(list: Entry[], suffix: string): string[] {
  return list.filter((e) => e.path.endsWith(suffix)).map((e) => e.status);
}
