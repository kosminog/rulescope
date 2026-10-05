import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { byPath, entries, run, sandbox, tree } from './helpers.js';

function gitProject(project: string): void {
  mkdirSync(join(project, '.git'), { recursive: true });
}

describe('Codex resolver', () => {
  it('reads the global file, then the chain from repo root to cwd, and ignores nested files below cwd', () => {
    const { home, project } = sandbox();
    gitProject(project);
    tree(home, { '.codex/AGENTS.md': 'global' });
    tree(project, {
      'AGENTS.md': 'root',
      'packages/AGENTS.md': 'mid',
      'packages/api/AGENTS.md': 'leaf',
      'packages/api/sub/AGENTS.md': 'below',
    });
    const cwd = join(project, 'packages', 'api');
    const list = entries(run({ cwd, home }), 'codex');
    expect(byPath(list, '.codex/AGENTS.md').status).toBe('active');
    expect(byPath(list, 'project/AGENTS.md').status).toBe('active');
    expect(byPath(list, 'packages/AGENTS.md').status).toBe('active');
    expect(byPath(list, 'api/AGENTS.md').status).toBe('active');
    expect(byPath(list, 'api/AGENTS.md').reason).toContain('wins');
    expect(byPath(list, 'sub/AGENTS.md').status).toBe('inactive');
    // order in the report follows root -> cwd
    const order = list
      .filter((e) => e.kind === 'instructions' && e.path.includes('project'))
      .map((e) => e.path);
    expect(order.indexOf(byPath(list, 'project/AGENTS.md').path)).toBeLessThan(
      order.indexOf(byPath(list, 'api/AGENTS.md').path),
    );
  });

  it('prefers AGENTS.override.md, skips empty files and honours fallback names', () => {
    const { home, project } = sandbox();
    gitProject(project);
    tree(home, { '.codex/config.toml': 'project_doc_fallback_filenames = ["TEAM_GUIDE.md"]\n' });
    tree(project, {
      'AGENTS.override.md': 'override',
      'AGENTS.md': 'normal',
      'lib/AGENTS.md': '   \n',
      'lib/sub/TEAM_GUIDE.md': 'guide',
    });
    const list = entries(run({ cwd: join(project, 'lib', 'sub'), home }), 'codex');
    expect(byPath(list, 'AGENTS.override.md').status).toBe('active');
    expect(byPath(list, 'project/AGENTS.md').status).toBe('shadowed');
    expect(byPath(list, 'lib/AGENTS.md').status).toBe('inactive');
    expect(byPath(list, 'TEAM_GUIDE.md').status).toBe('active');
    expect(byPath(list, 'TEAM_GUIDE.md').tags).toContain('fallback-name');
  });

  it('truncates the chain at project_doc_max_bytes', () => {
    const { home, project } = sandbox();
    gitProject(project);
    tree(home, { '.codex/config.toml': 'project_doc_max_bytes = 100\n' });
    tree(project, {
      'AGENTS.md': 'a'.repeat(80),
      'x/AGENTS.md': 'b'.repeat(50),
      'x/y/AGENTS.md': 'c'.repeat(10),
    });
    const report = run({ cwd: join(project, 'x', 'y'), home });
    const list = entries(report, 'codex');
    expect(byPath(list, 'project/AGENTS.md').status).toBe('active');
    expect(byPath(list, 'x/AGENTS.md').status).toBe('truncated');
    expect(byPath(list, 'x/AGENTS.md').reason).toContain('first 20 B');
    expect(byPath(list, 'y/AGENTS.md').status).toBe('truncated');
    expect(report.tools.find((t) => t.tool === 'codex')?.notes.join(' ')).toContain('exceeds');
  });

  it('gates project config on trust and disables skills via skills.config', () => {
    const { home, project } = sandbox();
    gitProject(project);
    tree(project, {
      '.codex/config.toml': 'model = "x"\n',
      '.agents/skills/a/SKILL.md': '---\nname: a\ndescription: a\n---\n',
      '.agents/skills/b/SKILL.md': '---\nname: b\ndescription: b\n---\n',
    });
    tree(home, {
      '.codex/config.toml': `[[skills.config]]\npath = "${join(project, '.agents/skills/b')}"\nenabled = false\n`,
    });
    const gated = entries(run({ cwd: project, home }), 'codex');
    expect(byPath(gated, 'project/.codex/config.toml').status).toBe('trust-gated');
    expect(byPath(gated, 'a/SKILL.md').status).toBe('on-demand');
    expect(byPath(gated, 'b/SKILL.md').status).toBe('inactive');
    expect(
      byPath(
        entries(run({ cwd: project, home, trusted: true }), 'codex'),
        'project/.codex/config.toml',
      ).status,
    ).toBe('active');
    tree(home, { '.codex/config.toml': `[projects."${project}"]\ntrust_level = "trusted"\n` });
    expect(
      byPath(entries(run({ cwd: project, home }), 'codex'), 'project/.codex/config.toml').status,
    ).toBe('active');
  });

  it('discovers user skills in ~/.agents/skills and legacy ~/.codex/skills, flagging duplicates', () => {
    const { home, project } = sandbox();
    tree(home, {
      '.agents/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: d\n---\n',
      '.codex/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: d\n---\n',
      '.codex/prompts/fix.md': 'prompt',
    });
    const report = run({ cwd: project, home });
    const list = entries(report, 'codex');
    expect(list.filter((e) => e.kind === 'skill' && e.name === 'deploy')).toHaveLength(2);
    expect(byPath(list, '.codex/skills/deploy/SKILL.md').tags).toContain('legacy');
    expect(byPath(list, 'prompts/fix.md').status).toBe('manual');
    expect(report.tools.find((t) => t.tool === 'codex')?.notes.join(' ')).toContain('deploy');
  });

  it('honours CODEX_HOME and a selected profile file', () => {
    const { root, home, project } = sandbox();
    const codexHome = join(root, 'codex-home');
    tree(codexHome, {
      'AGENTS.md': 'alt',
      'config.toml': 'profile = "fast"\n',
      'fast.config.toml': 'model = "fast"\n',
    });
    tree(home, { '.codex/AGENTS.md': 'ignored' });
    const list = entries(run({ cwd: project, home, env: { CODEX_HOME: codexHome } }), 'codex');
    expect(byPath(list, 'codex-home/AGENTS.md').status).toBe('active');
    expect(list.some((e) => e.path.endsWith('home/.codex/AGENTS.md'))).toBe(false);
    expect(byPath(list, 'fast.config.toml').status).toBe('active');
  });
});
