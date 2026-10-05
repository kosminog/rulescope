import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { findGitRoot } from './fs.js';
import type { ResolveOptions } from './model.js';

export interface ResolveContext extends ResolveOptions {
  gitRoot: string | null;
  /** Absolute target file, when given. */
  target: string | null;
  display: (path: string) => string;
}

export type PartialOptions = Partial<ResolveOptions> & { cwd?: string };

export function buildContext(options: PartialOptions = {}): ResolveContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const home = resolve(options.home ?? env.HOME ?? homedir());
  const targetFile = options.targetFile;
  const target = targetFile
    ? isAbsolute(targetFile)
      ? targetFile
      : resolve(cwd, targetFile)
    : null;
  const ctx: ResolveContext = {
    cwd,
    home,
    env,
    platform: options.platform ?? process.platform,
    includeContent: options.includeContent ?? true,
    maxContentBytes: options.maxContentBytes ?? 64 * 1024,
    subdirDepth: options.subdirDepth ?? 4,
    trusted: options.trusted ?? false,
    addDirs: (options.addDirs ?? []).map((d) => resolve(cwd, d)),
    gitRoot: findGitRoot(cwd),
    target,
    display: (path: string) => displayPath(path, cwd, home),
  };
  if (targetFile !== undefined) ctx.targetFile = targetFile;
  if (options.codexProfile !== undefined) ctx.codexProfile = options.codexProfile;
  return ctx;
}

export function displayPath(path: string, cwd: string, home: string): string {
  const p = resolve(path);
  if (p === cwd) return '.';
  if (p.startsWith(cwd + sep)) return relative(cwd, p);
  if (p === home) return '~';
  if (p.startsWith(home + sep)) return '~' + sep + relative(home, p);
  return p;
}
