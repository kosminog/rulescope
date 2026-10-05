import { buildContext, type PartialOptions } from './context.js';
import { RULES_VERSION } from './docs.js';
import { clearFsCache } from './fs.js';
import type { Entry, OverlapEntry, Report, ToolId, ToolReport } from './model.js';
import { TOOL_IDS } from './model.js';
import { resolveClaude } from './tools/claude.js';
import { resolveCodex } from './tools/codex.js';
import { resolveCursor } from './tools/cursor.js';

export * from './model.js';
export { buildContext, displayPath } from './context.js';
export type { ResolveContext, PartialOptions } from './context.js';
export { renderTerminal } from './render/terminal.js';
export { renderHtml } from './render/html.js';
export { parseFrontmatter } from './frontmatter.js';
export { RULES_VERSION, DOCS } from './docs.js';

const RESOLVERS: Record<ToolId, (ctx: ReturnType<typeof buildContext>) => ToolReport> = {
  claude: resolveClaude,
  codex: resolveCodex,
  cursor: resolveCursor,
};

export interface ResolveAllOptions extends PartialOptions {
  tools?: ToolId[];
}

export function resolveReport(options: ResolveAllOptions = {}): Report {
  clearFsCache();
  const ctx = buildContext(options);
  const tools = (options.tools?.length ? options.tools : TOOL_IDS).map((id) => RESOLVERS[id](ctx));
  return {
    generatedAt: new Date().toISOString(),
    rulesVersion: RULES_VERSION,
    cwd: ctx.cwd,
    home: ctx.home,
    gitRoot: ctx.gitRoot,
    targetFile: ctx.target,
    tools,
    overlap: computeOverlap(tools),
  };
}

export function* walkEntries(report: ToolReport): Generator<Entry> {
  const visit = function* (entries: Entry[]): Generator<Entry> {
    for (const e of entries) {
      yield e;
      if (e.children) yield* visit(e.children);
    }
  };
  for (const scope of report.scopes) yield* visit(scope.entries);
}

function computeOverlap(tools: ToolReport[]): OverlapEntry[] {
  const byPath = new Map<string, OverlapEntry>();
  for (const report of tools) {
    for (const e of walkEntries(report)) {
      const row = byPath.get(e.path) ?? { path: e.path, displayPath: e.displayPath, tools: [] };
      if (!row.tools.some((t) => t.tool === e.tool))
        row.tools.push({ tool: e.tool, status: e.status, kind: e.kind });
      byPath.set(e.path, row);
    }
  }
  return [...byPath.values()]
    .filter((r) => r.tools.length > 1)
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}
