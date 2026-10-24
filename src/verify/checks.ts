// Check config: parse CLI flags into frozen CheckConfig/InstallConfig (D44, C9).
// Commands come only from user-owned config — never from tool arguments, packs,
// knowledge, prompts or the agent.
import { CheckConfig, InstallConfig } from '../schema/verify.js';

export interface ChecksConfig {
  readonly install: readonly InstallConfig[];
  readonly checks: readonly CheckConfig[];
}

/**
 * Parse shell-word argv from a string like `npm test` or `sh -c "npm test"`.
 * Handles single and double quotes and backslash escapes. No subshell expansion.
 */
export function parseArgv(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (inSingle) {
      if (ch === "'") { inSingle = false; }
      else { current += ch; }
    } else if (inDouble) {
      if (ch === '"') { inDouble = false; }
      else if (ch === '\\' && i + 1 < raw.length) { current += raw[++i]!; }
      else { current += ch; }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '\\' && i + 1 < raw.length) {
      current += raw[++i]!;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) { args.push(current); current = ''; }
    } else {
      current += ch;
    }
    i++;
  }
  if (current.length > 0) args.push(current);
  return args;
}

/**
 * Parse `--install "<cmd>"` flags (repeated), `--check <name>="<cmd>"` flags,
 * and `--junit <check>=<path>` flags. Returns a frozen ChecksConfig. Called
 * once at startup (D44).
 *
 * @param installRaw  Values of repeated `--install` flags.
 * @param checkRaw    Values of repeated `--check` flags, each `name=cmd` or `name="cmd"`.
 * @param junitRaw    Values of repeated `--junit` flags, each `check=path` (path relative to sandbox root).
 */
export function parseChecksConfig(installRaw: string[], checkRaw: string[], junitRaw: string[] = []): ChecksConfig {
  const install: InstallConfig[] = installRaw.map((raw) => {
    const argv = parseArgv(raw.trim());
    if (argv.length === 0) throw new Error(`--install value is empty`);
    return InstallConfig.parse({ argv });
  });

  // Build the junit path map first.
  const junitByCheck = new Map<string, string>();
  for (const raw of junitRaw) {
    const eq = raw.indexOf('=');
    if (eq < 1) throw new Error(`--junit must be check=path, got: ${raw}`);
    const check = raw.slice(0, eq).trim();
    const p = raw.slice(eq + 1).trim();
    if (!check || !p) throw new Error(`--junit needs a check name and a path: ${raw}`);
    junitByCheck.set(check, p);
  }

  const checks: CheckConfig[] = checkRaw.map((raw) => {
    const eq = raw.indexOf('=');
    if (eq < 1) throw new Error(`--check must be name=cmd, got: ${raw}`);
    const name = raw.slice(0, eq).trim();
    const cmd = raw.slice(eq + 1).trim();
    if (!name) throw new Error(`--check name is empty in: ${raw}`);
    const argv = parseArgv(cmd);
    if (argv.length === 0) throw new Error(`--check command is empty for: ${name}`);
    const junit = junitByCheck.get(name);
    return CheckConfig.parse({ name, argv, ...(junit ? { junit_path: junit } : {}) });
  });

  // A --junit for a check that does not exist is a config error.
  for (const check of junitByCheck.keys()) {
    if (!checks.some((c) => c.name === check)) throw new Error(`--junit names an unknown check: ${check}`);
  }

  return Object.freeze({ install: Object.freeze(install), checks: Object.freeze(checks) });
}

/** An empty config (no install, no checks). Used when --level 0. */
export const EMPTY_CHECKS: ChecksConfig = Object.freeze({ install: Object.freeze([]), checks: Object.freeze([]) });

/** Snippet `checks:` values, already split into the install command and named checks. */
export interface SnippetCheckSource {
  readonly install: readonly string[];
  readonly named: readonly { readonly name: string; readonly command: string }[];
}

/**
 * The same argv parse as the CLI flags. `install` is one command string; each
 * other snippet key is `name=command`. Throws on an empty command, as the flags do.
 */
export function checksConfigFromSnippet(source: SnippetCheckSource): ChecksConfig {
  return parseChecksConfig(
    [...source.install],
    source.named.map((c) => `${c.name}=${c.command}`),
  );
}

export type CheckSourceDecision = 'cli' | 'snippet' | 'snippet_ignored' | 'none';

/**
 * CLI flags win as a whole set. The snippet is used only when the process was
 * started with `--trust-repo-checks` and no `--install` or `--check` flag.
 * Otherwise the snippet is ignored. Never merges the two (D58, INV-8).
 */
export function selectChecksConfig(args: {
  cli: ChecksConfig;
  cliProvided: boolean;
  snippet: ChecksConfig | null;
  trustRepoChecks: boolean;
}): { config: ChecksConfig; decision: CheckSourceDecision } {
  const snippetHasCommands = args.snippet !== null && (args.snippet.install.length > 0 || args.snippet.checks.length > 0);
  if (args.cliProvided) return { config: args.cli, decision: snippetHasCommands ? 'cli' : 'none' };
  if (snippetHasCommands) {
    if (args.trustRepoChecks) return { config: args.snippet!, decision: 'snippet' };
    return { config: args.cli, decision: 'snippet_ignored' };
  }
  return { config: args.cli, decision: 'none' };
}
