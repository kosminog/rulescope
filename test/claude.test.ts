import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { byPath, entries, run, sandbox, slash, statuses, tree } from './helpers.js';

describe('Claude Code resolver', () => {
  it('loads user, ancestor and project memory and follows @imports', () => {
    const { home, project } = sandbox();
    tree(home, {
      '.claude/CLAUDE.md': 'Global rules\n@~/shared/style.md\n',
      'shared/style.md': 'style',
      'work/CLAUDE.md': 'workspace-wide',
    });
    tree(project, {
      'CLAUDE.md': 'project\n@docs/extra.md\n@missing.md\n',
      'docs/extra.md': 'extra',
      'CLAUDE.local.md': 'local',
    });
    const list = entries(run({ cwd: project, home }), 'claude');
    expect(byPath(list, '.claude/CLAUDE.md').status).toBe('active');
    expect(byPath(list, 'shared/style.md').status).toBe('active');
    expect(byPath(list, 'work/CLAUDE.md').status).toBe('active');
    expect(byPath(list, 'project/CLAUDE.md').status).toBe('active');
    expect(byPath(list, 'docs/extra.md').status).toBe('active');
    expect(byPath(list, 'docs/extra.md').kind).toBe('import');
    expect(byPath(list, 'missing.md').status).toBe('inactive');
    expect(byPath(list, 'CLAUDE.local.md').status).toBe('active');
    // the user memory file is not listed a second time as an ancestor
    expect(statuses(list, '.claude/CLAUDE.md')).toHaveLength(1);
  });

  it('ignores @ tokens inside code and stops at the import depth limit', () => {
    const { home, project } = sandbox();
    tree(project, {
      'CLAUDE.md': 'see `@notes.md` and\n```\n@fenced.md\n```\n@a.md\n',
      'notes.md': 'x',
      'fenced.md': 'x',
      'a.md': '@b.md',
      'b.md': '@c.md',
      'c.md': '@d.md',
      'd.md': '@e.md',
      'e.md': '@f.md',
      'f.md': '@g.md',
      'g.md': 'deep',
    });
    const list = entries(run({ cwd: project, home }), 'claude');
    expect(list.some((e) => slash(e.path).endsWith('notes.md'))).toBe(false);
    expect(list.some((e) => e.path.endsWith('fenced.md'))).toBe(false);
    expect(byPath(list, '/e.md').status).toBe('active');
    expect(byPath(list, '/f.md').status).toBe('inactive');
    expect(byPath(list, '/f.md').reason).toContain('hop');
  });

  it('marks path-scoped rules conditional and resolves them against --file', () => {
    const { home, project } = sandbox();
    tree(project, {
      '.claude/rules/general.md': 'always',
      '.claude/rules/py.md': '---\npaths:\n  - "**/*.py"\n---\npython',
      'src/app.py': '',
    });
    tree(home, { '.claude/rules/shell.md': '---\npaths: "*.sh"\n---\nshell' });
    const without = entries(run({ cwd: project, home }), 'claude');
    expect(byPath(without, 'general.md').status).toBe('active');
    expect(byPath(without, 'py.md').status).toBe('conditional');
    expect(byPath(without, 'shell.md').status).toBe('conditional');
    const withFile = entries(run({ cwd: project, home, targetFile: 'src/app.py' }), 'claude');
    expect(byPath(withFile, 'py.md').status).toBe('active');
    expect(byPath(withFile, 'py.md').matchesTarget).toBe(true);
    expect(byPath(withFile, 'shell.md').status).toBe('conditional');
  });

  it('applies skill precedence, skillOverrides and command shadowing', () => {
    const { home, project } = sandbox();
    tree(home, {
      '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: user deploy\n---\n',
    });
    tree(project, {
      '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: project deploy\n---\n',
      '.claude/skills/hidden/SKILL.md': '---\nname: hidden\ndescription: hidden\n---\n',
      '.claude/skills/manual/SKILL.md':
        '---\nname: manual\ndescription: m\ndisable-model-invocation: true\n---\n',
      '.claude/commands/deploy.md': 'old command',
      '.claude/commands/other.md': 'other command',
      '.claude/settings.local.json': '{"skillOverrides":{"hidden":"off"}}',
    });
    const list = entries(run({ cwd: project, home }), 'claude');
    const skills = list.filter((e) => e.kind === 'skill');
    expect(skills.find((e) => slash(e.path).includes('home/.claude/skills/deploy'))?.status).toBe(
      'on-demand',
    );
    expect(
      skills.find((e) => slash(e.path).includes('project/.claude/skills/deploy'))?.status,
    ).toBe('shadowed');
    expect(byPath(list, 'hidden/SKILL.md').status).toBe('inactive');
    expect(byPath(list, 'manual/SKILL.md').status).toBe('manual');
    expect(byPath(list, 'commands/deploy.md').status).toBe('shadowed');
    expect(byPath(list, 'commands/other.md').status).toBe('manual');
  });

  it('treats subdirectory memory as on-demand unless the target file is inside it', () => {
    const { home, project } = sandbox();
    tree(project, {
      'CLAUDE.md': 'root',
      'packages/api/CLAUDE.md': 'api',
      'packages/api/src/index.ts': '',
    });
    const idle = entries(run({ cwd: project, home }), 'claude');
    expect(byPath(idle, 'packages/api/CLAUDE.md').status).toBe('on-demand');
    const working = entries(
      run({ cwd: project, home, targetFile: 'packages/api/src/index.ts' }),
      'claude',
    );
    expect(byPath(working, 'packages/api/CLAUDE.md').status).toBe('active');
  });

  it('honours claudeMdExcludes and reports settings layers with hooks', () => {
    const { home, project } = sandbox();
    tree(project, {
      'CLAUDE.md': 'root',
      'vendor/CLAUDE.md': 'vendored',
      '.claude/settings.json': '{"claudeMdExcludes":["vendor/**"],"hooks":{"PreToolUse":[]}}',
    });
    const list = entries(run({ cwd: project, home }), 'claude');
    expect(byPath(list, 'vendor/CLAUDE.md').status).toBe('inactive');
    const settings = byPath(list, '.claude/settings.json');
    expect(settings.status).toBe('trust-gated');
    expect(list.find((e) => e.kind === 'hooks')?.description).toContain('PreToolUse');
    const trusted = entries(run({ cwd: project, home, trusted: true }), 'claude');
    expect(byPath(trusted, '.claude/settings.json').status).toBe('active');
  });

  it('gates --add-dir memory on the environment flag but always loads its skills', () => {
    const { root, home, project } = sandbox();
    const shared = join(root, 'shared');
    mkdirSync(shared, { recursive: true });
    tree(shared, {
      'CLAUDE.md': 'shared',
      '.claude/skills/s/SKILL.md': '---\nname: s\ndescription: d\n---\n',
    });
    const off = entries(run({ cwd: project, home, addDirs: [shared] }), 'claude');
    expect(byPath(off, 'shared/CLAUDE.md').status).toBe('inactive');
    expect(byPath(off, 's/SKILL.md').status).toBe('on-demand');
    const on = entries(
      run({
        cwd: project,
        home,
        addDirs: [shared],
        env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
      }),
      'claude',
    );
    expect(byPath(on, 'shared/CLAUDE.md').status).toBe('active');
  });

  it('finds auto memory by the inferred project path and flags oversize files', () => {
    const { home, project } = sandbox();
    const encoded = project.replace(/[^A-Za-z0-9]/g, '-');
    tree(home, { [`.claude/projects/${encoded}/memory/MEMORY.md`]: 'index' });
    const list = entries(run({ cwd: project, home }), 'claude');
    const mem = byPath(list, 'memory/MEMORY.md');
    expect(mem.status).toBe('active');
    expect(mem.tags).toContain('inferred-path');
    tree(home, { [`.claude/projects/${encoded}/memory/MEMORY.md`]: 'x\n'.repeat(300) });
    expect(byPath(entries(run({ cwd: project, home }), 'claude'), 'memory/MEMORY.md').status).toBe(
      'truncated',
    );
  });

  it('respects CLAUDE_CONFIG_DIR and resolves plugins from a marketplace', () => {
    const { root, home, project } = sandbox();
    const cfg = join(root, 'cfg');
    tree(cfg, {
      'CLAUDE.md': 'alt config',
      'settings.json': '{"enabledPlugins":{"tools@mk":true,"ghost@mk":true}}',
      'plugins/known_marketplaces.json': JSON.stringify({
        mk: { installLocation: join(cfg, 'plugins/marketplaces/mk') },
      }),
      'plugins/marketplaces/mk/.claude-plugin/marketplace.json': JSON.stringify({
        name: 'mk',
        plugins: [{ name: 'tools', source: './plugins/tools' }],
      }),
      'plugins/marketplaces/mk/plugins/tools/skills/lint/SKILL.md':
        '---\nname: lint\ndescription: lint\n---\n',
      'plugins/marketplaces/mk/plugins/tools/agents/reviewer.md':
        '---\nname: reviewer\ndescription: r\n---\n',
      'plugins/marketplaces/mk/plugins/tools/hooks/hooks.json': '{"hooks":{"Stop":[]}}',
    });
    tree(home, { '.claude/CLAUDE.md': 'should be ignored' });
    const report = run({ cwd: project, home, env: { CLAUDE_CONFIG_DIR: cfg } });
    const list = entries(report, 'claude');
    expect(byPath(list, 'cfg/CLAUDE.md').status).toBe('active');
    const userScope = report.tools[0]?.scopes.find((s) => s.level === 'user');
    expect(userScope?.dir).toBe(cfg);
    expect(byPath(list, 'lint/SKILL.md').status).toBe('on-demand');
    expect(byPath(list, 'agents/reviewer.md').status).toBe('on-demand');
    expect(byPath(list, 'hooks/hooks.json').description).toContain('Stop');
    const ghost = list.find((e) => e.name === 'ghost@mk');
    expect(ghost?.status).toBe('inactive');
  });

  it('lists project MCP servers and applies settings approvals', () => {
    const { home, project } = sandbox();
    tree(project, { '.mcp.json': '{"mcpServers":{"db":{"command":"x"}}}' });
    const gated = byPath(entries(run({ cwd: project, home }), 'claude'), '.mcp.json');
    expect(gated.status).toBe('trust-gated');
    expect(gated.description).toContain('db');
    tree(project, { '.claude/settings.local.json': '{"enabledMcpjsonServers":["db"]}' });
    expect(byPath(entries(run({ cwd: project, home }), 'claude'), '.mcp.json').status).toBe(
      'active',
    );
  });
});
