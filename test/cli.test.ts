import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sandbox, tree } from './helpers.js';

const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function rulescope(args: string[], env: Record<string, string> = {}): Result {
  try {
    const stdout = execFileSync(process.execPath, [tsx, cli, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr) };
  }
}

describe('cli', () => {
  it('accepts --depth 0 and rejects values that are not whole numbers', () => {
    const { home, project } = sandbox();
    tree(project, { 'CLAUDE.md': 'root', 'pkg/CLAUDE.md': 'nested' });
    const deep = JSON.parse(rulescope([project, '--home', home, '--json']).stdout) as {
      tools: { scopes: { level: string }[] }[];
    };
    expect(deep.tools[0]?.scopes.some((s) => s.level === 'subdirectory')).toBe(true);
    const flat = JSON.parse(
      rulescope([project, '--home', home, '--json', '--depth', '0']).stdout,
    ) as typeof deep;
    expect(flat.tools[0]?.scopes.some((s) => s.level === 'subdirectory')).toBe(false);
    for (const bad of ['abc', '-1', '1.5']) {
      const r = rulescope([project, '--home', home, '--depth', bad]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('--depth');
    }
  });

  it('rejects unknown tool ids', () => {
    const { home, project } = sandbox();
    const r = rulescope([project, '--home', home, '--tool', 'claude,bogus']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('bogus');
  });

  it.skipIf(process.platform === 'win32')(
    'explain matches a file reached through a symlinked directory',
    () => {
      const { root, home, project } = sandbox();
      tree(project, { 'CLAUDE.md': 'root' });
      const link = join(root, 'link');
      symlinkSync(project, link, 'dir');
      const r = rulescope(['explain', join(link, 'CLAUDE.md'), '-C', project, '--home', home]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Claude Code: active');
      const viaLinkDir = rulescope([
        'explain',
        join(project, 'CLAUDE.md'),
        '-C',
        link,
        '--home',
        home,
      ]);
      expect(viaLinkDir.status).toBe(0);
    },
  );

  it('explain honours --tool and --file', () => {
    const { home, project } = sandbox();
    tree(project, {
      'CLAUDE.md': 'root',
      '.claude/rules/py.md': '---\npaths: ["**/*.py"]\n---\npython',
      'src/app.py': '',
    });
    const rule = join(project, '.claude', 'rules', 'py.md');
    const idle = rulescope(['explain', rule, '-C', project, '--home', home, '--tool', 'claude']);
    expect(idle.stdout).toContain('Claude Code: conditional');
    expect(idle.stdout).not.toContain('Cursor');
    const working = rulescope([
      'explain',
      rule,
      '-C',
      project,
      '--home',
      home,
      '--tool',
      'claude',
      '--file',
      'src/app.py',
    ]);
    expect(working.stdout).toContain('Claude Code: active');
  });
});
