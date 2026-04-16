# MOAG CI Validation Guide

Use MOAG's `validate` task type to run multi-target quality gates in CI pipelines.

## Validate Task Schema

```json
{
  "id": "validate-all",
  "name": "Cross-platform Validation",
  "type": "validate",
  "prompt": "Run cross-platform validation across web, mobile, and desktop targets.",
  "validation": {
    "targets": ["web", "mobile", "desktop"],
    "profile": "pr"
  },
  "failurePolicy": "continue"
}
```

### Validation Profiles

| Profile | Stages | Max Wall-clock | Use When |
|---------|--------|----------------|----------|
| `quick` | lint, unit | 3 min | Local dev loop |
| `pr` | lint, unit, integration, e2e | 15 min | PR gate |
| `full` | all stages, all targets | 60 min | Nightly / release |

### Validation Targets

| Target | Requires |
|--------|----------|
| `web` | `playwright.config.ts` or `cypress.config.ts` in workspace root |
| `mobile` | `detox`, `appium`, or `expo` in `package.json` + connected device/emulator |
| `desktop` | Electron + `@playwright/test`, `spectron`, or WinAppDriver |
| `all` | Expands to all available targets (skips unavailable ones gracefully) |

Targets that lack the required tooling are **skipped with a descriptive message** rather than failing the task.

## GitHub Actions Example

```yaml
name: PR Validation
on:
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium
      - name: Run MOAG PR validation
        run: npx moag run --plan plans/ci-pr.agent-plan.json
```

### Sample `plans/ci-pr.agent-plan.json`

```json
{
  "version": "1.0",
  "name": "CI PR Gate",
  "defaultEngine": "claude",
  "validation": {
    "targets": ["web"],
    "profile": "pr"
  },
  "playlists": [
    {
      "id": "pl-validate",
      "name": "PR Gate",
      "autoplay": true,
      "tasks": [
        {
          "id": "validate-web",
          "name": "Web Validation (PR)",
          "type": "validate",
          "prompt": "Run the PR gate validation suite.",
          "failurePolicy": "stop"
        }
      ]
    }
  ]
}
```

## Nightly Full Validation

```yaml
name: Nightly Validation
on:
  schedule:
    - cron: '0 2 * * *'   # 02:00 UTC

jobs:
  nightly:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps
      - name: Run MOAG nightly full validation
        run: npx moag run --plan plans/ci-nightly.agent-plan.json
      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: validation-results
          path: |
            test-results/
            playwright-report/
```

## Artifact Retention

The `validate` task records per-stage pass/fail, duration, and summaries in the MOAG history store. Screenshots, traces, and log paths are attached to each `TaskArtifact` entry for easy retrieval via the Dashboard's **Validation Targets** panel.

## Flaky Test Handling

- Flaky tests (stages that fail then pass on retry) are flagged with `flaky: true` in the artifact record.
- The `flakyCount` field on the `HistoryEntry` gives a per-run total.
- Use `failurePolicy: "continue"` on the validate task to let the run finish and collect all results even when some targets fail.

## Failure Policy Recommendations

| Scenario | Recommended `failurePolicy` |
|----------|-----------------------------|
| PR gate (block merge on failure) | `"stop"` |
| Nightly report (collect all results) | `"continue"` |
| Informational gate | `"mark-blocked"` |
