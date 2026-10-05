import { basename, dirname, join } from 'node:path';
import type { ResolveContext } from '../context.js';
import { DOCS } from '../docs.js';
import { findSkillFiles, loadFile, makeEntry, makeScope } from '../entry.js';
import { asBoolean, asStringList } from '../frontmatter.js';
import { findFiles, isDir, isFile, isInside, listDir, readJson, walkDown } from '../fs.js';
import { matchesAnyGlob } from '../glob.js';
import type { Entry, Scope, Status, ToolReport } from '../model.js';

const TOOL = 'cursor' as const;

/**
 * Cursor treats the opened folder as the workspace root. rulescope treats the
 * evaluated directory as that folder.
 */
export function resolveCursor(ctx: ResolveContext): ToolReport {
  const root = ctx.cwd;
  const userDir = join(ctx.home, '.cursor');
  const scopes: Scope[] = [];
  const notes: string[] = [];

  // ---- system hooks ----
  const systemHooks =
    ctx.platform === 'darwin'
      ? '/Library/Application Support/Cursor/hooks.json'
      : ctx.platform === 'win32'
        ? 'C:\\ProgramData\\Cursor\\hooks.json'
        : '/etc/cursor/hooks.json';
  const system = makeScope(ctx, TOOL, 'system', 'System hooks', dirname(systemHooks));
  if (isFile(systemHooks))
    system.entries.push(hooksEntry(ctx, systemHooks, 'system-wide hooks apply to every workspace'));
  if (system.entries.length) scopes.push(system);

  // ---- user ----
  const user = makeScope(ctx, TOOL, 'user', 'User (~/.cursor and shared skill dirs)', userDir);
  for (const dir of [join(userDir, 'skills'), join(ctx.home, '.agents', 'skills')]) {
    user.entries.push(...skillEntries(ctx, dir, root, []));
  }
  for (const dir of [join(ctx.home, '.claude', 'skills'), join(ctx.home, '.codex', 'skills')]) {
    user.entries.push(...skillEntries(ctx, dir, root, ['compat']));
  }
  user.entries.push(...commandEntries(ctx, join(userDir, 'commands')));
  user.entries.push(...agentEntries(ctx, join(userDir, 'agents'), []));
  if (isFile(join(userDir, 'hooks.json')))
    user.entries.push(
      hooksEntry(
        ctx,
        join(userDir, 'hooks.json'),
        'user hooks run from ~/.cursor; not available to cloud agents',
      ),
    );
  if (isFile(join(userDir, 'mcp.json')))
    user.entries.push(mcpEntry(ctx, join(userDir, 'mcp.json')));
  if (user.entries.length) scopes.push(user);

  // ---- project ----
  const project = makeScope(ctx, TOOL, 'project', 'Workspace root', root);

  // Instruction files
  const agentsMd = join(root, 'AGENTS.md');
  if (isFile(agentsMd)) {
    project.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'instructions',
        path: agentsMd,
        status: 'active',
        reason: 'AGENTS.md at the workspace root is always applied',
        docUrl: DOCS.cursor.rules,
      }),
    );
  }
  const claudeMd = join(root, 'CLAUDE.md');
  if (isFile(claudeMd)) {
    project.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'instructions',
        path: claudeMd,
        status: 'unknown',
        reason:
          'earlier Cursor docs listed root CLAUDE.md as a rule source; the current rules page only names AGENTS.md',
        docUrl: DOCS.cursor.rules,
        tags: ['compat'],
      }),
    );
  }
  const legacy = join(root, '.cursorrules');
  if (isFile(legacy)) {
    project.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'instructions',
        path: legacy,
        status: 'active',
        reason:
          'legacy .cursorrules is still honoured but scheduled for removal; migrate to .cursor/rules',
        docUrl: DOCS.cursor.rules,
        tags: ['legacy'],
      }),
    );
  }

  // Rules
  project.entries.push(...ruleEntries(ctx, join(root, '.cursor', 'rules'), root, root, []));

  // Skills: native, shared, and compat directories
  for (const dir of [join(root, '.cursor', 'skills'), join(root, '.agents', 'skills')]) {
    project.entries.push(...skillEntries(ctx, dir, root, []));
  }
  for (const dir of [join(root, '.claude', 'skills'), join(root, '.codex', 'skills')]) {
    project.entries.push(...skillEntries(ctx, dir, root, ['compat']));
  }

  project.entries.push(...commandEntries(ctx, join(root, '.cursor', 'commands')));

  // Subagents: .cursor wins over compat dirs on name conflicts
  const nativeAgents = agentEntries(ctx, join(root, '.cursor', 'agents'), []);
  const nativeNames = new Set(nativeAgents.map((e) => e.name));
  project.entries.push(...nativeAgents);
  for (const dir of [join(root, '.claude', 'agents'), join(root, '.codex', 'agents')]) {
    for (const entry of agentEntries(ctx, dir, ['compat'])) {
      if (entry.name && nativeNames.has(entry.name)) {
        entry.status = 'shadowed';
        entry.reason = `a .cursor/agents subagent named "${entry.name}" takes precedence`;
      }
      project.entries.push(entry);
    }
  }

  if (isFile(join(root, '.cursor', 'hooks.json')))
    project.entries.push(
      hooksEntry(
        ctx,
        join(root, '.cursor', 'hooks.json'),
        'project hooks run from the workspace root',
      ),
    );
  if (isFile(join(root, '.cursor', 'mcp.json')))
    project.entries.push(mcpEntry(ctx, join(root, '.cursor', 'mcp.json')));
  for (const ignore of ['.cursorignore', '.cursorindexingignore']) {
    const p = join(root, ignore);
    if (isFile(p)) {
      project.entries.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'settings',
          path: p,
          status: 'active',
          reason:
            ignore === '.cursorignore'
              ? 'files listed here are hidden from the agent and from indexing'
              : 'files listed here are excluded from indexing only',
          docUrl: DOCS.cursor.rules,
        }),
      );
    }
  }
  scopes.push(project);

  // ---- subdirectories ----
  const sub = makeScope(
    ctx,
    TOOL,
    'subdirectory',
    'Subdirectories (applied when working there)',
    root,
  );
  walkDown(root, ctx.subdirDepth, (dir) => {
    if (dir === root) return;
    const nested = join(dir, 'AGENTS.md');
    if (isFile(nested)) {
      const hit = ctx.target !== null && isInside(dir, ctx.target);
      sub.entries.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'instructions',
          path: nested,
          status: hit ? 'active' : 'on-demand',
          reason: hit
            ? 'the target file is inside this directory'
            : 'nested AGENTS.md applies when working with files in this directory or its children; more specific instructions take precedence',
          docUrl: DOCS.cursor.rules,
          matchesTarget: hit,
        }),
      );
    }
    const nestedRules = join(dir, '.cursor', 'rules');
    if (isDir(nestedRules)) {
      for (const entry of ruleEntries(ctx, nestedRules, root, dir, ['unverified'])) {
        if (entry.status === 'active') {
          entry.status =
            ctx.target !== null && isInside(dir, ctx.target) ? 'active' : 'conditional';
          entry.reason =
            'nested .cursor/rules were documented as scoped to their subtree; the current docs no longer mention them';
        }
        sub.entries.push(entry);
      }
    }
  });
  if (sub.entries.length) scopes.push(sub);

  if (!isDir(join(root, '.cursor')) && !isFile(agentsMd) && !isFile(legacy)) {
    notes.push('No Cursor configuration found at the workspace root.');
  }

  return {
    tool: TOOL,
    label: 'Cursor',
    scopes,
    notes,
    blindSpots: [
      'User Rules (Cursor Settings → Rules) are stored inside the app, not on disk.',
      'Team Rules are served from the Cursor dashboard for Team and Enterprise plans and apply before project rules.',
      'Cloud Agents only sync ~/.cursor/skills; other user-level files are not available to them.',
    ],
  };
}

