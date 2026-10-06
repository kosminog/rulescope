import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ResolveContext } from '../context.js';
import { DOCS } from '../docs.js';
import { findSkillFiles, loadFile, makeEntry, makeScope, type LoadedFile } from '../entry.js';
import { asBoolean, asStringList } from '../frontmatter.js';
import {
  chainFromRoot,
  findFiles,
  isDir,
  isFile,
  isInside,
  listDir,
  readJson,
  readText,
  statPath,
  walkDown,
} from '../fs.js';
import { matchesAnyGlob } from '../glob.js';
import type { Entry, Scope, ScopeLevel, Status, ToolReport } from '../model.js';

const TOOL = 'claude' as const;
const MAX_IMPORT_DEPTH = 5;
const AUTO_MEMORY_MAX_LINES = 200;
const AUTO_MEMORY_MAX_BYTES = 25 * 1024;

type Json = Record<string, unknown>;

interface SettingsLayer {
  label: string;
  path: string;
  level: ScopeLevel;
  json: Json | null;
  status: Status;
  reason: string;
}

interface MergedSettings {
  layers: SettingsLayer[];
  claudeMdExcludes: string[];
  skillOverrides: Record<string, unknown>;
  enabledPlugins: string[];
  outputStyle: string | null;
  autoMemoryEnabled: boolean | null;
  model: string | null;
  hookEvents: Map<string, string[]>;
  enabledMcpjsonServers: string[];
  disableAllMcpjsonServers: boolean;
}

