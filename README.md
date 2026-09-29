# ci

Shared GitHub Actions workflows and actions for HJewkes repos. Each repo's rulesets require one
status check, `check`, and this repo supplies the pieces that make `check` mean something.

| Path | What it is |
|---|---|
| `.github/workflows/node.yml` | Reusable workflow with the standard Node jobs: `secrets`, `audit`, `verify`, `compat` |
| `.github/workflows/secrets-full.yml` | Reusable workflow that runs gitleaks over a repo's full git history, for a scheduled caller |
| `.github/workflows/release-tag.yml` | Reusable workflow that creates an annotated version tag and a GitHub release |
| `.github/workflows/release-changesets.yml` | Reusable workflow for the changesets flow: a Version Packages PR, then an npm publish |
| `actions/all-green` | The composite action behind every repo's `check` job |
| `actions/setup` | Composite action that sets up Node and npm or pnpm, restores a cache and installs |
| `fixtures/` | npm, pnpm, pnpm+turbo and changesets repos that this repo's CI runs the workflows against |

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
| `workflow-file` | derived | Path under `.github/workflows/` of the workflow that defines the calling job. Overrides the derived path. |

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

The action reads the workflow file that defines the calling job, at the commit it ran from.
It takes the repo, commit and path from `job.workflow_repository`, `job.workflow_sha` and
`job.workflow_file_path`. For a `check` job inside a reusable workflow, these name the reusable
workflow's own file, so it needs no `workflow-file` input. Where the runner sets none of the
three, as on GitHub Enterprise Server, it falls back to the running repo at
`github.workflow_sha` and the path in `GITHUB_WORKFLOW_REF`, which names the top-level caller.
A `workflow-file` input replaces the path from either source. The step log names the source,
for example `all-green: reading .github/workflows/ci.yml (from job.workflow_file_path) at
HJewkes/ci@<sha>`.

It checks out `.github` from that repo and commit (a sparse, depth-1 checkout into
`.all-green-src`), so it reads the workflow as it ran, not as it is on the default branch. It
takes the calling job's id from `GITHUB_JOB`. It then reads the top-level keys under `jobs:`
with a small line scanner. The scanner needs no YAML dependency and handles every block-style
workflow in HJewkes repos.

When it cannot find or read the file, `check` fails with an error that says why. It never
passes by skipping the self-check. The cases:

- The checkout fails, for example because the job's token lacks `contents: read`. Grant it.
- The repo, commit or path cannot be resolved, for example because `GITHUB_WORKFLOW_REF` is
  missing on a runner without `job.workflow_*`.
- The runner sets only some of the three `job.workflow_*` values. The error names the missing
  ones. The action does not fall back, because a partial set would self-check the wrong file.
- The path, from any source, is not under `.github/workflows/` or has a `..` segment. This
  keeps the self-check from reading any file other than a workflow.
