import { describe, expect, it } from 'vitest';
import { renderHtml, renderTerminal } from '../src/index.js';
import { run, sandbox, slash, tree } from './helpers.js';

describe('report assembly and renderers', () => {
  it('computes overlap for files read by more than one tool', () => {
    const { home, project } = sandbox();
    tree(project, {
      'AGENTS.md': 'shared',
      '.claude/skills/x/SKILL.md': '---\nname: x\ndescription: x\n---\n',
    });
    const report = run({ cwd: project, home });
    const paths = report.overlap.map((o) => slash(o.displayPath));
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('.claude/skills/x/SKILL.md');
    const agents = report.overlap.find((o) => slash(o.displayPath) === 'AGENTS.md');
    expect(agents?.tools.map((t) => t.tool).sort()).toEqual(['codex', 'cursor']);
  });

  it('limits the report to the requested tools', () => {
    const { home, project } = sandbox();
    const report = run({ cwd: project, home, tools: ['cursor'] });
    expect(report.tools.map((t) => t.tool)).toEqual(['cursor']);
  });

  it('renders a terminal tree without color codes when disabled', () => {
    const { home, project } = sandbox();
    tree(project, { 'CLAUDE.md': 'hi' });
    const text = renderTerminal(run({ cwd: project, home }), { color: false });
    expect(text).toContain('Claude Code');
    expect(text).toContain('[active] instructions CLAUDE.md');
    expect(text).not.toMatch(/\u001b\[/);
  });

  it('renders self-contained HTML with escaped embedded data', () => {
    const { home, project } = sandbox();
    tree(project, {
      'CLAUDE.md': 'contains </script><img src=x onerror=alert(1)> and <!-- comment -->',
    });
    const html = renderHtml(run({ cwd: project, home }));
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
    expect(html).not.toContain('<!-- comment -->');
    expect(html).not.toMatch(/<script src=/);
    expect(html).not.toMatch(/<link /);
  });

  it('omits content when includeContent is false', () => {
    const { home, project } = sandbox();
    tree(project, { 'CLAUDE.md': 'secret body' });
    const report = run({ cwd: project, home, includeContent: false });
    const json = JSON.stringify(report);
    expect(json).not.toContain('secret body');
  });
});