export function resolveClaude(ctx: ResolveContext): ToolReport {
  const configDir = ctx.env.CLAUDE_CONFIG_DIR
    ? resolve(ctx.env.CLAUDE_CONFIG_DIR)
    : join(ctx.home, '.claude');
  const managedDir = managedDirFor(ctx.platform);
  const settings = mergeSettings(ctx, configDir, managedDir);
  const scopes: Scope[] = [];
  const notes: string[] = [];
  const skillNames = new Set<string>();
  const agentNames = new Set<string>();

  if (ctx.env.CLAUDE_CONFIG_DIR)
    notes.push(`CLAUDE_CONFIG_DIR is set; using ${configDir} instead of ~/.claude.`);

  // ---- managed ----
  const managed = makeScope(ctx, TOOL, 'managed', `Managed policy (${managedDir})`, managedDir);
  const managedMd = join(managedDir, 'CLAUDE.md');
  if (isFile(managedMd))
    managed.entries.push(
      instructionEntry(
        ctx,
        managedMd,
        'active',
        'organization-wide instructions are loaded first',
        settings,
        configDir,
      ),
    );
  for (const layer of settings.layers.filter((l) => l.level === 'managed'))
    managed.entries.push(settingsEntry(ctx, layer, settings));
  managed.entries.push(
    ...skillEntries(
      ctx,
      join(managedDir, 'skills'),
      'enterprise skills take precedence over every other scope',
      settings,
      skillNames,
      ctx.cwd,
    ),
  );
  if (managed.entries.length) scopes.push(managed);

  // ---- user ----
  const user = makeScope(ctx, TOOL, 'user', `User (${ctx.display(configDir)})`, configDir);
  const userMd = join(configDir, 'CLAUDE.md');
  if (isFile(userMd))
    user.entries.push(
      instructionEntry(
        ctx,
        userMd,
        'active',
        'user memory applies to every project',
        settings,
        configDir,
      ),
    );
  user.entries.push(
    ...ruleEntries(ctx, join(configDir, 'rules'), ctx.cwd, 'user rules apply to every project'),
  );
  user.entries.push(
    ...skillEntries(
      ctx,
      join(configDir, 'skills'),
      'personal skills apply to every project',
      settings,
      skillNames,
      ctx.cwd,
    ),
  );
  user.entries.push(...commandEntries(ctx, join(configDir, 'commands'), skillNames));
  for (const layer of settings.layers.filter((l) => l.level === 'user'))
    user.entries.push(settingsEntry(ctx, layer, settings));
  user.entries.push(...outputStyleEntries(ctx, settings, [join(configDir, 'output-styles')]));
  const userClaudeJson = join(ctx.home, '.claude.json');
  if (isFile(userClaudeJson)) user.entries.push(userMcpEntry(ctx, userClaudeJson));
  const memoryEntry = autoMemoryEntry(ctx, configDir, settings);
  if (memoryEntry) user.entries.push(memoryEntry);
  if (user.entries.length) scopes.push(user);

  // ---- ancestors (filesystem root down to parent of cwd) ----
  const chain = chainFromRoot(ctx.cwd);
  for (const dir of chain.slice(0, -1)) {
    if (dir === dirname(dir)) continue; // skip filesystem root itself
    const scope = makeScope(ctx, TOOL, 'ancestor', `Ancestor ${ctx.display(dir)}`, dir);
    for (const name of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const path = join(dir, name);
      // The user memory file lives in an ancestor when cwd is under $HOME; it is already listed under User.
      if (isFile(path) && !isInside(configDir, path))
        scope.entries.push(
          instructionEntry(
            ctx,
            path,
            'active',
            'ancestor memory files are loaded at startup, nearest last',
            settings,
            configDir,
          ),
        );
    }
    if (scope.entries.length) scopes.push(scope);
  }

  // ---- project ----
  const project = makeScope(ctx, TOOL, 'project', 'Project (working directory)', ctx.cwd);
  for (const [name, reason] of [
    ['CLAUDE.md', 'project memory, shared with the team'],
    [join('.claude', 'CLAUDE.md'), 'project memory kept inside .claude/'],
    ['CLAUDE.local.md', 'personal project memory, not committed'],
  ] as const) {
    const path = join(ctx.cwd, name);
    if (isFile(path))
      project.entries.push(instructionEntry(ctx, path, 'active', reason, settings, configDir));
  }
  project.entries.push(
    ...ruleEntries(
      ctx,
      join(ctx.cwd, '.claude', 'rules'),
      ctx.cwd,
      'project rules load after user rules',
    ),
  );
  // Project agents come before user agents in precedence, so register them first.
  const projectAgents = agentEntries(
    ctx,
    join(ctx.cwd, '.claude', 'agents'),
    agentNames,
    'project subagents take precedence over user and plugin subagents',
  );
  // User-scope agents are collected now so shadowing is computed against the project.
  const userAgents = agentEntries(
    ctx,
    join(configDir, 'agents'),
    agentNames,
    'user subagents apply to every project',
  );
  user.entries.push(...userAgents);
  project.entries.push(
    ...skillEntries(
      ctx,
      join(ctx.cwd, '.claude', 'skills'),
      'project skills, shared with the team',
      settings,
      skillNames,
      ctx.cwd,
    ),
  );
  project.entries.push(...commandEntries(ctx, join(ctx.cwd, '.claude', 'commands'), skillNames));
  project.entries.push(...projectAgents);
  for (const layer of settings.layers.filter((l) => l.level === 'project'))
    project.entries.push(settingsEntry(ctx, layer, settings));
  project.entries.push(
    ...outputStyleEntries(ctx, settings, [join(ctx.cwd, '.claude', 'output-styles')]),
  );
  const mcpJson = join(ctx.cwd, '.mcp.json');
  if (isFile(mcpJson)) project.entries.push(projectMcpEntry(ctx, mcpJson, settings));
  scopes.push(project);

  // ---- additional directories (--add-dir) ----
  const addDirMd = ctx.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD === '1';
  for (const dir of ctx.addDirs) {
    const scope = makeScope(ctx, TOOL, 'project', `Additional directory ${ctx.display(dir)}`, dir);
    for (const name of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const path = join(dir, name);
      if (isFile(path)) {
        scope.entries.push(
          instructionEntry(
            ctx,
            path,
            addDirMd ? 'active' : 'inactive',
            addDirMd
              ? 'loaded because CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1'
              : 'memory files in --add-dir directories load only with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1',
            settings,
            configDir,
          ),
        );
      }
    }
    for (const e of ruleEntries(
      ctx,
      join(dir, '.claude', 'rules'),
      dir,
      'rules from an additional directory',
    )) {
      if (!addDirMd) {
        e.status = 'inactive';
        e.reason =
          'rules in --add-dir directories load only with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1';
      }
      scope.entries.push(e);
    }
    scope.entries.push(
      ...skillEntries(
        ctx,
        join(dir, '.claude', 'skills'),
        'skills from an additional directory',
        settings,
        skillNames,
        dir,
      ),
    );
    scope.entries.push(
      ...agentEntries(
        ctx,
        join(dir, '.claude', 'agents'),
        agentNames,
        'subagents from an additional directory',
      ),
    );
    if (scope.entries.length) scopes.push(scope);
  }

  // ---- plugins ----
  for (const pluginId of settings.enabledPlugins) {
    scopes.push(pluginScope(ctx, configDir, pluginId, settings, skillNames, agentNames));
  }

  // ---- subdirectories ----
  const sub = makeScope(ctx, TOOL, 'subdirectory', 'Subdirectories (loaded on demand)', ctx.cwd);
  walkDown(ctx.cwd, ctx.subdirDepth, (dir) => {
    if (dir === ctx.cwd) return;
    for (const name of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const path = join(dir, name);
      if (!isFile(path)) continue;
      const hit = ctx.target !== null && isInside(dir, ctx.target);
      const e = instructionEntry(
        ctx,
        path,
        hit ? 'active' : 'on-demand',
        hit
          ? 'the target file is inside this directory, so this loads when it is read or edited'
          : 'loads when Claude reads, writes or edits a file in this directory; not present at session start',
        settings,
        configDir,
      );
      if (hit) e.matchesTarget = true;
      sub.entries.push(e);
    }
  });
  if (sub.entries.length) scopes.push(sub);

  if (settings.model) notes.push(`Model pinned by settings: ${settings.model}.`);
  if (settings.hookEvents.size)
    notes.push(`Hooks configured for: ${[...settings.hookEvents.keys()].join(', ')}.`);
  if (settings.claudeMdExcludes.length)
    notes.push(`claudeMdExcludes: ${settings.claudeMdExcludes.join(', ')}.`);
  if (settings.disableAllMcpjsonServers)
    notes.push('disableAllMcpjsonServers is set; project .mcp.json servers are ignored.');

  return {
    tool: TOOL,
    label: 'Claude Code',
    scopes,
    notes,
    blindSpots: [
      'Managed settings delivered by MDM or the claude.ai console apply above every file shown here.',
      'claude.ai connectors and server-managed MCP servers are not on disk.',
      'The auto-memory directory name is inferred from the project path; the encoding is not documented.',
      'Subdirectory CLAUDE.md and path-scoped rules depend on which files the session touches; pass --file to simulate one.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Instruction files and @imports

function instructionEntry(
  ctx: ResolveContext,
  path: string,
  status: Status,
  reason: string,
  settings: MergedSettings,
  configDir: string,
): Entry {
  const loaded = loadFile(path);
  const excluded = isExcluded(path, ctx, settings.claudeMdExcludes);
  const entry = makeEntry(
    ctx,
    {
      tool: TOOL,
      kind: 'instructions',
      path,
      status: excluded ? 'inactive' : status,
      reason: excluded ? 'matched by claudeMdExcludes in settings' : reason,
      docUrl: DOCS.claude.memory,
    },
    loaded,
  );
  if (loaded && !excluded) {
    const children = importEntries(ctx, path, loaded, 1, new Set([path]), configDir);
    if (children.length) entry.children = children;
  }
  return entry;
}

function importEntries(
  ctx: ResolveContext,
  fromPath: string,
  loaded: LoadedFile,
  depth: number,
  seen: Set<string>,
  configDir: string,
): Entry[] {
  const out: Entry[] = [];
  for (const token of importTokens(loaded.body)) {
    const target = resolveImport(token, fromPath, ctx.home);
    if (!target) continue;
    const exists = isFile(target);
    if (!exists && !looksLikePath(token)) continue;
    if (seen.has(target)) {
      out.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'import',
          path: target,
          status: 'inactive',
          reason: `circular import of ${ctx.display(target)}`,
          docUrl: DOCS.claude.memory,
          virtual: true,
        }),
      );
      continue;
    }
    if (!exists) {
      out.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'import',
          path: target,
          status: 'inactive',
          reason: `imported with @${token} but the file does not exist`,
          docUrl: DOCS.claude.memory,
          virtual: true,
        }),
      );
      continue;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      out.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'import',
          path: target,
          status: 'inactive',
          reason: `beyond the ${MAX_IMPORT_DEPTH}-hop import limit`,
          docUrl: DOCS.claude.memory,
        }),
      );
      continue;
    }
    const childLoaded = loadFile(target);
    // Imports from user memory are the user's own choice; imports that lead a
    // project file outside the project (and outside ~/.claude) need approval.
    const external =
      !isInside(ctx.cwd, target) && !isInside(configDir, target) && !isInside(configDir, fromPath);
    const entry = makeEntry(
      ctx,
      {
        tool: TOOL,
        kind: 'import',
        path: target,
        status: external && !ctx.trusted ? 'trust-gated' : 'active',
        reason:
          external && !ctx.trusted
            ? `imported with @${token}; imports outside the project need one-time approval`
            : `imported with @${token}`,
        docUrl: DOCS.claude.memory,
        ...(external ? { tags: ['external'] } : {}),
      },
      childLoaded,
    );
    if (childLoaded) {
      const nextSeen = new Set(seen);
      nextSeen.add(target);
      const children = importEntries(ctx, target, childLoaded, depth + 1, nextSeen, configDir);
      if (children.length) entry.children = children;
    }
    out.push(entry);
  }
  return out;
}