- The calling job is not in the file it read. On a runner without `job.workflow_*`, this
  happens when `check` lives inside a reusable workflow. Set `workflow-file` to the file that
  defines `check`.
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
Full-history scanning needs a scheduled run of `secrets-full.yml`, described in
[Full-history secret scan](#full-history-secret-scan).

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

## Full-history secret scan

`secrets-full.yml` scans every commit on every branch and tag with gitleaks. It is not a PR
gate: keep it out of `ci.yml` and out of `check`. Call it from its own workflow, such as
`.github/workflows/secrets-full.yml` in the caller:

```yaml
name: secrets-full

on:
  schedule:
    - cron: '17 6 * * 1'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  secrets-full:
    uses: HJewkes/ci/.github/workflows/secrets-full.yml@v1
```

This runs every Monday at 06:17 UTC, and `workflow_dispatch` adds a manual "Run workflow"
button. A called workflow sees its caller's event, and gitleaks-action picks the commit range
from that event. On `schedule` and `workflow_dispatch` it passes no range, so gitleaks runs
`git log -p -U0 --full-history --all` over a `fetch-depth: 0` checkout. On any other event the
workflow fails at once rather than scan a range and look green.

`contents: read` should be enough for private callers too, though only this public repo has run
it. The checkout needs that grant. gitleaks-action reads only the public owner profile and
uploads its SARIF report with the runner's artifact token, which needs no grant. GitHub disables `schedule` in a repo with
no activity for 60 days, so a quiet repo's scan can stop without a failure.

This repo's `secrets-full fixture` workflow calls it on `workflow_dispatch`.

## Releases

Two reusable workflows cover the two release shapes in HJewkes repos. Neither pushes to the
default branch. Each has a `dry-run` input, default `false`. A dry run does every read, prints
what a real run would write, and stops. Its `release` job shows as skipped. Both split into
a read-only `plan` job and a `release` job that holds the write grants. Only `plan` is
isolated: its install, `setup` and verify scripts run with a read-only `GITHUB_TOKEN` and no
`id-token`. The `release` job's own install and scripts do not get that isolation, as
described for each workflow below.

A caller must grant every permission the `release` job requests, even for a dry run. GitHub
checks the grants when the run starts, before `dry-run` can skip the job.

### `release-tag.yml`

Creates an annotated tag at the triggering commit (`github.sha`) and a GitHub release with
generated notes. A version with a `-` suffix, such as `1.2.0-rc.1`, becomes a prerelease. The
workflow fails if the tag already exists.

```yaml
name: release-tag

on:
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: true

permissions:
  contents: read

jobs:
  release:
    permissions:
      contents: write
    uses: HJewkes/ci/.github/workflows/release-tag.yml@v1
    with:
      dry-run: ${{ inputs.dry-run }}
```

| Input | Default | Meaning |
|---|---|---|
| `version` | from `package.json` | Version without the prefix. Empty reads `version` from `package.json` in `working-directory`. |
| `tag-prefix` | `v` | Joined to the version to form the tag. |
| `working-directory` | `.` | Directory whose `package.json` supplies the version. |
| `dry-run` | `false` | Print the tag and release, then stop before any write. |

Outputs: `tag` and `version`. Needs `contents: write` and no secrets.

Setup and limits:

- The tag is pushed with `GITHUB_TOKEN`, and GitHub starts no workflow for a push made with
  that token. A repo whose `on: push: tags` workflow publishes to npm will not see this tag.
  Publish in a later job of the same caller instead, with `needs: release`.
- A tag ruleset that restricts tag creation blocks the push unless it lets GitHub Actions
  create tags. Rulesets that only forbid updating or deleting tags are fine.
- Gate it on CI by adding `needs:` on a `node.yml` job in the same caller.
- If the tag push succeeds and `gh release create` then fails, the tag exists without a
  release, and a rerun fails on the existing tag. Recover by hand once the cause is fixed:
  `gh release create v1.2.3 --verify-tag --title v1.2.3 --generate-notes`, adding
  `--prerelease` for a `-` version. Do not delete the tag.

### `release-changesets.yml`

Runs `changesets/action` on a push to the release branch. With pending changesets, it opens or
updates the "Version Packages" PR from `changeset-release/<branch>`. With none, which is the
state after that PR merges, it runs the publish script. A GitHub App token pushes the PR
branch, so the PR's own CI runs without manual approval (TP-447). npm publishing uses trusted
publishing (OIDC) and no npm token.

```yaml
name: release

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  release:
    permissions:
      contents: read
      id-token: write
    uses: HJewkes/ci/.github/workflows/release-changesets.yml@v1
    with:
      app-client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}
      version-script: pnpm version-packages
      publish-script: pnpm release
    secrets:
      app-private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

| Input | Default | Meaning |
|---|---|---|
| `package-manager` | detected | `npm` or `pnpm`, as in `node.yml`. |
| `node-version` | `'22'` | Node version. Trusted publishing needs 22.14 or later. |
| `verify-script` | `verify` | Package script the `plan` job runs first. Empty skips it. |
| `setup` | empty | Shell commands the `plan` job runs after install and before verify. |
| `version-script` | `<pm> exec changeset version` | Command that versions packages for the PR. |
| `publish-script` | `<pm> exec changeset publish` | Command that builds and publishes. It must build what it publishes, because the `release` job does not run `setup`. |
| `pr-title` | `Version Packages` | Title of the Version Packages PR. |
| `commit-message` | `Version Packages` | Commit message on the PR branch. |
| `app-client-id` | empty | Client ID of the release App. Required unless `dry-run`. |
| `working-directory` | `.` | Directory holding `.changeset/` and the root `package.json`. |
| `dry-run` | `false` | Verify and print the plan, then stop before any write. |

Secret: `app-private-key`, the release App's private key, required unless `dry-run`.

In the `plan` job a dry run with pending changesets runs `version-script` on its own
checkout and prints the changed files and versions. The checkout stores no credentials and
the job's `GITHUB_TOKEN` is read-only, so nothing can be pushed. A real run fails at once if
the App client ID or key is missing.

The caller grants only `contents: read` and `id-token: write`. Every GitHub write in the
`release` job uses the App token: the Version Packages branch, its commits, the release tags
and the GitHub releases. `GITHUB_TOKEN` stays read-only. The job's checkout uses
`persist-credentials: false`. In `github-api` mode `changesets/action` pushes through the API,
not git.

What runs with what in the `release` job:

- The install runs lifecycle scripts, with `id-token` available. No App token exists yet.
- `changesets/action` writes the App token to `~/.netrc` and passes it as `GITHUB_TOKEN` to
  `version-script` and `publish-script`. Those scripts, and any lifecycle scripts they
  trigger, run with the App token and `id-token`.

So a dependency's install script in the `release` job can mint an OIDC token, and the
version and publish scripts can use the App token. The App's grant is limited to contents and
pull-requests on the repos it is installed on, and rulesets without a bypass stop it merging.

**Protect the default branch.** A branch protection rule or ruleset on the caller's default
branch is required. The App holds `contents: write`, so without one it can push straight to
the default branch, and so can anything that runs with its token (see the list above).

**Tags can fail silently.** `changesets/action` creates each release tag with the API
(`createRef`) and, if that call fails, logs only a warning. A tag ruleset that restricts tag
creation therefore lets a release finish green with the package published and no tag. Add the
release App to the ruleset's bypass list, or check that the tag exists after each release.

Commits on the PR branch go through the GitHub API (`commitMode: github-api`). GitHub signs
them and attributes them to the App rather than to `github-actions[bot]`. TP-447 found that
titan-platform's ruleset still needs the owner's review for unattributed commits. Whether App
attribution clears that is unverified until the first real Version Packages PR.

**Owner setup, once per caller repo.** An agent cannot do these steps.

1. Create a GitHub App (proposed name `hjewkes-release-bot`) with repository permissions
   Contents: read and write, and Pull requests: read and write, and no webhook. Install it
   only on the repos that release through this workflow.
2. In each caller repo, add the variable `RELEASE_APP_CLIENT_ID` (the App's client ID) and
   the secret `RELEASE_APP_PRIVATE_KEY` (a private key generated on the App's page).
3. On npmjs.com, add a trusted publisher to every package the repo publishes: repository
   `HJewkes/<repo>` and the **caller's** workflow filename, such as `release.yml`. npm checks
   the top-level workflow, not `release-changesets.yml`. A repo that already has a trusted
   publisher for `release.yml` needs no change if the caller keeps that filename. A
   brand-new package needs its first version published by hand before npm accepts a trusted
   publisher.
4. Each published `package.json` needs `publishConfig.access: public` and a `repository`
   field that matches the GitHub repo.

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

The `repo-fixture-release-*` jobs call both release workflows with `dry-run: true` against
`fixtures/changesets`, which holds one pending changeset. They prove the workflows parse and
run their dry path on every PR. Their `release` jobs always show as skipped.
