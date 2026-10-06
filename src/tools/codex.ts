import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ResolveContext } from '../context.js';
import { DOCS } from '../docs.js';
import { findSkillFiles, loadFile, makeEntry, makeScope } from '../entry.js';
import { isDir, isFile, isInside, listDir, readText, statPath, walkDown } from '../fs.js';
import type { Entry, Scope, ToolReport } from '../model.js';

const TOOL = 'codex' as const;
const DEFAULT_MAX_BYTES = 32 * 1024;

type Toml = Record<string, unknown>;

interface CodexConfig {
  user: Toml | null;
  profileName: string | null;
  profile: Toml | null;
  profilePath: string | null;
  project: Toml | null;
  projectPath: string | null;
  projectTrusted: boolean;
  /** Effective merged view for the keys rulescope cares about. */
  effective: Toml;
}

export function resolveCodex(ctx: ResolveContext): ToolReport {
  const codexHome = ctx.env.CODEX_HOME ? resolve(ctx.env.CODEX_HOME) : join(ctx.home, '.codex');
  const projectRoot = ctx.gitRoot ?? ctx.cwd;
  const config = loadConfig(ctx, codexHome, projectRoot);
  const scopes: Scope[] = [];
  const notes: string[] = [];

  const maxBytes = numberKey(config.effective, 'project_doc_max_bytes') ?? DEFAULT_MAX_BYTES;
  const fallbacks = stringListKey(config.effective, 'project_doc_fallback_filenames');

  // ---- admin ----
  const admin = makeScope(ctx, TOOL, 'managed', 'Admin (/etc/codex)', '/etc/codex');
  admin.entries.push(
    ...skillEntries(
      ctx,
      '/etc/codex/skills',
      config,
      'admin skills apply to every user on this machine',
    ),
  );
  if (admin.entries.length) scopes.push(admin);

  // ---- user (CODEX_HOME) ----
  const user = makeScope(ctx, TOOL, 'user', `Codex home (${ctx.display(codexHome)})`, codexHome);
  if (ctx.env.CODEX_HOME) notes.push(`CODEX_HOME is set; using ${codexHome} instead of ~/.codex.`);

  const globalOverride = join(codexHome, 'AGENTS.override.md');
  const globalAgents = join(codexHome, 'AGENTS.md');
  if (isFile(globalOverride)) {
    user.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'instructions',
        path: globalOverride,
        status: 'active',
        reason:
          'global AGENTS.override.md is read first and replaces AGENTS.md in the same directory',
        docUrl: DOCS.codex.agentsMd,
      }),
    );
    if (isFile(globalAgents))
      user.entries.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'instructions',
          path: globalAgents,
          status: 'shadowed',
          reason: 'AGENTS.override.md exists in the same directory',
          docUrl: DOCS.codex.agentsMd,
        }),
      );
  } else if (isFile(globalAgents)) {
    user.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'instructions',
        path: globalAgents,
        status: 'active',
        reason: 'global AGENTS.md applies to every project',
        docUrl: DOCS.codex.agentsMd,
      }),
    );
  }

  if (config.user) {
    const path = join(codexHome, 'config.toml');
    user.entries.push(
      configEntry(
        ctx,
        path,
        config.user,
        'user config is the base layer; profiles, project config and --config override it',
      ),
    );
    const instructionsFile = stringKey(config.effective, 'model_instructions_file');
    if (instructionsFile) {
      const p = isAbsolute(instructionsFile)
        ? instructionsFile
        : resolve(codexHome, instructionsFile);
      user.entries.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'instructions',
          path: p,
          status: isFile(p) ? 'active' : 'inactive',
          reason: isFile(p)
            ? 'model_instructions_file replaces the built-in base instructions'
            : 'model_instructions_file points at a file that does not exist',
          docUrl: DOCS.codex.config,
          tags: ['replaces-builtin'],
        }),
      );
    }
    const dev = stringKey(config.effective, 'developer_instructions');
    if (dev) {
      user.entries.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'instructions',
          path,
          status: 'active',
          reason: 'developer_instructions are injected into every session',
          docUrl: DOCS.codex.config,
          name: 'developer_instructions',
          virtual: true,
          content: dev,
        }),
      );
    }
  }
  if (config.profilePath && config.profile) {
    user.entries.push(
      configEntry(
        ctx,
        config.profilePath,
        config.profile,
        `profile "${config.profileName}" is active and overrides the user config`,
      ),
    );
  } else if (config.profileName) {
    const inline = (config.user?.profiles as Toml | undefined)?.[config.profileName];
    if (inline && typeof inline === 'object')
      notes.push(
        `Profile "${config.profileName}" is defined inline in config.toml and overrides top-level keys.`,
      );
    else notes.push(`Profile "${config.profileName}" is selected but no profile config was found.`);
  }

  user.entries.push(
    ...skillEntries(
      ctx,
      join(ctx.home, '.agents', 'skills'),
      config,
      'user skills apply to every project',
    ),
  );
  user.entries.push(
    ...skillEntries(ctx, join(codexHome, 'skills'), config, 'legacy user skills directory', [
      'legacy',
    ]),
  );
  user.entries.push(...promptEntries(ctx, join(codexHome, 'prompts')));
  user.entries.push(...execPolicyEntries(ctx, join(codexHome, 'rules')));
  const hooksJson = join(codexHome, 'hooks.json');
  if (isFile(hooksJson))
    user.entries.push(
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'hooks',
        path: hooksJson,
        status: 'active',
        reason: 'lifecycle hooks can inject context and gate tool calls',
        docUrl: DOCS.codex.config,
      }),
    );
  if (user.entries.length) scopes.push(user);

  // ---- project chain: repo root down to cwd ----
  const chain = chainBetween(projectRoot, ctx.cwd);
  let consumed = 0;
  let budgetHit = false;
  for (const dir of chain) {
    const level = dir === projectRoot ? 'project' : 'ancestor';
    const scope = makeScope(
      ctx,
      TOOL,
      dir === ctx.cwd && dir !== projectRoot ? 'project' : level,
      labelFor(dir, projectRoot, ctx),
      dir,
    );
    const candidates = ['AGENTS.override.md', 'AGENTS.md', ...fallbacks];
    const existing = candidates.filter((n) => isFile(join(dir, n)));
    const chosen = existing[0];
    for (const name of existing) {
      const path = join(dir, name);
      if (name !== chosen) {
        scope.entries.push(
          makeEntry(ctx, {
            tool: TOOL,
            kind: 'instructions',
            path,
            status: 'shadowed',
            reason: `${chosen} is read first in this directory`,
            docUrl: DOCS.codex.agentsMd,
          }),
        );
        continue;
      }
      const size = statPath(path).size;
      const text = readText(path) ?? '';
      if (text.trim() === '') {
        scope.entries.push(
          makeEntry(ctx, {
            tool: TOOL,
            kind: 'instructions',
            path,
            status: 'inactive',
            reason: 'empty files are skipped',
            docUrl: DOCS.codex.agentsMd,
          }),
        );
        continue;
      }
      if (budgetHit || consumed >= maxBytes) {
        budgetHit = true;
        scope.entries.push(
          makeEntry(ctx, {
            tool: TOOL,
            kind: 'instructions',
            path,
            status: 'truncated',
            reason: `not loaded: the ${formatBytes(maxBytes)} project_doc_max_bytes budget was already consumed by files above`,
            docUrl: DOCS.codex.agentsMd,
          }),
        );
        continue;
      }
      if (consumed + size > maxBytes) {
        const kept = maxBytes - consumed;
        consumed = maxBytes;
        budgetHit = true;
        scope.entries.push(
          makeEntry(ctx, {
            tool: TOOL,
            kind: 'instructions',
            path,
            status: 'truncated',
            reason: `only the first ${formatBytes(kept)} of ${formatBytes(size)} fit in the project_doc_max_bytes budget`,
            docUrl: DOCS.codex.agentsMd,
          }),
        );
        continue;
      }
      consumed += size;
      const tags =
        name === 'AGENTS.override.md'
          ? ['override']
          : name === 'AGENTS.md'
            ? []
            : ['fallback-name'];
      scope.entries.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'instructions',
          path,
          status: 'active',
          reason:
            dir === ctx.cwd
              ? 'closest to the working directory, so it appears last and wins conflicts'
              : 'concatenated in root-to-cwd order',
          docUrl: DOCS.codex.agentsMd,
          tags,
        }),
      );
    }

    // Project-scoped config, only at the project root
    if (dir === projectRoot && config.projectPath) {
      scope.entries.push(
        configEntry(
          ctx,
          config.projectPath,
          config.project ?? {},
          config.projectTrusted
            ? 'project config is loaded because the project is trusted'
            : 'project config loads only once the project is trusted (projects.<path>.trust_level = "trusted", or pass --trusted)',
          config.projectTrusted ? 'active' : 'trust-gated',
        ),
      );
    }

    // Skills: .agents/skills in every directory from cwd up to the repo root
    scope.entries.push(
      ...skillEntries(
        ctx,
        join(dir, '.agents', 'skills'),
        config,
        'repository skills are discovered from cwd up to the repo root',
      ),
    );
    scope.entries.push(
      ...skillEntries(
        ctx,
        join(dir, '.codex', 'skills'),
        config,
        'legacy project skills directory',
        ['legacy'],
      ),
    );

    if (scope.entries.length) scopes.push(scope);
  }
  if (budgetHit)
    notes.push(
      `The AGENTS.md chain exceeds project_doc_max_bytes (${formatBytes(maxBytes)}); later files are cut. Raise the limit in config.toml or shorten the files.`,
    );
  if (consumed > 0)
    notes.push(
      `AGENTS.md chain: ${formatBytes(consumed)} of ${formatBytes(maxBytes)} budget used.`,
    );

  // ---- below cwd ----
  const sub = makeScope(
    ctx,
    TOOL,
    'subdirectory',
    'Below the working directory (not loaded)',
    ctx.cwd,
  );
  walkDown(ctx.cwd, ctx.subdirDepth, (dir) => {
    if (dir === ctx.cwd) return;
    for (const name of ['AGENTS.override.md', 'AGENTS.md', ...fallbacks]) {
      const path = join(dir, name);
      if (!isFile(path)) continue;
      sub.entries.push(
        makeEntry(ctx, {
          tool: TOOL,
          kind: 'instructions',
          path,
          status: 'inactive',
          reason:
            'Codex stops at the working directory and does not load nested AGENTS.md on demand; start Codex in this directory to apply it',
          docUrl: DOCS.codex.nestedIssue,
        }),
      );
    }
    const skillsDir = join(dir, '.agents', 'skills');
    if (isDir(skillsDir)) {
      for (const e of skillEntries(ctx, skillsDir, config, '')) {
        e.status = 'inactive';
        e.reason = 'skills below the working directory are not scanned';
        sub.entries.push(e);
      }
    }
  });
  if (sub.entries.length) scopes.push(sub);

  // Duplicate skill names are both shown, not merged
  const names = new Map<string, number>();
  for (const s of scopes)
    for (const e of s.entries)
      if (e.kind === 'skill' && e.name && e.status !== 'inactive')
        names.set(e.name, (names.get(e.name) ?? 0) + 1);
  const dupes = [...names.entries()].filter(([, n]) => n > 1).map(([n]) => n);
  if (dupes.length)
    notes.push(
      `Duplicate skill names are not merged by Codex; both appear in selectors: ${dupes.join(', ')}.`,
    );

  const mcp = config.effective.mcp_servers;
  if (mcp && typeof mcp === 'object')
    notes.push(`MCP servers configured: ${Object.keys(mcp as object).join(', ')}.`);

  return {
    tool: TOOL,
    label: 'Codex',
    scopes,
    notes,
    blindSpots: [
      'Built-in system skills shipped with Codex are not on disk in a stable location.',
      'Settings managed through the ChatGPT or Codex cloud UI are not visible here.',
      '--config command-line overrides apply per invocation and cannot be inspected from files.',
    ],
  };
}

