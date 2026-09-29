# ci

Shared GitHub Actions workflows and actions for HJewkes repos. Each repo's rulesets require one
status check, `check`, and this repo supplies the pieces that make `check` mean something.

| Path | What it is |
|---|---|
| `.github/workflows/node.yml` | Reusable workflow with the standard Node jobs: `secrets`, `audit`, `verify`, `compat` |
| `actions/all-green` | The composite action behind every repo's `check` job |
| `actions/setup` | Composite action that sets up Node and npm or pnpm, restores a cache and installs |
| `fixtures/` | npm, pnpm and pnpm+turbo repos that this repo's CI runs `node.yml` against |

Release workflows arrive in a later release.

## A standard Node repo's `ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  std:
    uses: HJewkes/ci/.github/workflows/node.yml@v1
    with:
      compat-versions: '[22, 24]'

  check:
    if: always()
    needs: [std]
    runs-on: ubuntu-latest
    steps:
      - uses: HJewkes/ci/actions/all-green@v1
        with:
          needs: ${{ toJSON(needs) }}
```

`permissions: contents: read` is the whole grant. `node.yml` needs nothing more, and a called
workflow can never hold more than its caller grants. Keep the `pull_request` trigger free of
`paths` and `branches` filters. A filtered-out workflow never creates `check`, and a required
check that never appears blocks the merge.

`needs: [std]` covers every job inside `node.yml`. The call concludes `success` when each of
its jobs succeeded or was skipped by its own inputs, such as `compat` with no versions. Checks
report as `std / verify`, `std / secrets` and so on. Rulesets require only `check`.

### `node.yml` jobs

| Job | Runs | When |
|---|---|---|
| `secrets` | gitleaks over the repo | unless `secrets-scan: false` |
| `audit` | `<pm> audit --audit-level=<audit-level>` | always |
| `verify` | install, then `setup`, then `<pm> run <verify-script>` on `node-version` | always |
| `compat` | the same as `verify`, once per Node version | when `compat-versions` is set |

### `node.yml` inputs

| Input | Default | Meaning |
|---|---|---|
| `package-manager` | detected | `npm` or `pnpm`. Empty detects it from `pnpm-lock.yaml` or `package-lock.json`. |
| `node-version` | `'22'` | Node version for `audit` and `verify`. |
| `compat-versions` | empty | JSON list such as `'[22, 24]'`. Empty or `'[]'` skips `compat`. |
| `verify-script` | `verify` | Package script that `verify` and `compat` run. |
| `audit-level` | `critical` | Lowest advisory severity that fails `audit`. |
| `audit-omit-dev` | `false` | Audit production dependencies only (`--omit=dev` or `--prod`). |
| `secrets-scan` | `true` | Run gitleaks. |
| `setup` | empty | Shell commands run after install and before the verify script, such as `npx playwright install --with-deps`. |
| `working-directory` | `.` | Repo-relative directory of the package to verify. |

pnpm repos must set `packageManager` in `package.json`, because `pnpm/action-setup` reads the
pnpm version from it.

`node.yml` loads `actions/setup` from its own commit (`job.workflow_sha`), not from a tag, so a
workflow and the setup action it runs always come from the same release. It checks that
helper out under `.git/hjewkes-ci`, where a repo's lint and format tools never look. It cannot
delete the helper instead, because the runner re-reads the action from disk for post-job
cleanup.

### `actions/setup`

Repo-specific jobs (`repo-<name>`) use it after `actions/checkout`:

```yaml
      - uses: HJewkes/ci/actions/setup@v1
        with:
          node-version: '22'
```

Inputs: `node-version` (default `'22'`), `package-manager` (detected), `working-directory`
(`.`) and `install` (`true`). Output: `package-manager`. The cache key includes the exact
Node version as well as the lockfile hash. `setup-node`'s own cache key omits the Node version,
which once let native modules built for one ABI load under another.

## Wiring `check`

Every conforming repo has, in `.github/workflows/ci.yml`, a final job with id `check`. With a
path-filtered job it reads:

```yaml
permissions:
  contents: read

jobs:
  verify:
    # ...
  docs:
    if: needs.changes.outputs.docs == 'true'
    # ...
  check:
    if: always()
    needs: [verify, docs]
    runs-on: ubuntu-latest
    steps:
      - uses: HJewkes/ci/actions/all-green@v1
        with:
          needs: ${{ toJSON(needs) }}
          allow-skipped: docs
