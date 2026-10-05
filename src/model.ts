/**
 * Normalized model shared by every tool resolver and renderer.
 *
 * Resolvers produce a ToolReport; renderers consume a Report. Neither side
 * knows about the other, so a new tool or a new output format is a single file.
 */

export type ToolId = 'claude' | 'codex' | 'cursor';

export const TOOL_IDS: readonly ToolId[] = ['claude', 'codex', 'cursor'];

export const TOOL_LABELS: Record<ToolId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

export type EntryKind =
  | 'instructions'
  | 'rule'
  | 'skill'
  | 'command'
  | 'agent'
  | 'settings'
  | 'hooks'
  | 'mcp'
  | 'memory'
  | 'import';

/**
 * "Active" is not a boolean. Each status answers "does the model see this, and when?".
 */
export type Status =
  /** Loaded into context when a session starts in this directory. */
  | 'active'
  /** Loaded only when the agent works on a file matching a glob. Resolved to active when --file matches. */
  | 'conditional'
  /** Loaded lazily: subdirectory instruction files, skill bodies, agent-requested rules. */
  | 'on-demand'
  /** Only loaded when the user invokes it explicitly (slash command, @-mention). */
  | 'manual'
  /** Present on disk but never loaded (disabled, excluded, below the search boundary). */
  | 'inactive'
  /** Hidden by a same-name entry in a higher-precedence scope. */
  | 'shadowed'
  /** Would be loaded but cut off by a byte or line budget. */
  | 'truncated'
  /** Loaded only once the project is trusted or approved in the tool's UI. */
  | 'trust-gated'
  /** Behaviour not confirmed by current documentation. */
  | 'unknown';

export interface Frontmatter {
  [key: string]: unknown;
}

export interface Entry {
  id: string;
  tool: ToolId;
  kind: EntryKind;
  /** Absolute path on disk. */
  path: string;
  /** Path shown to the user, relative to cwd or home. */
  displayPath: string;
  status: Status;
  /** One sentence explaining the status. */
  reason: string;
  /** Documentation URL for the rule that produced this status. */
  docUrl?: string;
  /** Short name (skill name, rule file stem, agent name). */
  name?: string;
  description?: string;
  frontmatter?: Frontmatter;
  bytes?: number;
  /** File body, when content capture is enabled. Frontmatter stripped. */
  content?: string;
  /** Globs that gate a conditional entry. */
  globs?: string[];
  /** True when --file was given and matched this entry's globs or directory. */
  matchesTarget?: boolean;
  /** Entries this one pulls in (Claude @imports). */
  children?: Entry[];
  /** Free-form flags such as "legacy", "compat", "inferred". */
  tags?: string[];
}

export type ScopeLevel =
  'managed' | 'user' | 'ancestor' | 'project' | 'subdirectory' | 'plugin' | 'system';

export interface Scope {
  id: string;
  tool: ToolId;
  level: ScopeLevel;
  label: string;
  /** Directory the scope represents. */
  dir: string;
  displayDir: string;
  entries: Entry[];
}

export interface ToolReport {
  tool: ToolId;
  label: string;
  scopes: Scope[];
  /** Observations worth surfacing that are not tied to one entry. */
  notes: string[];
  /** Sources of instructions this tool honours that cannot be read from disk. */
  blindSpots: string[];
}

export interface OverlapEntry {
  path: string;
  displayPath: string;
  tools: { tool: ToolId; status: Status; kind: EntryKind }[];
}

export interface Report {
  generatedAt: string;
  rulesVersion: string;
  cwd: string;
  home: string;
  gitRoot: string | null;
  targetFile: string | null;
  tools: ToolReport[];
  overlap: OverlapEntry[];
}

export interface ResolveOptions {
  /** Directory to evaluate. */
  cwd: string;
  /** Home directory. Injected so tests can point it at a fixture. */
  home: string;
  /** Environment to consult. Injected for the same reason. */
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** File the agent would work on, used to resolve path-scoped rules. */
  targetFile?: string;
  /** Capture file bodies into entries. */
  includeContent: boolean;
  /** Max bytes of content captured per file. */
  maxContentBytes: number;
  /** How deep to scan below cwd for subdirectory instruction files. */
  subdirDepth: number;
  /** Treat the project as trusted for tools that gate project config on trust. */
  trusted: boolean;
  /** Codex profile name, overriding the `profile` key in config.toml. */
  codexProfile?: string;
  /** Directories passed to Claude Code via --add-dir. */
  addDirs: string[];
}

export const STATUS_ORDER: readonly Status[] = [
  'active',
  'conditional',
  'on-demand',
  'manual',
  'trust-gated',
  'truncated',
  'shadowed',
  'inactive',
  'unknown',
];

export const STATUS_LABELS: Record<Status, string> = {
  active: 'active',
  conditional: 'conditional',
  'on-demand': 'on demand',
  manual: 'manual',
  inactive: 'inactive',
  shadowed: 'shadowed',
  truncated: 'truncated',
  'trust-gated': 'trust gated',
  unknown: 'unverified',
};
