# rulescope

## 0.1.1

### Patch Changes

- b7d2b7e: Fix five resolver and CLI bugs: Claude Code imports that lead a project file outside the project are now reported as trust gated; plugin skills and commands are namespaced as `plugin:name` so they no longer appear shadowed by same-named user skills; `explain` matches files through symlinked directories and accepts `--tool`, `--file`, `--add-dir`, `--codex-profile` and `--depth`; `--depth 0` is honoured and invalid values are rejected; Codex `skills.config` paths starting with `~` expand against the inspected home directory.

## 0.1.0

### Minor Changes

- d88e21e: Initial release: resolve the instruction files, rules, skills and settings that Claude Code, Codex and Cursor load for a directory, with terminal, JSON and HTML output.