```

`if: always()` makes `check` run and report even when a needed job fails, so the required
context always appears on the PR. Without it, a failed dependency skips `check`, and GitHub
treats a skipped required check as passing.

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `needs` | required | Always `${{ toJSON(needs) }}`. A composite action cannot read `needs` itself. |
| `allow-skipped` | empty | Job ids, separated by commas or whitespace, whose `skipped` result counts as passing. |
| `workflow-file` | derived | Repo-relative path of the workflow that defines the calling job. |

### What fails `check`

1. Any needed job whose result is not `success`: `failure`, `cancelled`, or `skipped` for a
   job not in `allow-skipped`.
2. An `allow-skipped` entry that is not in `needs`, so a typo cannot silently excuse nothing.
3. An empty `needs`.
4. Any job in the workflow file, other than the calling job, that is missing from `needs`.
   This self-check stops a job added later from falling outside `check` and gating nothing.

### Why `skipped` fails by default

A skipped job verified nothing. Jobs skip for reasons nobody chose: a mistyped `if:`, a
condition that no longer matches after a refactor, or an upstream job that failed. Counting
`skipped` as passing would let any of those turn a gate off without a red mark. Path-filtered
jobs do skip on purpose, so a repo lists them in `allow-skipped`. That makes each optional
gate an explicit, reviewable line in `ci.yml`. `allow-skipped` never excuses `failure` or
`cancelled`.

### How the self-check finds the workflow file

The action checks out `.github` at `github.workflow_sha` (a sparse, depth-1 checkout into
`.all-green-src`), so it reads the workflow as it ran, not as it is on the default branch. It
takes the file path from `GITHUB_WORKFLOW_REF` (`owner/repo/.github/workflows/ci.yml@ref`) and
the calling job's id from `GITHUB_JOB`. It then reads the top-level keys under `jobs:` with a
small line scanner. The scanner needs no YAML dependency and handles every block-style
workflow in HJewkes repos.

When it cannot find or read the file, `check` fails with an error that says why. It never
passes by skipping the self-check. The cases:

- The checkout fails, for example because the job's token lacks `contents: read`. Grant it.
- The calling job is not in the derived file. This happens when `check` lives inside a
  reusable workflow, because `GITHUB_WORKFLOW_REF` names the top-level caller. Set
  `workflow-file` to the file that defines `check`.
- The file uses flow-style `jobs: { ... }` or a layout the scanner cannot read. Rewrite it in
  block style.

## For callers

Facts found while migrating agent-chat, active-work and herald.

**`std / compat` shows as skipped.** A non-library caller that passes no `compat-versions` sees
this on every PR. It is expected and `check` treats it as passing.

**Put extra offline steps in `verify`.** A pure, offline step, such as an env-var test rerun or
a CLI smoke, belongs in the caller's `verify` script. A separate job costs another install and
is billed as at least one minute.

**Billed minutes.** GitHub rounds each job up to a whole minute. Splitting CI into `verify`,
`secrets`, `audit` and `check` took agent-chat from 2 to 5 billed minutes and active-work from
2 to 6, for about the same wall time. This is free on public repos and about 2.5 to 3x on private
ones. A private caller can pass `secrets-scan: false` and fold the audit into `verify`.

**gitleaks scans a commit range, not history.** On `push` and `pull_request`, gitleaks-action
scans only the event's commit range, even with `fetch-depth: 0`. The pre-migration CI never
scanned full history on PRs either: active-work run 36457573421 logged "1 commits scanned".
Full-history scanning needs a scheduled run, tracked in the CI-standard plan (titan-platform TP-452).

**Private callers and permissions.** `node.yml` pins `permissions: contents: read`, and a
caller cannot raise it. Whether gitleaks on `pull_request` needs `pull-requests: read` in a
private repo is unverified.

**Migrating a repo whose ruleset requires legacy job names.** A `std` call reports as
`std / <job>`, so it cannot keep legacy names. Migrate in stages:

1. Stage (a) keeps the old jobs, adds a `check` job (`all-green`, `needs` every job) and has
   one old job run `verify`. Then switch the ruleset to require `check`.
2. A later PR removes the old jobs.

**Run the audit and tests on main first.** Before stage (a), run the repo's audit and tests on
`main`. herald's lockfile would fail `npm audit` today (2 critical); its last main run passed.

**Name temp directories distinctly.** A caller's `mktemp` naming can collide with its own test
guards. active-work's `aw-test-*` matched the shape its `assertSafeToRemove` guard checks
and failed two tests.

## Pinning

Callers pin the moving major tag: `HJewkes/ci/.github/workflows/node.yml@v1`,
`HJewkes/ci/actions/all-green@v1`, `HJewkes/ci/actions/setup@v1`.

- `v1` moves only to a commit on `main` whose own CI is green, and only the owner moves it.
- `vX.Y.Z` tags are immutable. A tag ruleset forbids updating or deleting them.
- A breaking change ships as `v2`. Callers move to it in their own PRs.

Third-party actions inside this repo are pinned by full commit SHA with a version comment.

## Node

The standard Node version is 22. Repos that publish a library add a `compat` matrix of
`[22, 24]`. Node 20 is dropped from the standard.

The exception is `all-green` itself. It runs on the runner's preinstalled `node` to avoid a
setup step in every `check` job, so its script uses only Node 20 APIs and this repo's CI tests
it on 20, 22 and 24.

## Developing

```sh
npm run verify
```

`verify` runs the `node:test` suite. The tests need no dependencies, so there is no lockfile or
install step, and the same command runs locally and in CI.

CI also calls `node.yml` against each fixture as a `repo-fixture-*` job. The fixtures'
`verify` scripts run offline `node:test` suites, and the pnpm+turbo fixture resolves a
workspace dependency through `turbo run test`. To change a fixture's dependencies, run
`npm install` or `pnpm install` inside it and commit the lockfile.
