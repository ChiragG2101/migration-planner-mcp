// The AGENTS.md snippet (M10 task 4, D58). Only the fenced block under
// `## migration-planner` is read, through SafePath. The rest of the file is
// ignored. Deny entries can only add. Checks are parsed here and selected
// later; they are never taken from a tool argument.
import { addUserDenies } from '../security/denyList.js';
import { PermissionError } from '../security/errors.js';
import { resolveInside } from '../security/pathBoundary.js';
import { readText } from '../security/safeRead.js';
import type { Question } from '../schema/ingest.js';
import { checksConfigFromSnippet, type ChecksConfig, type SnippetCheckSource } from '../verify/checks.js';

export const SNIPPET_HEADING = 'migration-planner';
export const SNIPPET_NOT_FOUND = 'AGENTS.md snippet: not found';

export interface AgentsSnippetResult {
  /** The fenced block was present and parsed. A missing file is false. */
  readonly found: boolean;
  readonly denyAdded: readonly string[];
  /** Null when the block names no install and no check, or the block was rejected. */
  readonly checks: ChecksConfig | null;
  readonly targets: readonly string[];
}

const EMPTY: AgentsSnippetResult = { found: false, denyAdded: [], checks: null, targets: [] };

/** The first fenced block in `section`, or null when there is none. */
export function fencedBlock(section: string): string | null {
  const lines = section.split(/\r?\n/);
  let start = -1;
  let marker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (start < 0) {
      const open = /^(```+|~~~+)/.exec(line);
      if (open) {
        start = i;
        marker = open[1]!;
      }
      continue;
    }
    if (line.trim() === marker) return lines.slice(start + 1, i).join('\n');
  }
  return null;
}

/** Lines under `## migration-planner`, up to the next `## ` heading. */
export function sectionUnderHeading(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const head = `## ${SNIPPET_HEADING}`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === head) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) break;
    out.push(lines[i]!);
  }
  return out.join('\n');
}

function unquote(raw: string): string | null {
  const s = raw.trim();
  if (s === '' || s === '|' || s === '>' || s === '[]' || s === '{}') return null;
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if (s.startsWith('"') || s.startsWith("'") || s.startsWith('[') || s.startsWith('{') || s.startsWith('|') || s.startsWith('>')) return null;
  return s;
}

interface ParsedBlock {
  checks: SnippetCheckSource | null;
  deny: string[];
  targets: string[];
}

/**
 * A two-space YAML subset: three top-level keys, scalar maps and scalar lists.
 * Unknown top-level keys and their nested lines are skipped. Anything else
 * rejects the whole block, so a half-parsed file never applies.
 */
export function parseSnippetBlock(body: string): { block: ParsedBlock } | { error: string } {
  const install: string[] = [];
  const named: { name: string; command: string }[] = [];
  const deny: string[] = [];
  const targets: string[] = [];
  let sawChecks = false;
  let section: 'checks' | 'deny' | 'targets' | 'skip' | null = null;
  const seen = new Set<string>();
  const lines = body.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (line.includes('\t')) return { error: `line ${n + 1}: tabs are not allowed` };
    const indent = /^ */.exec(line)![0].length;
    const rest = line.slice(indent);
    if (indent === 0) {
      const key = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(rest);
      if (!key) return { error: `line ${n + 1}: expected a key` };
      if (key[2]!.trim() !== '') return { error: `line ${n + 1}: ${key[1]} must be a block, not a one-line value` };
      if (key[1] === 'checks' || key[1] === 'planner_deny' || key[1] === 'targets') {
        if (seen.has(key[1])) return { error: `line ${n + 1}: duplicate key ${key[1]}` };
        seen.add(key[1]);
        section = key[1] === 'planner_deny' ? 'deny' : key[1] === 'targets' ? 'targets' : 'checks';
        if (key[1] === 'checks') sawChecks = true;
      } else {
        section = 'skip';
      }
      continue;
    }
    if (section === 'skip' || section === null) continue;
    if (indent !== 2) return { error: `line ${n + 1}: only two-space nesting is accepted` };
    if (section === 'deny' || section === 'targets') {
      const item = /^- (.*)$/.exec(rest);
      if (!item) return { error: `line ${n + 1}: expected a list item` };
      const value = unquote(item[1]!);
      if (value === null || value.trim() === '') return { error: `line ${n + 1}: empty list item` };
      (section === 'deny' ? deny : targets).push(value.trim());
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(rest);
    if (!kv) return { error: `line ${n + 1}: expected a check name and a command` };
    const command = unquote(kv[2] ?? '');
    if (command === null || command.trim() === '') return { error: `line ${n + 1}: empty command for ${kv[1]}` };
    if (kv[1] === 'install') install.push(command.trim());
    else named.push({ name: kv[1]!, command: command.trim() });
  }
  return { block: { checks: sawChecks ? { install, named } : null, deny, targets } };
}