function loadConfig(ctx: ResolveContext, codexHome: string, projectRoot: string): CodexConfig {
  const userPath = join(codexHome, 'config.toml');
  const user = parseTomlFile(userPath);
  const profileName = ctx.codexProfile ?? (typeof user?.profile === 'string' ? user.profile : null);
  let profile: Toml | null = null;
  let profilePath: string | null = null;
  if (profileName) {
    const p = join(codexHome, `${profileName}.config.toml`);
    if (isFile(p)) {
      profile = parseTomlFile(p);
      profilePath = p;
    } else {
      const inline = (user?.profiles as Toml | undefined)?.[profileName];
      if (inline && typeof inline === 'object') profile = inline as Toml;
    }
  }
  const projectCandidates = [
    join(projectRoot, '.codex', 'config.toml'),
    join(ctx.cwd, '.codex', 'config.toml'),
  ];
  const projectPath = projectCandidates.find((p) => isFile(p)) ?? null;
  const project = projectPath ? parseTomlFile(projectPath) : null;
  const projects = (user?.projects as Toml | undefined) ?? {};
  const trustedByConfig = [projectRoot, ctx.cwd].some((p) => {
    const row = projects[p] as Toml | undefined;
    return row?.trust_level === 'trusted';
  });
  const projectTrusted = ctx.trusted || trustedByConfig;
  const effective: Toml = {
    ...(user ?? {}),
    ...(profile ?? {}),
    ...(projectTrusted && project ? project : {}),
  };
  return {
    user,
    profileName,
    profile,
    profilePath,
    project,
    projectPath,
    projectTrusted,
    effective,
  };
}

