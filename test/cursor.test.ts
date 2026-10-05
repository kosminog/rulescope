import { describe, expect, it } from 'vitest';
import { byPath, entries, run, sandbox, tree } from './helpers.js';

describe('Cursor resolver', () => {
  it('classifies the four rule types and ignores plain .md without frontmatter', () => {
    const { home, project } = sandbox();
    tree(project, {
      '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nalways',
      '.cursor/rules/ts.mdc': '---\nglobs: ["src/**/*.ts"]\n---\nts',
      '.cursor/rules/smart.mdc': '---\ndescription: use for api work\n---\napi',
      '.cursor/rules/manual.mdc': 'manual only',
      '.cursor/rules/plain.md': 'ignored',
      '.cursor/rules/withfm.md': '---\nalwaysApply: true\n---\nok',
      'src/a.ts': '',
    });
    const list = entries(run({ cwd: project, home }), 'cursor');
    expect(byPath(list, 'always.mdc').status).toBe('active');
    expect(byPath(list, 'ts.mdc').status).toBe('conditional');
    expect(byPath(list, 'smart.mdc').status).toBe('on-demand');
    expect(byPath(list, 'manual.mdc').status).toBe('manual');
    expect(byPath(list, 'plain.md').status).toBe('inactive');
    expect(byPath(list, 'withfm.md').status).toBe('active');
    const withFile = entries(run({ cwd: project, home, targetFile: 'src/a.ts' }), 'cursor');
    expect(byPath(withFile, 'ts.mdc').status).toBe('active');
  });

  it('applies root AGENTS.md, nested AGENTS.md on demand, legacy .cursorrules, and flags CLAUDE.md', () => {
    const { home, project } = sandbox();
    tree(project, {
      'AGENTS.md': 'root',
      'CLAUDE.md': 'claude',
      '.cursorrules': 'legacy',
      'app/AGENTS.md': 'nested',
      'app/x.ts': '',
    });
    const list = entries(run({ cwd: project, home }), 'cursor');
    expect(byPath(list, 'project/AGENTS.md').status).toBe('active');
    expect(byPath(list, 'CLAUDE.md').status).toBe('unknown');
    expect(byPath(list, '.cursorrules').tags).toContain('legacy');
    expect(byPath(list, 'app/AGENTS.md').status).toBe('on-demand');
    expect(
      byPath(
        entries(run({ cwd: project, home, targetFile: 'app/x.ts' }), 'cursor'),
        'app/AGENTS.md',
      ).status,
    ).toBe('active');
  });

  it('loads skills from native, shared and compat directories and marks manual ones', () => {
    const { home, project } = sandbox();
    tree(project, {
      '.cursor/skills/a/SKILL.md': '---\nname: a\ndescription: a\n---\n',
      '.agents/skills/b/SKILL.md': '---\nname: b\ndescription: b\n---\n',
      '.claude/skills/c/SKILL.md':
        '---\nname: c\ndescription: c\ndisable-model-invocation: true\n---\n',
      '.codex/skills/d/SKILL.md': '---\nname: d\ndescription: d\npaths: ["*.go"]\n---\n',
    });
    tree(home, { '.claude/skills/e/SKILL.md': '---\nname: e\ndescription: e\n---\n' });
    const list = entries(run({ cwd: project, home }), 'cursor');
    expect(byPath(list, 'a/SKILL.md').status).toBe('on-demand');
    expect(byPath(list, 'b/SKILL.md').status).toBe('on-demand');
    expect(byPath(list, 'c/SKILL.md').status).toBe('manual');
    expect(byPath(list, 'c/SKILL.md').tags).toContain('compat');
    expect(byPath(list, 'd/SKILL.md').status).toBe('conditional');
    expect(byPath(list, 'e/SKILL.md').tags).toContain('compat');
  });

  it('prefers .cursor/agents over compat agent directories and reads hooks and commands', () => {
    const { home, project } = sandbox();
    tree(project, {
      '.cursor/agents/reviewer.md': '---\nname: reviewer\n---\n',
      '.claude/agents/reviewer.md': '---\nname: reviewer\n---\n',
      '.claude/agents/other.md': '---\nname: other\n---\n',
      '.cursor/hooks.json': '{"hooks":{"beforeShellExecution":[]}}',
      '.cursor/commands/ship.md': 'ship it',
      '.cursorignore': 'secrets/',
    });
    const list = entries(run({ cwd: project, home }), 'cursor');
    expect(byPath(list, '.cursor/agents/reviewer.md').status).toBe('on-demand');
    expect(byPath(list, '.claude/agents/reviewer.md').status).toBe('shadowed');
    expect(byPath(list, 'agents/other.md').status).toBe('on-demand');
    expect(byPath(list, 'hooks.json').description).toContain('beforeShellExecution');
    expect(byPath(list, 'ship.md').status).toBe('manual');
    expect(byPath(list, '.cursorignore').kind).toBe('settings');
  });
});