const TARGET_RE = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9][A-Za-z0-9.+_-]*)$/;

/** `name@version` as written. A value that does not match is rejected by the caller. */
export function parseTargetRef(value: string): { name: string; version: string } | null {
  const m = TARGET_RE.exec(value.trim());
  if (!m) return null;
  return { name: m[1]!, version: m[2]! };
}

/** Every part of the snippet version equals the requested version, so `16` matches `16.2.0`. */
function versionCovers(declared: string, requested: string): boolean {
  const g = declared.replace(/^(v|==)/, '').split('.');
  const r = requested.replace(/^(v|==)/, '').split('.');
  return g.every((part, i) => part === r[i]);
}

/**
 * A question when no snippet target covers the request. Null when the block
 * lists no usable targets or one of them matches. Never rewrites the request.
 */
export function snippetTargetQuestion(requested: { name: string; version: string }, targets: readonly string[]): Question | null {
  if (targets.length === 0) return null;
  const hit = targets.some((t) => {
    const parsed = parseTargetRef(t);
    return parsed !== null && parsed.name === requested.name && versionCovers(parsed.version, requested.version);
  });
  if (hit) return null;
  return {
    kind: 'ambiguous_target',
    field: 'target',
    message: `AGENTS.md snippet targets ${targets.join(', ')}, which does not match ${requested.name}@${requested.version}. The snippet does not change the request. Pass confirm_target: true to plan ${requested.name}@${requested.version}.`,
    candidates: targets.map((value) => ({ value, where: ['AGENTS.md'] })),
  };
}

function readAgentsFile(root: string, repoId: string): string | null {
  const sp = resolveInside(root, 'AGENTS.md', repoId);
  try {
    return readText(sp);
  } catch (err) {
    if (err instanceof PermissionError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Reads the snippet, adds the deny globs that pass, and returns the checks
 * and targets. Logs the fixed absence line when the file or the block is
 * missing. A bad block is logged and applied as nothing.
 */
export function applyAgentsSnippet(root: string, repoId: string, log: (message: string) => void): AgentsSnippetResult {
  const text = readAgentsFile(root, repoId);
  if (text === null) {
    log(SNIPPET_NOT_FOUND);
    return EMPTY;
  }
  const section = sectionUnderHeading(text);
  const body = section === null ? null : fencedBlock(section);
  if (body === null) {
    log(SNIPPET_NOT_FOUND);
    return EMPTY;
  }
  const parsed = parseSnippetBlock(body);
  if ('error' in parsed) {
    log(`AGENTS.md snippet: rejected (${parsed.error})`);
    return EMPTY;
  }
  const { added, rejected } = addUserDenies(parsed.block.deny);
  for (const r of rejected) log(`AGENTS.md snippet: rejected planner_deny "${r.glob}" (${r.reason})`);
  const targets: string[] = [];
  for (const value of parsed.block.targets) {
    if (parseTargetRef(value)) targets.push(value);
    else log(`AGENTS.md snippet: rejected target "${value}" (expected name@version)`);
  }
  let checks: ChecksConfig | null = null;
  if (parsed.block.checks && (parsed.block.checks.install.length > 0 || parsed.block.checks.named.length > 0)) {
    try {
      checks = checksConfigFromSnippet(parsed.block.checks);
    } catch (err) {
      log(`AGENTS.md snippet: rejected checks (${err instanceof Error ? err.message : String(err)})`);
      checks = null;
    }
    log('AGENTS.md snippet checks:');
    for (const cmd of parsed.block.checks.install) log(`  install: ${cmd}`);
    for (const c of parsed.block.checks.named) log(`  ${c.name}: ${c.command}`);
  }
  return { found: true, denyAdded: added, checks, targets };
}
