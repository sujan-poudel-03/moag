# Releasing MOAG

A release is a pushed tag `vX.Y.Z`. The Publish workflow (`.github/workflows/publish.yml`)
does the rest: it checks the tag, runs the whole CI workflow on the tagged commit, packages
the extension once, smoke-tests that file, attaches it to a GitHub release with the
changelog section as notes, and publishes the same file to the VS Code Marketplace.

## Steps

1. **Bump the version.** `npm version X.Y.Z --no-git-tag-version` (this updates
   `package.json` and `package-lock.json`, and creates no tag).
2. **Move the changelog.** In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD` (today's date) and add a new, empty `## [Unreleased]` above it.
   Put `### Upgrade notes` first if the release asks anything of the user: a new minimum
   VS Code, a changed default, a moved setting. At the end of the file, point
   `[Unreleased]` at `compare/vX.Y.Z...HEAD` and add
   `[X.Y.Z]: https://github.com/sujan-poudel-03/moag/compare/vPREVIOUS...vX.Y.Z`.
   The unit suite (`src/test/unit/repo/changelog.test.ts`) fails until the first version
   heading equals `package.json`'s, the headings are well formed and descending, and every
   released version has its link.
3. **Commit** on `master`: `chore(release): X.Y.Z — <one line>`, and let CI go green.
4. **Tag and push the tag:**

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Only tags of the exact form `vX.Y.Z` start the workflow. Push one release tag at a time:
GitHub creates no push event when more than three tags are pushed at once, so a batch push
starts nothing.

## What each job proves

| Job | Proves | Fails when |
|---|---|---|
| `check` | The tag names the version in `package.json`, and `CHANGELOG.md` has a non-empty section for it (`scripts/release-notes.js`). | The tag is on the wrong commit, or the notes are missing or empty. |
| `ci` | The tagged commit passes the whole CI workflow: lint, build, the unit suite on Linux, Windows and macOS, integration tests on the current VS Code (three platforms) and on the minimum one (`engines.vscode`, Linux), the packaging smoke test, and the dependency audit. | Any of those fails. A flaky integration run or a high-severity advisory blocks the release on purpose: re-run, or fix it. |
| `package` | One VSIX, `moag-X.Y.Z.vsix`, built by `vsce package` and checked by `npm run smoke:vsix -- --vsix <file>`: fewer than 60 files, no `node_modules`, no source maps, `main` loads with a stub `vscode`, `bin.moag --help` runs and `bin.moag verify` reports a missing plan. | The package would not load, or carries what it should not. |
| `release` | A GitHub release `vX.Y.Z` titled "MOAG X.Y.Z", with that exact VSIX attached and the changelog section as notes. `--verify-tag` refuses to create a tag that is not already pushed. | The release already exists, or the tag is gone. |
| `marketplace` | The same VSIX on the Marketplace, published with the `VSCE_PAT` secret. | The token is wrong or expired, or the Marketplace refuses the version. |

The workflow has `contents: read` everywhere except `release`, which has `contents: write`
to create the release. The Marketplace token lives only in the `marketplace` job's
environment; vsce reads it from `VSCE_PAT`, so it never appears on a command line.

## When something fails

- **`check` failed:** fix `package.json` or `CHANGELOG.md` on `master`, then move the tag:
  `git tag -f vX.Y.Z <fixed commit>` and `git push -f origin vX.Y.Z`. Nothing was released.
- **`ci` or `package` failed:** nothing was released. Fix on `master` and move the tag as
  above, or re-run the failed jobs from the Actions page if the failure was a flake.
- **`marketplace` was skipped or failed:** the GitHub release already exists and is correct.
  Fix the cause (add or renew the `VSCE_PAT` secret: an Azure DevOps personal access token
  with the Marketplace "Manage" scope for the `moag` publisher), then open the workflow run
  and use **Re-run failed jobs** (or re-run just `marketplace`). It downloads the same
  VSIX artifact, so what reaches the Marketplace is byte-for-byte what was released.
  Artifacts are kept for 90 days by default.

## The dependency audit

CI runs `npm audit --omit=dev --audit-level=high`: an advisory of high or critical severity
in a runtime dependency (`dependencies` in `package.json`; today only `@anthropic-ai/sdk`,
which is bundled into the extension) fails it. For now the job is `continue-on-error`
(reported, not blocking) until one run on `master` has shown it is clean; the next change
makes it blocking.

The escape hatch, once it blocks: when an advisory has no fixed release yet and does not
affect MOAG (for example, the vulnerable code path is never reached), record why in an
issue, and pin a patched transitive version with an `overrides` entry in `package.json` if
one exists. If none exists, set `continue-on-error: true` on the `audit` job in the same
pull request that links the issue, and remove it when the fix ships. Never lower
`--audit-level` or drop `--omit=dev` to get a release out.

## Build servers run a source checkout

The VSIX ships the CLI as one bundle, `out/bundle/cli.js`. A machine set up with
`scripts/setup-build-server.sh` runs MOAG from a source checkout at `/opt/moag` instead, and
its sudoers rule allows exactly `/opt/moag/out/headless/cli.js remote-child`. That file is
the unbundled tsc output, which `npm run compile` still produces. Keep build servers on a
source checkout: a daemon started from the bundled CLI would spawn
`out/bundle/cli.js remote-child`, which the sudoers rule does not allow, so remote runs
would be refused. The same holds for `scripts/install-daemon-windows.ps1` in checkout
mode, which runs `out\headless\cli.js`.

## Tags for past releases (one-time)

Only `v0.7.0` and `v0.9.4` exist as tags. These commits are the released versions; each
one's `package.json` carries that version (checked with
`git show <sha>:package.json | grep '"version"'`):

| Tag | Commit | Released |
|---|---|---|
| v0.9.5 | a83fde7 | 2026-04-23 |
| v0.9.6 | 6864628 | 2026-04-27 |
| v0.9.9 | 4573414 | 2026-05-12 |
| v0.9.10 | 64e503b | 2026-06-01 |
| v0.9.12 | 84fcf76 | 2026-06-20 |
| v0.9.13 | 7ecf43b | 2026-10-20 |
| v0.9.14 | 0abf8fd | 2026-10-22 |
| v0.9.15 | 2fec84a | 2026-10-24 |

Create them locally and push them **in one push**:

```bash
git tag v0.9.5 a83fde7
git tag v0.9.6 6864628
git tag v0.9.9 4573414
git tag v0.9.10 64e503b
git tag v0.9.12 84fcf76
git tag v0.9.13 7ecf43b
git tag v0.9.14 0abf8fd
git tag v0.9.15 2fec84a
git push origin v0.9.5 v0.9.6 v0.9.9 v0.9.10 v0.9.12 v0.9.13 v0.9.14 v0.9.15
```

Pushing them together matters: GitHub creates no push event when more than three tags are
pushed at once, so the Publish workflow does not run for any of them and nothing is
re-released. Confirm that rule against GitHub's current documentation of the `push` event
before you rely on it. Pushed one at a time, each tag would run the Publish workflow **as it
was at that old commit** (GitHub reads the workflow file from the tagged commit), and those
versions trigger on any `v*` tag and publish to the Marketplace when `VSCE_PAT` is set. The
changelog's compare links resolve once these tags exist.
