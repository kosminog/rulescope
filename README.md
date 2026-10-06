# rulescope

Show which instruction files, rules, skills and settings **Claude Code**, **Codex** and **Cursor** will load for a directory. Terminal tree, JSON, or a self-contained HTML report with a hierarchical view.

```bash
npx rulescope                 # evaluate the current directory for all three tools
npx rulescope ~/src/app       # evaluate another directory
npx rulescope --html report.html --open
```

## Why

Every agent tool reads instructions from a different set of places: user and project memory files, ancestor directories, path-scoped rules, skills with progressive disclosure, settings layers, plugins. None of them tells you up front what a session starting in a given directory will actually see. rulescope resolves that from disk and labels each file with a status and the documented rule behind it.

## What it reports

Each entry carries one of these statuses:

| Status      | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| active      | Loaded into context when a session starts in this directory                     |
| conditional | Loaded when the agent works on a file matching a glob; resolved with `--file`   |
| on demand   | Loaded lazily: subdirectory instruction files, skill bodies, agent-chosen rules |
| manual      | Only when the user invokes it (slash command, @-mention)                        |
| trust gated | Loaded once the project is trusted or approved in the tool                      |
| truncated   | Cut by a byte or line budget                                                    |
| shadowed    | Hidden by a same-name entry in a higher-precedence scope                        |
| inactive    | On disk but never loaded (disabled, excluded, below the search boundary)        |
| unverified  | Behaviour not confirmed by current documentation                                |

Each tool also lists its **blind spots**: instruction sources it honours that are not on disk, such as Cursor's User Rules or managed settings delivered by MDM.

### Claude Code

Managed policy, `~/.claude/CLAUDE.md`, ancestor directories, `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `@` imports (5 hops), `.claude/rules` with `paths:` frontmatter, skills with precedence and `skillOverrides`, deprecated commands, subagents, settings layers with hooks, `claudeMdExcludes`, output styles, `.mcp.json` approval state, enabled plugins resolved from the marketplace on disk, auto memory, `--add-dir` behaviour and `CLAUDE_CONFIG_DIR`.

### Codex

`AGENTS.override.md` and `AGENTS.md` from the global `CODEX_HOME` and from the repository root down to the working directory, fallback filenames, the `project_doc_max_bytes` budget, nested files below cwd that Codex does not load, `config.toml` with profiles and project trust, `model_instructions_file`, `developer_instructions`, skills from `.agents/skills` up to the repo root plus user, admin and legacy directories, `skills.config` disables, custom prompts, execpolicy rules and hooks.

### Cursor

`.cursor/rules` with the four rule types, root and nested `AGENTS.md`, legacy `.cursorrules`, skills from `.cursor/skills`, `.agents/skills` and the Claude and Codex compatibility directories, commands, subagents with `.cursor` precedence, hooks at project, user and system level, MCP config and ignore files.

### Overlap

Files more than one tool reads. A `.agents/skills` directory feeds both Codex and Cursor; `.claude/skills` feeds Claude Code and Cursor.

## Usage

```
rulescope [dir] [options]

  -t, --tool <tools>        comma-separated subset of claude,codex,cursor
  -f, --file <path>         file the agent would work on; resolves path-scoped rules
                            and subdirectory instruction files
      --html <out>          write a self-contained HTML report
      --open                open the HTML report after writing it
      --json                print the report as JSON
      --home <dir>          inspect another home directory
      --add-dir <dir...>    directories passed to Claude Code via --add-dir
      --codex-profile <n>   Codex profile to apply
      --trusted             treat the project as trusted or approved
      --no-content          do not capture file contents into the report
      --depth <n>           levels below the directory to scan (default 4)
      --active-only         hide inactive and shadowed entries
      --no-color            disable colors

rulescope explain <path>    show what each tool does with one file
```

Examples:

```bash
# Which rules fire when Claude edits this file?
rulescope --tool claude --file src/api/users.ts

# Simulate an approved project and a Codex profile
rulescope --trusted --codex-profile fast

# Machine-readable output
rulescope --json | jq '.tools[] | {tool, active: [.scopes[].entries[] | select(.status=="active") | .displayPath]}'
```

## Library

```ts
import { resolveReport, renderHtml } from 'rulescope';

const report = resolveReport({ cwd: '/path/to/project', targetFile: 'src/index.ts' });
const html = renderHtml(report);
```

All inputs that change the answer are injectable (`cwd`, `home`, `env`, `platform`), so the resolvers are testable against fixture trees.

## How current are the rules?

The discovery rules follow the official documentation for each tool and carry a date (`rulesVersion` in the output). Each rule has a test that cites the documentation sentence it implements, so when a tool changes behaviour the failing test names the rule. Documentation links are attached to every entry in the HTML report.

Known gaps are reported rather than hidden:

- Cursor User Rules and Team Rules live in the app and dashboard, not on disk.
- Managed settings delivered by MDM or a console apply above everything shown.
- The Claude Code auto-memory directory name is inferred from the project path.
- Nested `.cursor/rules` directories are scanned but labelled unverified.

## Releasing

Add a changeset with `npx changeset`, merge to `main`, and the release workflow opens a version pull request. Merging that pull request publishes to npm through trusted publishing with provenance; no npm token is stored in the repository.

## Development

```bash
npm install
npm run dev -- . --no-color   # run from source
npm test
npm run check                 # typecheck, lint, test, build, publint
```

## License

MIT
