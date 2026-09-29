// Runs on the runner's preinstalled Node, so it uses only APIs available in Node 20.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const JOB_KEY = /^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*:(\s|$)/;
const JOBS_KEY = /^jobs\s*:\s*(#.*)?$/;

export function parseList(text) {
  return (text ?? '').split(/[\s,]+/).filter(Boolean);
}

export function parseNeeds(json) {
  let needs;
  try {
    needs = JSON.parse(json);
  } catch {
    throw new Error('input "needs" is not JSON; pass ${{ toJSON(needs) }}');
  }
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    throw new Error('input "needs" must be a JSON object; pass ${{ toJSON(needs) }}');
  }
  return needs;
}

export function evaluateResults(needs, allowSkipped) {
  const problems = [];
  const names = Object.keys(needs);
  if (names.length === 0) problems.push('needs is empty: check gates nothing');
  for (const name of allowSkipped) {
    if (!names.includes(name)) problems.push(`allow-skipped names "${name}", which is not in needs`);
  }
  for (const name of names) {
    const result = needs[name]?.result;
    if (result === 'success') continue;
    if (result === 'skipped' && allowSkipped.includes(name)) continue;
    problems.push(`job "${name}" concluded "${result}"`);
  }
  return problems;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isContent(line) {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith('#');
}

export function parseJobIds(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((line) => JOBS_KEY.test(line));
  if (start === -1) throw new Error('no top-level block-style "jobs:" key found');
  const ids = [];
  let childIndent;
  for (const line of lines.slice(start + 1)) {
    if (!isContent(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    childIndent ??= indent;
    if (indent > childIndent) continue;
    const match = line.trimStart().match(JOB_KEY);
    if (indent < childIndent || !match) throw new Error(`cannot read job id from line: ${line.trim()}`);
    ids.push(match[2]);
  }
  if (ids.length === 0) throw new Error('"jobs:" has no job ids');
  return ids;
}

export function workflowPathFromRef(workflowRef) {
  const match = /^[^/]+\/[^/]+\/(.+)@[^@]*$/.exec(workflowRef ?? '');
  if (!match) throw new Error(`cannot derive the workflow file from GITHUB_WORKFLOW_REF "${workflowRef}"`);
  return match[1];
}

export function findUncoveredJobs(jobIds, needs, selfJob) {
  return jobIds.filter((id) => id !== selfJob && !(id in needs));
}

export function selfCheck({ needs, selfJob, workflowFile, readWorkflow }) {
  const jobIds = parseJobIds(readWorkflow(workflowFile));
  if (!jobIds.includes(selfJob)) {
    return [`job "${selfJob}" is not in ${workflowFile}; set input "workflow-file" to the file that defines it`];
  }
  return findUncoveredJobs(jobIds, needs, selfJob).map(
    (id) => `job "${id}" in ${workflowFile} is missing from ${selfJob}.needs, so it gates nothing`,
  );
}

function jobWorkflow(env) {
  const { JOB_WORKFLOW_REPOSITORY: repository, JOB_WORKFLOW_SHA: ref, JOB_WORKFLOW_FILE_PATH: file } = env;
  return repository && ref && file ? { repository, ref, file } : undefined;
}

function workflowFileOf(env, fromJob) {
  if (env.WORKFLOW_FILE) return { file: env.WORKFLOW_FILE, origin: 'input workflow-file' };
  if (fromJob) return { file: fromJob.file, origin: 'job.workflow_file_path' };
  return { file: workflowPathFromRef(env.GITHUB_WORKFLOW_REF), origin: 'GITHUB_WORKFLOW_REF' };
}

export function resolveSource(env) {
  const fromJob = jobWorkflow(env);
  const repository = fromJob?.repository ?? env.GITHUB_REPOSITORY;
  const ref = fromJob?.ref ?? env.GITHUB_WORKFLOW_SHA;
  const source = { repository, ref, ...workflowFileOf(env, fromJob) };
  for (const key of ['repository', 'ref', 'file']) {
    if (!source[key] || /[\r\n]/.test(source[key])) {
      throw new Error(`cannot resolve the workflow ${key}: got ${JSON.stringify(source[key])}`);
    }
  }
  return source;
}

export function describeSource({ repository, ref, file, origin }) {
  return `all-green: reading ${file} (from ${origin}) at ${repository}@${ref}`;
}

export function run(env, readFile) {
  const needs = parseNeeds(env.NEEDS_JSON);
  const workflowFile = workflowFileOf(env, jobWorkflow(env)).file;
  const readWorkflow = (file) => readFile(join(env.WORKFLOW_ROOT ?? '.', file));
  return [
    ...evaluateResults(needs, parseList(env.ALLOW_SKIPPED)),
    ...selfCheck({ needs, selfJob: env.GITHUB_JOB, workflowFile, readWorkflow }),
  ];
}

function writeSource() {
  const source = resolveSource(process.env);
  console.log(describeSource(source));
  const lines = [`repository=${source.repository}`, `ref=${source.ref}`, `workflow-file=${source.file}`];
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  return [];
}

function evaluate() {
  const problems = run(process.env, (file) => readFileSync(file, 'utf8'));
  if (problems.length === 0) console.log('all-green: every needed job passed and needs covers every job');
  return problems;
}

function main(mode) {
  let problems;
  try {
    problems = mode === 'resolve' ? writeSource() : evaluate();
  } catch (error) {
    problems = [error.message];
  }
  for (const problem of problems) console.log(`::error title=all-green::${problem}`);
  if (problems.length > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2]);
