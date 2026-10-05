import type { Frontmatter } from './model.js';

export interface ParsedDocument {
  frontmatter: Frontmatter | null;
  body: string;
  /** True when a `---` block was present but could not be parsed. */
  malformed: boolean;
}

/**
 * Minimal YAML-subset frontmatter parser. Handles the shapes used by rule,
 * skill and agent files: scalars, quoted strings, inline lists, block lists,
 * booleans, numbers, and block scalars (`|` / `>`). Unknown shapes are kept
 * as raw strings rather than failing, because a malformed frontmatter must
 * not hide a file from the report.
 */
export function parseFrontmatter(text: string): ParsedDocument {
  if (!text.startsWith('---')) return { frontmatter: null, body: text, malformed: false };
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter: null, body: text, malformed: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: null, body: text, malformed: true };
  const block = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n');
  try {
    return { frontmatter: parseBlock(block), body, malformed: false };
  } catch {
    return { frontmatter: null, body, malformed: true };
  }
}

function parseBlock(lines: string[]): Frontmatter {
  const out: Frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1] as string;
    const rest = (match[2] ?? '').trim();
    if (rest === '' || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      // Block list, nested map, or block scalar on following indented lines.
      const nested: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        if (next.trim() === '' || /^\s+/.test(next)) {
          nested.push(next);
          j++;
        } else break;
      }
      i = j;
      if (rest !== '') {
        const dedented = dedent(nested);
        out[key] = rest.startsWith('>') ? dedented.join(' ').trim() : dedented.join('\n').trim();
      } else if (nested.some((l) => /^\s*-\s*/.test(l))) {
        out[key] = nested
          .map((l) => l.trim())
          .filter((l) => l.startsWith('-'))
          .map((l) => parseScalar(l.replace(/^-\s*/, '')));
      } else if (nested.some((l) => l.trim() !== '')) {
        out[key] = parseBlock(dedent(nested));
      } else {
        out[key] = null;
      }
      continue;
    }
    out[key] = parseScalar(rest);
    i++;
  }
  return out;
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^\s*/.exec(l)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

function parseScalar(raw: string): unknown {
  const value = stripComment(raw.trim());
  if (value === '') return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return splitList(inner).map((item) => parseScalar(item));
  }
  if (value.startsWith('{') && value.endsWith('}')) return value;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function stripComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value;
  const idx = value.indexOf(' #');
  return idx === -1 ? value : value.slice(0, idx).trim();
}

function splitList(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') items.push(current.trim());
  return items;
}

/** Normalize a frontmatter value that may be a list, a comma-separated string, or absent. */
export function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