function ruleEntries(
  ctx: ResolveContext,
  rulesDir: string,
  root: string,
  scopeDir: string,
  tags: string[],
): Entry[] {
  if (!isDir(rulesDir)) return [];
  const files = findFiles(rulesDir, (n) => n.endsWith('.mdc') || n.endsWith('.md'));
  const out: Entry[] = [];
  for (const path of files) {
    const loaded = loadFile(path);
    if (!loaded) continue;
    const fm = loaded.frontmatter;
    const isMdc = path.endsWith('.mdc');
    if (!fm && !isMdc) {
      out.push(
        makeEntry(
          ctx,
          {
            tool: TOOL,
            kind: 'rule',
            path,
            status: 'inactive',
            reason: 'plain .md files in .cursor/rules are ignored unless they carry frontmatter',
            docUrl: DOCS.cursor.rules,
            tags,
          },
          loaded,
        ),
      );
      continue;
    }
    const globs = asStringList(fm?.globs);
    const always = asBoolean(fm?.alwaysApply) === true;
    const description = typeof fm?.description === 'string' ? fm.description.trim() : '';
    let status: Status;
    let reason: string;
    let matchesTarget: boolean | undefined;
    if (always) {
      status = 'active';
      reason = 'alwaysApply: true — included in every chat session';
    } else if (globs.length) {
      matchesTarget =
        ctx.target !== null &&
        isInside(scopeDir, ctx.target) &&
        matchesAnyGlob(globs, ctx.target, root);
      status = matchesTarget ? 'active' : 'conditional';
      reason = matchesTarget
        ? `auto-attached: the target file matches ${globs.join(', ')}`
        : `auto-attached when a referenced file matches ${globs.join(', ')}`;
    } else if (description) {
      status = 'on-demand';
      reason = 'agent-requested: the agent decides from the description whether to include it';
    } else {
      status = 'manual';
      reason = 'no frontmatter triggers; only included when @-mentioned';
    }
    out.push(
      makeEntry(
        ctx,
        {
          tool: TOOL,
          kind: 'rule',
          path,
          status,
          reason,
          docUrl: DOCS.cursor.rules,
          tags,
          globs,
          ...(matchesTarget !== undefined ? { matchesTarget } : {}),
        },
        loaded,
      ),
    );
  }
  return out;
}