function parseTomlFile(path: string): Toml | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return parseToml(text) as Toml;
  } catch {
    return { __parseError: true };
  }
}

function configEntry(
  ctx: ResolveContext,
  path: string,
  toml: Toml,
  reason: string,
  status: 'active' | 'trust-gated' = 'active',
): Entry {
  const keys = Object.keys(toml).filter((k) => k !== '__parseError');
  const interesting = [
    'model',
    'profile',
    'approval_policy',
    'sandbox_mode',
    'project_doc_max_bytes',
    'project_doc_fallback_filenames',
    'model_instructions_file',
    'developer_instructions',
    'mcp_servers',
    'skills',
    'hooks',
    'projects',
  ].filter((k) => keys.includes(k));
  const entry = makeEntry(ctx, {
    tool: TOOL,
    kind: 'settings',
    path,
    status,
    reason,
    docUrl: DOCS.codex.config,
    description: interesting.length ? `keys: ${interesting.join(', ')}` : `${keys.length} keys`,
  });
  if (toml.__parseError) entry.tags = [...(entry.tags ?? []), 'parse-error'];
  return entry;
}

function skillEntries(
  ctx: ResolveContext,
  dir: string,
  config: CodexConfig,
  reason: string,
  tags: string[] = [],
): Entry[] {
  const disabled = disabledSkillPaths(config, ctx.home);
  const out: Entry[] = [];
  for (const path of findSkillFiles(dir)) {
    const loaded = loadFile(path);
    if (!loaded) continue;
    const skillDir = dirname(path);
    const name =
      typeof loaded.frontmatter?.name === 'string' ? loaded.frontmatter.name : basename(skillDir);
    const off = disabled.some((d) => d === skillDir || d === path);
    out.push(
      makeEntry(
        ctx,
        {
          tool: TOOL,
          kind: 'skill',
          path,
          status: off ? 'inactive' : 'on-demand',
          reason: off
            ? 'disabled by a [[skills.config]] entry in config.toml'
            : `${reason ? reason + '; ' : ''}name and description are listed up front, the body loads when the skill is used`,
          docUrl: DOCS.codex.skills,
          name,
          tags,
        },
        loaded,
      ),
    );
  }
  return out;
}

