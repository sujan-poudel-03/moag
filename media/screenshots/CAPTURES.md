# Screenshots to capture for the Marketplace listing

The README has a placeholder comment for each one:
`<!-- screenshot: media/screenshots/<name> | alt: "<alt>" -->`. When a capture exists, replace the
comment with `![<alt>](media/screenshots/<name>)`. vsce rewrites relative README images to the
GitHub raw URL, so the files must be committed and pushed before publishing.

**PNG or GIF only:** the Marketplace rejects SVG images in a README. Keep each file under 1 MB if
possible (a GIF can be larger; keep it short). Capture at 1x scale with a theme that most users run
(Dark Modern), and use a demo project with no real names, paths, keys or email addresses in view.

| # | File | Size | What it shows | Alt text |
|---|---|---|---|---|
| 1 | `hero.gif` | 1280×720, about 10 s | The sidebar plan, a click on **Play**, then the Dashboard streaming live output | MOAG running a plan: the sidebar plan, Play, and the Dashboard streaming live output |
| 2 | `dashboard.png` | 1280×800 | The Dashboard mid-run: live output and task cards | The MOAG Dashboard with live task output and task cards |
| 3 | `plan-tree.png` | 600×800 | The sidebar plan with playlists and tasks in mixed statuses (completed, running, failed, pending) | A plan in the sidebar with playlists and tasks in mixed statuses |
| 4 | `smart-plan.png` | 1280×800 | Smart New Plan: PRD text on one side, the generated plan on the other | Smart New Plan turning a PRD into playlists and tasks |
| 5 | `setup-guide.png` | 1280×800, light **and** dark theme (two captures, or one side by side) | The Setup Guide with six engines, the Anthropic API row showing Configured | The MOAG Setup Guide listing six engines, with the Anthropic API row configured |
| 6 | `cost-summary.png` | 1280×800 | MOAG: Show Cost & Usage Summary with at least one "cost unknown" row | The cost and usage summary, with a cost unknown row |
| 7 | `onosoo-run.png` | 1280×800 | A run in ONOSOO Builds: tasks, changed files and cost | A MOAG run in ONOSOO Builds with its tasks, changes and cost |

Packaging note (release lane): `media/screenshots/**` should be excluded in `.vscodeignore`; the
README images are served from GitHub, not from the VSIX.