function skillEntries(ctx: ResolveContext, dir: string, root: string, tags: string[]): Entry[] {
  const out: Entry[] = [];
  for (const path of findSkillFiles(dir)) {
    const loaded = loadFile(path);
    if (!loaded) continue;
    const fm = loaded.frontmatter ?? {};
    const name = typeof fm.name === 'string' ? fm.name : basename(dirname(path));
    const paths = asStringList(fm.paths);
    const manual = asBoolean(fm['disable-model-invocation']) === true;
    let status: Status = 'on-demand';
    let reason =
      'name and description are shown to the agent; the body loads when the agent or user invokes it';
    let matchesTarget: boolean | undefined;
    if (manual) {
      status = 'manual';
      reason = 'disable-model-invocation: true — only the user can invoke it with /';
    } else if (paths.length) {
      matchesTarget = ctx.target !== null && matchesAnyGlob(paths, ctx.target, root);
      status = matchesTarget ? 'active' : 'conditional';
      reason = matchesTarget
        ? `paths match the target file (${paths.join(', ')})`
        : `scoped to files matching ${paths.join(', ')}`;
    }
    const entryTags = [...tags];
    if (tags.includes('compat'))
      reason += "; loaded from another tool's directory for compatibility";
    out.push(
      makeEntry(
        ctx,
        {
          tool: TOOL,
          kind: 'skill',
          path,
          status,
          reason,
          docUrl: DOCS.cursor.skills,
          name,
          tags: entryTags,
          globs: paths,
          ...(matchesTarget !== undefined ? { matchesTarget } : {}),
        },
        loaded,
      ),
    );
  }
  return out;
}

function commandEntries(ctx: ResolveContext, dir: string): Entry[] {
  if (!isDir(dir)) return [];
  return listDir(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) =>
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'command',
        path: join(dir, n),
        status: 'manual',
        reason: 'commands run only when the user types / and selects them',
        docUrl: DOCS.cursor.skills,
        name: n.replace(/\.md$/, ''),
      }),
    );
}

function agentEntries(ctx: ResolveContext, dir: string, tags: string[]): Entry[] {
  if (!isDir(dir)) return [];
  return findFiles(dir, (n) => n.endsWith('.md')).map((path) => {
    const loaded = loadFile(path);
    const fmName = loaded?.frontmatter?.name;
    const name = typeof fmName === 'string' ? fmName : basename(path, '.md');
    return makeEntry(
      ctx,
      {
        tool: TOOL,
        kind: 'agent',
        path,
        status: 'on-demand',
        reason: 'subagent definition is listed to the agent and loaded when delegated to',
        docUrl: DOCS.cursor.subagents,
        name,
        tags,
      },
      loaded,
    );
  });
}

function hooksEntry(ctx: ResolveContext, path: string, reason: string): Entry {
  const json = readJson(path);
  const hooks = json?.hooks;
  const events = hooks && typeof hooks === 'object' ? Object.keys(hooks as object) : [];
  return makeEntry(ctx, {
    tool: TOOL,
    kind: 'hooks',
    path,
    status: 'active',
    reason,
    docUrl: DOCS.cursor.hooks,
    description: events.length ? `events: ${events.join(', ')}` : 'no events defined',
  });
}

function mcpEntry(ctx: ResolveContext, path: string): Entry {
  const json = readJson(path);
  const servers =
    json?.mcpServers && typeof json.mcpServers === 'object'
      ? Object.keys(json.mcpServers as object)
      : [];
  return makeEntry(ctx, {
    tool: TOOL,
    kind: 'mcp',
    path,
    status: 'active',
    reason: 'MCP servers add tools the agent can call',
    description: servers.length ? `servers: ${servers.join(', ')}` : 'no servers defined',
  });
}