function disabledSkillPaths(config: CodexConfig, home: string): string[] {
  const skills = config.effective.skills as Toml | undefined;
  const rows = skills?.config;
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const row of rows as Toml[]) {
    if (row.enabled === false && typeof row.path === 'string')
      out.push(resolve(row.path.replace(/^~(?=[\\/]|$)/, home)));
  }
  return out;
}

function promptEntries(ctx: ResolveContext, dir: string): Entry[] {
  if (!isDir(dir)) return [];
  return listDir(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) =>
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'command',
        path: join(dir, n),
        status: 'manual',
        reason: 'custom prompts run when the user invokes them with /',
        docUrl: DOCS.codex.config,
        name: n.replace(/\.md$/, ''),
      }),
    );
}

function execPolicyEntries(ctx: ResolveContext, dir: string): Entry[] {
  if (!isDir(dir)) return [];
  return listDir(dir)
    .filter((n) => n.endsWith('.rules'))
    .map((n) =>
      makeEntry(ctx, {
        tool: TOOL,
        kind: 'settings',
        path: join(dir, n),
        status: 'active',
        reason:
          'execpolicy rules decide which commands run without approval; they do not add instructions',
        docUrl: DOCS.codex.config,
        tags: ['execpolicy'],
      }),
    );
}

/** Directories from `root` down to `leaf`, inclusive. Falls back to [leaf] when leaf is outside root. */
function chainBetween(root: string, leaf: string): string[] {
  if (!isInside(root, leaf)) return [leaf];
  const chain: string[] = [];
  let current = leaf;
  for (;;) {
    chain.unshift(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function labelFor(dir: string, projectRoot: string, ctx: ResolveContext): string {
  if (dir === projectRoot && dir === ctx.cwd) return 'Project root (working directory)';
  if (dir === projectRoot) return 'Project root';
  if (dir === ctx.cwd) return 'Working directory';
  return `Between root and cwd: ${ctx.display(dir)}`;
}

function numberKey(t: Toml, key: string): number | undefined {
  const v = t[key];
  return typeof v === 'number' ? v : undefined;
}
function stringKey(t: Toml, key: string): string | undefined {
  const v = t[key];
  return typeof v === 'string' ? v : undefined;
}
function stringListKey(t: Toml, key: string): string[] {
  const v = t[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function formatBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} KiB` : `${n} B`;
}
