# ci

Shared GitHub Actions workflows and actions for HJewkes repos. Each repo's rulesets require one
status check, `check`, and this repo supplies the pieces that make `check` mean something.

| Path | What it is |
|---|---|
| `actions/all-green` | The composite action behind every repo's `check` job |

The reusable `node.yml` workflow, the `setup` action and release workflows arrive in later
releases.

## Wiring `check`

Every conforming repo has, in `.github/workflows/ci.yml`, a final job with id `check`:

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

## Pinning

Callers pin the moving major tag: `uses: HJewkes/ci/actions/all-green@v1`.

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
