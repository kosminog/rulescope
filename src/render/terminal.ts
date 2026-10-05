import pc from 'picocolors';
import { STATUS_LABELS, type Entry, type Report, type Status, type ToolReport } from '../model.js';

export interface TerminalOptions {
  color?: boolean;
  /** Hide inactive and shadowed entries. */
  activeOnly?: boolean;
}

const STATUS_PAINT: Record<Status, (s: string) => string> = {
  active: pc.green,
  conditional: pc.yellow,
  'on-demand': pc.cyan,
  manual: pc.blue,
  'trust-gated': pc.magenta,
  truncated: pc.red,
  shadowed: pc.gray,
  inactive: pc.gray,
  unknown: pc.yellow,
};

export function renderTerminal(report: Report, options: TerminalOptions = {}): string {
  const color = options.color ?? true;
  const paint = (fn: (s: string) => string, s: string): string => (color ? fn(s) : s);
  const lines: string[] = [];

  lines.push(paint(pc.bold, `rulescope ${report.cwd}`));
  const meta: string[] = [];
  if (report.gitRoot) meta.push(`git root ${report.gitRoot}`);
  if (report.targetFile) meta.push(`target file ${report.targetFile}`);
  meta.push(`rules as of ${report.rulesVersion}`);
  lines.push(paint(pc.dim, meta.join(' · ')));
  lines.push('');

  for (const tool of report.tools) {
    lines.push(...renderTool(tool, paint, options.activeOnly ?? false));
    lines.push('');
  }

  if (report.overlap.length) {
    lines.push(paint(pc.bold, 'Files read by more than one tool'));
    for (const row of report.overlap) {
      const tools = row.tools
        .map((t) => `${t.tool} ${paint(STATUS_PAINT[t.status], STATUS_LABELS[t.status])}`)
        .join(', ');
      lines.push(`  ${row.displayPath}  ${paint(pc.dim, '→')} ${tools}`);
    }
    lines.push('');
  }

  lines.push(paint(pc.dim, legend(paint)));
  return lines.join('\n');
}

function renderTool(
  tool: ToolReport,
  paint: (fn: (s: string) => string, s: string) => string,
  activeOnly: boolean,
): string[] {
  const lines: string[] = [];
  const counts = countStatuses(tool);
  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => paint(STATUS_PAINT[s as Status], `${n} ${STATUS_LABELS[s as Status]}`))
    .join(paint(pc.dim, ' · '));
  lines.push(`${paint(pc.bold, paint(pc.underline, tool.label))}  ${summary}`);

  for (const scope of tool.scopes) {
    const entries = activeOnly
      ? scope.entries.filter((e) => e.status !== 'inactive' && e.status !== 'shadowed')
      : scope.entries;
    if (!entries.length && activeOnly) continue;
    lines.push(
      `  ${paint(pc.bold, scope.label)}${scope.displayDir !== '.' ? paint(pc.dim, `  ${scope.displayDir}`) : ''}`,
    );
    if (!entries.length) {
      lines.push(paint(pc.dim, '    (nothing found)'));
      continue;
    }
    entries.forEach((entry, i) => {
      lines.push(...renderEntry(entry, '    ', i === entries.length - 1, paint, activeOnly));
    });
  }
  for (const note of tool.notes) lines.push(`  ${paint(pc.yellow, '!')} ${note}`);
  for (const blind of tool.blindSpots)
    lines.push(`  ${paint(pc.dim, '?')} ${paint(pc.dim, blind)}`);
  return lines;
}

function renderEntry(
  entry: Entry,
  indent: string,
  last: boolean,
  paint: (fn: (s: string) => string, s: string) => string,
  activeOnly: boolean,
): string[] {
  const branch = last ? '└─' : '├─';
  const badge = paint(STATUS_PAINT[entry.status], `[${STATUS_LABELS[entry.status]}]`);
  const kind = paint(pc.dim, entry.kind.padEnd(13));
  const name =
    entry.kind === 'skill' || entry.kind === 'agent' || entry.kind === 'command'
      ? ` ${paint(pc.bold, entry.name ?? '')}`
      : '';
  const tags = entry.tags?.length
    ? ' ' + paint(pc.dim, entry.tags.map((t) => `#${t}`).join(' '))
    : '';
  const size = entry.bytes !== undefined ? paint(pc.dim, ` ${formatBytes(entry.bytes)}`) : '';
  const lines = [`${indent}${branch} ${badge} ${kind}${entry.displayPath}${name}${size}${tags}`];
  const childIndent = indent + (last ? '   ' : '│  ');
  lines.push(`${childIndent}${paint(pc.dim, entry.reason)}`);
  if (entry.children?.length) {
    const children = activeOnly
      ? entry.children.filter((c) => c.status !== 'inactive' && c.status !== 'shadowed')
      : entry.children;
    children.forEach((child, i) =>
      lines.push(...renderEntry(child, childIndent, i === children.length - 1, paint, activeOnly)),
    );
  }
  return lines;
}

function countStatuses(tool: ToolReport): Record<Status, number> {
  const counts = {
    active: 0,
    conditional: 0,
    'on-demand': 0,
    manual: 0,
    'trust-gated': 0,
    truncated: 0,
    shadowed: 0,
    inactive: 0,
    unknown: 0,
  } as Record<Status, number>;
  const visit = (entries: Entry[]): void => {
    for (const e of entries) {
      counts[e.status]++;
      if (e.children) visit(e.children);
    }
  };
  for (const scope of tool.scopes) visit(scope.entries);
  return counts;
}

function legend(paint: (fn: (s: string) => string, s: string) => string): string {
  return [
    `${paint(pc.green, 'active')} loaded at session start`,
    `${paint(pc.yellow, 'conditional')} loads for matching files`,
    `${paint(pc.cyan, 'on demand')} loads when used`,
    `${paint(pc.blue, 'manual')} user-invoked only`,
    `${paint(pc.magenta, 'trust gated')} needs approval`,
    `${paint(pc.red, 'truncated')} cut by a budget`,
    `${paint(pc.gray, 'shadowed/inactive')} never loaded`,
  ].join('  ');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}