/** Extract @path tokens, ignoring fenced code blocks and inline code spans. */
export function importTokens(body: string): string[] {
  const tokens: string[] = [];
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.replace(/`[^`]*`/g, '');
    const re = /(?:^|[\s(])@("[^"]+"|[^\s)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const tok = (m[1] ?? '').replace(/[.,;:]+$/, '');
      if (tok.startsWith('"')) continue; // quoted means literal, not import
      if (tok) tokens.push(tok);
    }
  }
  return tokens;
}

function looksLikePath(token: string): boolean {
  return (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('~/') ||
    token.startsWith('/') ||
    token.endsWith('.md')
  );
}

function resolveImport(token: string, fromPath: string, home: string): string | null {
  if (/^[a-z]+:\/\//i.test(token)) return null;
  if (token.startsWith('~/')) return join(home, token.slice(2));
  if (isAbsolute(token)) return token;
  return resolve(dirname(fromPath), token);
}

function isExcluded(path: string, ctx: ResolveContext, excludes: string[]): boolean {
  if (!excludes.length) return false;
  const rel = relative(ctx.cwd, path);
  return (
    matchesAnyGlob(excludes, rel.startsWith('..') ? path : rel, ctx.cwd) ||
    matchesAnyGlob(excludes, path, '/')
  );
}

// ---------------------------------------------------------------------------
// Rules

function ruleEntries(ctx: ResolveContext, rulesDir: string, root: string, reason: string): Entry[] {
  if (!isDir(rulesDir)) return [];
  const out: Entry[] = [];
  for (const path of findFiles(rulesDir, (n) => n.endsWith('.md'))) {
    const loaded = loadFile(path);
    if (!loaded) continue;
    const globs = asStringList(loaded.frontmatter?.paths);
    if (!globs.length) {
      out.push(
        makeEntry(
          ctx,
          {
            tool: TOOL,
            kind: 'rule',
            path,
            status: 'active',
            reason: `${reason}; no paths: frontmatter, so it loads at session start`,
            docUrl: DOCS.claude.rules,
          },
          loaded,
        ),
      );
      continue;
    }
    const hit = ctx.target !== null && matchesAnyGlob(globs, ctx.target, root);
    out.push(
      makeEntry(
        ctx,
        {
          tool: TOOL,
          kind: 'rule',
          path,
          status: hit ? 'active' : 'conditional',
          reason: hit
            ? `the target file matches ${globs.join(', ')}`
            : `loads when Claude reads, writes or edits a file matching ${globs.join(', ')}`,
          docUrl: DOCS.claude.rules,
          globs,
          matchesTarget: hit,
        },
        loaded,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skills, commands, agents

function skillEntries(
  ctx: ResolveContext,
  dir: string,
  reason: string,
  settings: MergedSettings,
  seen: Set<string>,
  root: string,
  /** Plugin name; plugin skills are invoked as `plugin:skill` and do not collide with bare names. */
  namespace?: string,
): Entry[] {
  const out: Entry[] = [];
  for (const path of findSkillFiles(dir)) {
    const loaded = loadFile(path);
    if (!loaded) continue;
    const fm = loaded.frontmatter ?? {};
    const bare = typeof fm.name === 'string' ? fm.name : basename(dirname(path));
    const name = namespace ? `${namespace}:${bare}` : bare;
    const override = settings.skillOverrides[name];
    const paths = asStringList(fm.paths);
    let status: Status = 'on-demand';
    let why = `${reason}; listed by name and description, the body loads when invoked`;
    let matchesTarget: boolean | undefined;
    if (seen.has(name)) {
      status = 'shadowed';
      why = `a skill named "${name}" in a higher-precedence scope hides this one`;
    } else if (override === 'off' || override === false) {
      status = 'inactive';
      why = 'hidden by skillOverrides in settings';
    } else if (asBoolean(fm['disable-model-invocation']) === true) {
      status = 'manual';
      why = 'disable-model-invocation: true — only the user can run it with /';
    } else if (paths.length) {
      matchesTarget = ctx.target !== null && matchesAnyGlob(paths, ctx.target, root);
      status = matchesTarget ? 'active' : 'conditional';
      why = matchesTarget
        ? `paths match the target file (${paths.join(', ')})`
        : `activates for files matching ${paths.join(', ')}`;
    }
    if (status !== 'shadowed' && status !== 'inactive') seen.add(name);
    const tags: string[] = [];
    if (asBoolean(fm['user-invocable']) === false) tags.push('model-only');
    out.push(
      makeEntry(
        ctx,
        {
          tool: TOOL,
          kind: 'skill',
          path,
          status,
          reason: why,
          docUrl: DOCS.claude.skills,
          name,
          tags,
          globs: paths,
          ...(matchesTarget !== undefined ? { matchesTarget } : {}),
        },
        loaded,
      ),
    );
  }
  return out;
}

function commandEntries(
  ctx: ResolveContext,
  dir: string,
  skillNames: Set<string>,
  namespace?: string,
): Entry[] {
  if (!isDir(dir)) return [];
  return findFiles(dir, (n) => n.endsWith('.md')).map((path) => {
    const bare = relative(dir, path).replace(/\.md$/, '').split(sep).join(':');
    const name = namespace ? `${namespace}:${bare}` : bare;
    const shadowed = skillNames.has(name);
    return makeEntry(ctx, {
      tool: TOOL,
      kind: 'command',
      path,
      status: shadowed ? 'shadowed' : 'manual',
      reason: shadowed
        ? `a skill named "${name}" takes precedence over this command`
        : 'commands are the deprecated single-file form of skills; run with /',
      docUrl: DOCS.claude.directory,
      name,
      tags: ['deprecated'],
    });
  });
}

function agentEntries(
  ctx: ResolveContext,
  dir: string,
  seen: Set<string>,
  reason: string,
): Entry[] {
  if (!isDir(dir)) return [];
  const out: Entry[] = [];
  for (const path of findFiles(dir, (n) => n.endsWith('.md'))) {
    const loaded = loadFile(path);
    if (!loaded) continue;
    const name = typeof loaded.frontmatter?.name === 'string' ? loaded.frontmatter.name : null;
    if (!name) {
      out.push(
        makeEntry(
          ctx,
          {
            tool: TOOL,
            kind: 'agent',
            path,
            status: 'inactive',
            reason: 'no name field in frontmatter, so the file is treated as documentation',
            docUrl: DOCS.claude.agents,
          },
          loaded,
        ),
      );
      continue;
    }
    const shadowed = seen.has(name);
    if (!shadowed) seen.add(name);
    out.push(
      makeEntry(
        ctx,
        {
          tool: TOOL,
          kind: 'agent',
          path,
          status: shadowed ? 'shadowed' : 'on-demand',
          reason: shadowed
            ? `a subagent named "${name}" in a higher-precedence scope hides this one`
            : `${reason}; listed to Claude and loaded when delegated to`,
          docUrl: DOCS.claude.agents,
          name,
        },
        loaded,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings

function managedDirFor(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

function mergeSettings(ctx: ResolveContext, configDir: string, managedDir: string): MergedSettings {
  const candidates: Omit<SettingsLayer, 'json'>[] = [
    {
      label: 'user settings',
      path: join(configDir, 'settings.json'),
      level: 'user',
      status: 'active',
      reason: 'lowest-precedence layer; applies to every project',
    },
    {
      label: 'project settings',
      path: join(ctx.cwd, '.claude', 'settings.json'),
      level: 'project',
      status: ctx.trusted ? 'active' : 'trust-gated',
      reason: ctx.trusted
        ? 'shared project settings'
        : 'shared project settings need one-time approval in interactive sessions',
    },
    {
      label: 'local settings',
      path: join(ctx.cwd, '.claude', 'settings.local.json'),
      level: 'project',
      status: 'active',
      reason: 'personal project settings, not committed',
    },
    {
      label: 'managed settings',
      path: join(managedDir, 'managed-settings.json'),
      level: 'managed',
      status: 'active',
      reason: 'highest precedence; cannot be overridden by lower layers',
    },
  ];
  const layers: SettingsLayer[] = [];
  for (const c of candidates) {
    if (!isFile(c.path)) continue;
    layers.push({ ...c, json: readJson(c.path) });
  }
  // Precedence low -> high is the order above, so later layers win scalars.
  const merged: MergedSettings = {
    layers,
    claudeMdExcludes: [],
    skillOverrides: {},
    enabledPlugins: [],
    outputStyle: null,
    autoMemoryEnabled: null,
    model: null,
    hookEvents: new Map(),
    enabledMcpjsonServers: [],
    disableAllMcpjsonServers: false,
  };
  for (const layer of layers) {
    const j = layer.json;
    if (!j) continue;
    merged.claudeMdExcludes.push(...asStringList(j.claudeMdExcludes));
    if (j.skillOverrides && typeof j.skillOverrides === 'object')
      Object.assign(merged.skillOverrides, j.skillOverrides as object);
    merged.enabledPlugins.push(...enabledPluginIds(j.enabledPlugins));
    if (typeof j.outputStyle === 'string') merged.outputStyle = j.outputStyle;
    if (typeof j.autoMemoryEnabled === 'boolean') merged.autoMemoryEnabled = j.autoMemoryEnabled;
    if (typeof j.model === 'string') merged.model = j.model;
    if (j.hooks && typeof j.hooks === 'object') {
      for (const event of Object.keys(j.hooks as object)) {
        const list = merged.hookEvents.get(event) ?? [];
        list.push(layer.path);
        merged.hookEvents.set(event, list);
      }
    }
    merged.enabledMcpjsonServers.push(...asStringList(j.enabledMcpjsonServers));
    if (j.disableAllMcpjsonServers === true) merged.disableAllMcpjsonServers = true;
  }
  merged.enabledPlugins = [...new Set(merged.enabledPlugins)];
  return merged;
}

function enabledPluginIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  return [];
}

function settingsEntry(ctx: ResolveContext, layer: SettingsLayer, settings: MergedSettings): Entry {
  const j = layer.json ?? {};
  const keys = Object.keys(j);
  const parts: string[] = [];
  if (keys.length) parts.push(`keys: ${keys.join(', ')}`);
  const entry = makeEntry(ctx, {
    tool: TOOL,
    kind: 'settings',
    path: layer.path,
    status: layer.json ? layer.status : 'inactive',
    reason: layer.json ? layer.reason : 'file could not be parsed as JSON',
    docUrl: DOCS.claude.settings,
    name: layer.label,
    description: parts.join('; '),
  });
  if (j.hooks && typeof j.hooks === 'object') {
    const events = Object.keys(j.hooks as object);
    entry.children = [
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'hooks',
        path: layer.path,
        status: entry.status === 'inactive' ? 'inactive' : 'active',
        reason: 'hooks run shell commands or prompts around tool calls and can inject context',
        docUrl: DOCS.claude.settings,
        name: 'hooks',
        description: `events: ${events.join(', ')}`,
        virtual: true,
      }),
    ];
  }
  void settings;
  return entry;
}

function outputStyleEntries(
  ctx: ResolveContext,
  settings: MergedSettings,
  dirs: string[],
): Entry[] {
  const style = settings.outputStyle;
  if (!style || ['default', 'explanatory', 'learning'].includes(style.toLowerCase())) return [];
  const out: Entry[] = [];
  for (const dir of dirs) {
    for (const candidate of [
      join(dir, `${style}.md`),
      join(dir, style, 'style.md'),
      join(dir, style, `${style}.md`),
    ]) {
      if (isFile(candidate)) {
        out.push(
          makeEntry(ctx, {
            tool: TOOL,
            kind: 'instructions',
            path: candidate,
            status: 'active',
            reason: `selected by outputStyle: "${style}"; replaces the default system-prompt style section`,
            docUrl: DOCS.claude.outputStyles,
            tags: ['output-style'],
          }),
        );
        return out;
      }
    }
  }
  return out;
}

function autoMemoryEntry(
  ctx: ResolveContext,
  configDir: string,
  settings: MergedSettings,
): Entry | null {
  const encoded = ctx.cwd.replace(/[^A-Za-z0-9]/g, '-');
  const path = join(configDir, 'projects', encoded, 'memory', 'MEMORY.md');
  if (!isFile(path)) return null;
  if (settings.autoMemoryEnabled === false) {
    return makeEntry(ctx, {
      tool: TOOL,
      kind: 'memory',
      path,
      status: 'inactive',
      reason: 'autoMemoryEnabled is false in settings',
      docUrl: DOCS.claude.memory,
      tags: ['inferred-path'],
    });
  }
  const text = readText(path) ?? '';
  const lines = text.split('\n').length;
  const bytes = statPath(path).size;
  const over = lines > AUTO_MEMORY_MAX_LINES || bytes > AUTO_MEMORY_MAX_BYTES;
  return makeEntry(ctx, {
    tool: TOOL,
    kind: 'memory',
    path,
    status: over ? 'truncated' : 'active',
    reason: over
      ? `only the first ${AUTO_MEMORY_MAX_LINES} lines or ${AUTO_MEMORY_MAX_BYTES / 1024} KB load (file has ${lines} lines, ${bytes} bytes)`
      : 'auto memory index loads at session start; individual memory files load on demand',
    docUrl: DOCS.claude.memory,
    tags: ['inferred-path'],
  });
}

function projectMcpEntry(ctx: ResolveContext, path: string, settings: MergedSettings): Entry {
  const json = readJson(path);
  const servers =
    json?.mcpServers && typeof json.mcpServers === 'object'
      ? Object.keys(json.mcpServers as object)
      : [];
  let status: Status = ctx.trusted ? 'active' : 'trust-gated';
  let reason = ctx.trusted
    ? 'project MCP servers are approved'
    : 'project MCP servers need one-time approval in interactive sessions';
  if (settings.disableAllMcpjsonServers) {
    status = 'inactive';
    reason = 'disableAllMcpjsonServers is set in settings';
  } else if (settings.enabledMcpjsonServers.length) {
    status = 'active';
    reason = `pre-approved by enabledMcpjsonServers: ${settings.enabledMcpjsonServers.join(', ')}`;
  }
  return makeEntry(ctx, {
    tool: TOOL,
    kind: 'mcp',
    path,
    status,
    reason,
    docUrl: DOCS.claude.mcp,
    description: servers.length ? `servers: ${servers.join(', ')}` : 'no servers defined',
  });
}

function userMcpEntry(ctx: ResolveContext, path: string): Entry {
  const json = readJson(path);
  const global =
    json?.mcpServers && typeof json.mcpServers === 'object'
      ? Object.keys(json.mcpServers as object)
      : [];
  const projects = (json?.projects as Record<string, Json> | undefined) ?? {};
  const local = projects[ctx.cwd]?.mcpServers;
  const localNames = local && typeof local === 'object' ? Object.keys(local as object) : [];
  const parts: string[] = [];
  if (global.length) parts.push(`user servers: ${global.join(', ')}`);
  if (localNames.length) parts.push(`local servers for this project: ${localNames.join(', ')}`);
  return makeEntry(ctx, {
    tool: TOOL,
    kind: 'mcp',
    path,
    status: parts.length ? 'active' : 'inactive',
    reason: parts.length
      ? 'user and local-scope MCP servers from ~/.claude.json'
      : 'no MCP servers for this project in ~/.claude.json',
    docUrl: DOCS.claude.mcp,
    description: parts.join('; '),
    virtual: true,
  });
}

// ---------------------------------------------------------------------------
// Plugins

function pluginScope(
  ctx: ResolveContext,
  configDir: string,
  pluginId: string,
  settings: MergedSettings,
  skillNames: Set<string>,
  agentNames: Set<string>,
): Scope {
  const [name, marketplace] = pluginId.includes('@')
    ? (pluginId.split('@') as [string, string])
    : [pluginId, ''];
  const dir = findPluginDir(configDir, name, marketplace);
  const scope = makeScope(
    ctx,
    TOOL,
    'plugin',
    `Plugin ${pluginId}`,
    dir ?? join(configDir, 'plugins'),
  );
  if (!dir) {
    scope.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'settings',
        path: join(configDir, 'plugins', 'known_marketplaces.json'),
        status: 'inactive',
        reason: `plugin "${pluginId}" is enabled in settings but was not found on disk`,
        docUrl: DOCS.claude.plugins,
        name: pluginId,
        virtual: true,
      }),
    );
    return scope;
  }
  scope.entries.push(
    ...skillEntries(
      ctx,
      join(dir, 'skills'),
      'plugin skills are lowest precedence',
      settings,
      skillNames,
      ctx.cwd,
      name,
    ),
  );
  scope.entries.push(...commandEntries(ctx, join(dir, 'commands'), skillNames, name));
  scope.entries.push(
    ...agentEntries(ctx, join(dir, 'agents'), agentNames, 'plugin subagents are lowest precedence'),
  );
  const hooks = join(dir, 'hooks', 'hooks.json');
  if (isFile(hooks)) {
    const json = readJson(hooks);
    const events =
      json?.hooks && typeof json.hooks === 'object'
        ? Object.keys(json.hooks as object)
        : Object.keys(json ?? {});
    scope.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'hooks',
        path: hooks,
        status: 'active',
        reason: 'plugin hooks run alongside hooks from settings',
        docUrl: DOCS.claude.plugins,
        description: `events: ${events.join(', ')}`,
      }),
    );
  }
  const mcp = join(dir, '.mcp.json');
  if (isFile(mcp)) {
    const json = readJson(mcp);
    const servers =
      json?.mcpServers && typeof json.mcpServers === 'object'
        ? Object.keys(json.mcpServers as object)
        : [];
    scope.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'mcp',
        path: mcp,
        status: 'active',
        reason: 'plugin MCP servers start with the plugin',
        docUrl: DOCS.claude.plugins,
        description: `servers: ${servers.join(', ')}`,
      }),
    );
  }
  const manifest = join(dir, '.claude-plugin', 'plugin.json');
  if (isFile(manifest))
    scope.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'settings',
        path: manifest,
        status: 'active',
        reason: 'plugin manifest',
        docUrl: DOCS.claude.plugins,
        name: `${name} manifest`,
      }),
    );
  return scope;
}

function findPluginDir(configDir: string, name: string, marketplace: string): string | null {
  const pluginsRoot = join(configDir, 'plugins');
  const known = readJson(join(pluginsRoot, 'known_marketplaces.json')) ?? {};
  const marketplaces = marketplace ? [marketplace] : Object.keys(known);
  for (const m of marketplaces) {
    const row = known[m] as Json | undefined;
    const location =
      typeof row?.installLocation === 'string'
        ? row.installLocation
        : join(pluginsRoot, 'marketplaces', m);
    const manifest = readJson(join(location, '.claude-plugin', 'marketplace.json'));
    const plugins = Array.isArray(manifest?.plugins) ? (manifest.plugins as Json[]) : [];
    const entry = plugins.find((p) => p.name === name);
    if (entry && typeof entry.source === 'string') {
      const candidate = resolve(location, entry.source);
      if (isDir(candidate)) return candidate;
    }
    for (const candidate of [
      join(location, 'plugins', name),
      join(location, 'external_plugins', name),
      join(location, name),
    ]) {
      if (isDir(candidate)) return candidate;
    }
    const cache = join(pluginsRoot, 'cache', m, name);
    if (isDir(cache)) {
      const versions = listDir(cache).filter((v) => isDir(join(cache, v)));
      const latest = versions[versions.length - 1];
      return latest ? join(cache, latest) : cache;
    }
  }
  return null;
}
