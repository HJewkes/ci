// Runs on the runner's preinstalled Node, so it uses only APIs available in Node 20.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIPPED_DIRS = new Set(['node_modules', '.worktrees', '.git']);
const CONFIG_NAME = /^vitest\.(config|workspace|projects)\.[cm]?[jt]s$/;
const ALLOW_COMMENT = /vitest-pool:\s*forks\s+\S/;
const THREAD_POOLS = new Set(['threads', 'vmThreads']);
const OPENERS = { '{': '}', '[': ']', '(': ')' };

export function findConfigs(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) visit(join(dir, entry.name));
      else if (entry.isFile() && CONFIG_NAME.test(entry.name)) found.push(join(dir, entry.name));
    }
  };
  visit(root);
  return found.sort();
}

// Blanks comments and string contents, keeping every offset, so structure scans ignore them.
export function mask(text) {
  const out = [...text];
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (/['"`]/.test(text[i])) {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

function closerOf(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (OPENERS[masked[i]]) depth++;
    else if (')]}'.includes(masked[i]) && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(masked, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (OPENERS[masked[i]]) depth++;
    else if (')]}'.includes(masked[i])) depth--;
    else if (masked[i] === ',' && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts.filter(([a, b]) => masked.slice(a, b).trim() !== '');
}

function projectsArray(masked, isWorkspaceFile) {
  const patterns = [/\bprojects\s*:\s*\[/];
  if (isWorkspaceFile) patterns.push(/\bdefineWorkspace\s*\(\s*\[/, /\bexport\s+default\s*\[/);
  for (const pattern of patterns) {
    const match = pattern.exec(masked);
    if (!match) continue;
    const open = match.index + match[0].length - 1;
    const close = closerOf(masked, open);
    if (close !== -1) return { open, close };
  }
  return undefined;
}

function poolIn(masked, text, [from, to]) {
  const match = /\bpool\s*:/.exec(masked.slice(from, to));
  if (!match) return undefined;
  const at = from + match.index;
  const value = /^\s*(['"])([A-Za-z]+)\1/.exec(text.slice(at + match[0].length));
  return { at, value: value?.[2] };
}

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

export function hasAllowComment(lines, lineNumber) {
  if (ALLOW_COMMENT.test(lines[lineNumber - 1])) return true;
  for (let n = lineNumber - 1; n >= 1; n--) {
    const line = lines[n - 1].trim();
    if (!/^(\/\/|\/\*|\*)/.test(line)) return false;
    if (ALLOW_COMMENT.test(line)) return true;
  }
  return false;
}

function capIn(masked, [from, to]) {
  return /\b(maxThreads|maxWorkers)\s*:/.test(masked.slice(from, to));
}

function blankRange(masked, open, close) {
  return masked.slice(0, open) + masked.slice(open, close + 1).replace(/[^\n]/g, ' ') + masked.slice(close + 1);
}

export function analyzeConfig(text, { workspaceFile = false } = {}) {
  const masked = mask(text);
  const lines = text.split('\n');
  const array = projectsArray(masked, workspaceFile);
  const rootMasked = array ? blankRange(masked, array.open, array.close) : masked;
  const whole = [0, text.length];
  const rootPool = workspaceFile ? undefined : poolIn(rootMasked, text, whole);
  const projects = array
    ? splitTopLevel(masked, array.open + 1, array.close).filter(([a]) => masked.slice(a).trimStart()[0] === '{')
    : [];
  const units = [];
  if (!workspaceFile) units.push({ label: 'root', range: whole, masked: rootMasked, pool: rootPool, isRoot: true });
  for (const range of projects) {
    const pool = poolIn(masked, text, range);
    const extendsRoot = /\bextends\s*:\s*true\b/.test(masked.slice(...range));
    const line = lineOf(text, range[0] + masked.slice(...range).search(/\S/));
    units.push({ label: `project at line ${line}`, line, range, masked, pool, extendsRoot });
  }
  return { text, lines, units, rootPool, hasProjects: projects.length > 0, rootCap: capIn(rootMasked, whole) };
}

function judge(unit, analysis, sibling) {
  const { pool } = unit;
  const where = pool ? lineOf(analysis.text, pool.at) : (unit.line ?? 1);
  const fail = (message) => ({ line: where, message: `${unit.label}: ${message}` });
  if (!pool) {
    if (unit.isRoot) return analysis.hasProjects || sibling.workspace ? undefined : fail('pool is unset; vitest defaults to forks');
    if (unit.extendsRoot && analysis.rootPool) return undefined;
    return fail('pool is unset; vitest defaults to forks');
  }
  if (!pool.value) return fail('pool is not a string literal the check can read');
  if (THREAD_POOLS.has(pool.value)) {
    const capped = analysis.rootCap || sibling.cap;
    return capped ? undefined : fail(`pool "${pool.value}" has no maxThreads or maxWorkers cap`);
  }
  if (hasAllowComment(analysis.lines, where)) return undefined;
  return fail(`pool "${pool.value}" needs a "// vitest-pool: forks <reason>" comment on or above the pool line`);
}

export function checkFiles(files, readFile = (file) => readFileSync(file, 'utf8')) {
  const analyses = files.map((file) => {
    const workspaceFile = /vitest\.(workspace|projects)\./.test(file);
    return { file, workspaceFile, analysis: analyzeConfig(readFile(file), { workspaceFile }) };
  });
  const problems = [];
  for (const { file, analysis } of analyses) {
    const siblings = analyses.filter((other) => other.file !== file && dirname(other.file) === dirname(file));
    const sibling = { cap: siblings.some((other) => other.analysis.rootCap), workspace: siblings.some((other) => other.workspaceFile) };
    for (const unit of analysis.units) {
      const problem = judge(unit, analysis, sibling);
      if (problem) problems.push({ file, ...problem });
    }
  }
  return problems;
}

export function run(root, readFile) {
  const files = findConfigs(root);
  const problems = checkFiles(files, readFile);
  return { files, problems };
}

function main(root) {
  const { files, problems } = run(root);
  if (files.length === 0) console.log('vitest-pool: no vitest config found, nothing to check');
  for (const file of files) console.log(`vitest-pool: checked ${relative(root, file)}`);
  for (const { file, line, message } of problems) {
    const path = relative(root, file);
    console.log(`::error file=${path},line=${line},title=vitest-pool::${message}`);
    console.log(`${path}:${line}: ${message}`);
  }
  if (problems.length > 0) process.exit(1);
}

// Compares real paths so a symlinked entry (macOS $TMPDIR, a linked checkout) still runs main.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main(process.argv[2] ?? '.');
