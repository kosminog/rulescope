#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import { safeRealpath } from './fs.js';
import { resolveReport, walkEntries, type ResolveAllOptions } from './index.js';
import { TOOL_IDS, type ToolId } from './model.js';
import { renderHtml } from './render/html.js';
import { renderTerminal } from './render/terminal.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/** Options shared by the report and `explain` commands. */
interface ResolveCliOptions {
  tool?: string;
  file?: string;
  home?: string;
  addDir?: string[];
  codexProfile?: string;
  trusted?: boolean;
  depth: number;
}

interface ReportCliOptions extends ResolveCliOptions {
  html?: string;
  open?: boolean;
  json?: boolean;
  content?: boolean;
  color?: boolean;
  activeOnly?: boolean;
}

interface ExplainCliOptions extends ResolveCliOptions {
  dir: string;
}

const program = new Command();
program
  .name('rulescope')
  // Without this, options that both commands define (--file, --home, ...) are
  // swallowed by the root command even when they follow `explain`.
  .enablePositionalOptions()
  .description(
    'Show which instruction files, rules and skills Claude Code, Codex and Cursor load for a directory.',
  )
  .version(pkg.version)
  .argument('[dir]', 'directory to evaluate', '.');
addResolveOptions(program)
  .option('--html <out>', 'write a self-contained HTML report to this path')
  .option('--open', 'open the HTML report after writing it')
  .option('--json', 'print the report as JSON instead of a tree')
  .option('--no-content', 'do not capture file contents into the report')
  .option('--active-only', 'hide inactive and shadowed entries in terminal output')
  .option('--no-color', 'disable colors')
  .action((dir: string, options: ReportCliOptions) => {
    const report = resolveReport({
      ...resolveOptionsFrom(dir, options),
      includeContent: options.content !== false,
    });

    if (options.html) {
      const out = resolve(options.html);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, renderHtml(report), 'utf8');
      if (!options.json) process.stderr.write(`${pc.green('✔')} wrote ${out}\n`);
      if (options.open) openInBrowser(out);
    }
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    const color = options.color !== false && process.stdout.isTTY === true && !process.env.NO_COLOR;
    process.stdout.write(
      renderTerminal(report, { color, activeOnly: options.activeOnly ?? false }) + '\n',
    );
  });

const explain = program
  .command('explain <path>')
  .description('show what each tool does with one file')
  .option('-C, --dir <dir>', 'directory to evaluate', '.');
addResolveOptions(explain).action((path: string, options: ExplainCliOptions) => {
  // Compare real paths so a symlinked location (/tmp on macOS) still matches.
  const target = safeRealpath(resolve(path));
  const report = resolveReport({
    ...resolveOptionsFrom(options.dir, options),
    includeContent: false,
  });
  let found = false;
  for (const tool of report.tools) {
    for (const entry of walkEntries(tool)) {
      if (safeRealpath(entry.path) !== target) continue;
      found = true;
      process.stdout.write(
        `${pc.bold(tool.label)}: ${entry.status}\n  ${entry.reason}\n${entry.docUrl ? `  ${pc.dim(entry.docUrl)}\n` : ''}`,
      );
    }
  }
  if (!found) {
    process.stdout.write(`No tool evaluated from ${report.cwd} reads ${target}.\n`);
    process.exitCode = 1;
  }
});

program.parse();

function addResolveOptions(cmd: Command): Command {
  return cmd
    .option('-t, --tool <tools>', `comma-separated subset of ${TOOL_IDS.join(',')}`, parseTools)
    .option(
      '-f, --file <path>',
      'file the agent would work on; resolves path-scoped rules and subdirectory instructions',
    )
    .option('--home <dir>', 'home directory to inspect instead of $HOME')
    .option('--add-dir <dir...>', 'directories passed to Claude Code via --add-dir')
    .option('--codex-profile <name>', 'Codex profile to apply')
    .option(
      '--trusted',
      'treat the project as trusted or approved where a tool gates config on trust',
    )
    .option(
      '--depth <n>',
      'how many levels below the directory to scan for nested instruction files',
      parseDepth,
      4,
    );
}

function resolveOptionsFrom(dir: string, options: ResolveCliOptions): ResolveAllOptions {
  return {
    cwd: resolve(dir),
    ...(options.home ? { home: resolve(options.home) } : {}),
    ...(options.file ? { targetFile: options.file } : {}),
    ...(options.codexProfile ? { codexProfile: options.codexProfile } : {}),
    addDirs: options.addDir ?? [],
    trusted: options.trusted ?? false,
    subdirDepth: options.depth,
    tools: parseTools(options.tool),
  };
}

function parseTools(value: string | ToolId[] | undefined): ToolId[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const ids = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = ids.filter((id) => !(TOOL_IDS as readonly string[]).includes(id));
  if (bad.length)
    throw new InvalidArgumentError(
      `Unknown tool(s): ${bad.join(', ')}. Expected ${TOOL_IDS.join(', ')}.`,
    );
  return ids as ToolId[];
}

function parseDepth(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('Expected a whole number of levels.');
  return Number(value);
}

function openInBrowser(path: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    process.stderr.write(`Could not open a browser; open ${path} manually.\n`);
  }
}
