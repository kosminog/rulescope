/**
 * Documentation anchors for every discovery rule the resolvers implement.
 * When a tool changes behaviour, update the rule, its test, and this date.
 */
export const RULES_VERSION = '2026-10-05';

export const DOCS = {
  claude: {
    memory: 'https://code.claude.com/docs/en/memory.md',
    rules: 'https://code.claude.com/docs/en/memory.md#organize-rules-with-claude/rules/',
    skills: 'https://code.claude.com/docs/en/skills.md',
    agents: 'https://code.claude.com/docs/en/sub-agents.md',
    settings: 'https://code.claude.com/docs/en/settings.md',
    mcp: 'https://code.claude.com/docs/en/mcp.md',
    directory: 'https://code.claude.com/docs/en/claude-directory.md',
    plugins: 'https://code.claude.com/docs/en/plugins/install.md',
    outputStyles: 'https://code.claude.com/docs/en/output-styles',
    debug: 'https://code.claude.com/docs/en/debug-your-config.md',
  },
  codex: {
    agentsMd: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md',
    skills: 'https://learn.chatgpt.com/docs/build-skills',
    config: 'https://learn.chatgpt.com/docs/config-file/config-reference',
    nestedIssue: 'https://github.com/openai/codex/issues/12115',
  },
  cursor: {
    rules: 'https://cursor.com/docs/context/rules',
    skills: 'https://cursor.com/docs/context/skills',
    hooks: 'https://cursor.com/docs/hooks',
    subagents: 'https://cursor.com/docs/subagents',
  },
} as const;
