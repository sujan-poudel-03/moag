> **Draft — pending owner approval.** This describes what the code does today; the owner must review it before it is published as the privacy policy.

# MOAG privacy

MOAG (the VS Code extension `moag.agent-task-player` and its `moag` command-line tool) runs on your
machine. It sends **no product telemetry**: there is no analytics, crash reporting or usage beacon to
the MOAG authors. Everything below leaves your machine only because a feature you use needs it.

## Where data goes

### AI engines

Each task's prompt (your task text, plus project context MOAG assembles: AI rules, relevant files,
earlier task output) goes to the engine that runs it:

| Engine | Destination |
|---|---|
| Claude Code, Codex, Gemini CLI | The CLI you installed, which talks to its own vendor under that vendor's terms |
| Anthropic API | `api.anthropic.com`, with your API key |
| GitHub Copilot | VS Code's language-model API (`vscode.lm`), under GitHub's terms |
| Ollama | Your local Ollama, or the host in `agentTaskPlayer.engines.ollama.host` |
| Custom | Whatever command you configure |

### ONOSOO Builds (only when this machine is paired)

When you pair with **MOAG: Connect to ONOSOO Builds** or `moag pair`, runs are relayed to ONOSOO, a
hosted service. What is sent: run events, including the plan, project and task names, task
statuses, the names of changed files with line counts and **redacted** diffs, the tail of error
output, cost, the branch, the pull request URL, a random device id and the MOAG version. Before
anything is sent, values from `.env` / `.env.local`, engine API keys, the device key and common key
formats are removed, and absolute paths are shortened.

- Turn relaying off with the setting `agentTaskPlayer.onosoo.relay`.
- **MOAG: Disconnect from ONOSOO** (or deleting `onosoo.json`) removes the key; nothing is sent
  without it.

### GitHub, through the `gh` CLI or the GitHub API

Only when you use these features:

- **GitHub Issues Sync** reads issues from the repository you choose, and can post comments
  (`agentTaskPlayer.issueSync.postComments`), add labels and close issues.
- **Create PR** opens a pull request in your repository.
- **Share Plan** uploads the plan as a **public** GitHub Gist. The plan is redacted first, but
  anyone with the link can read what remains.
- **Release** tasks create tags and GitHub releases; **monitor** tasks can file incident issues in
  the repository you configure (`incidentRepo`).
- **Plan from GitHub Issue** reads a public issue from `api.github.com` without signing in.
- **Import Plan from URL** downloads a plan from the URL you give.

### Bug reports and feedback

**Report Issue to GitHub**, **Share Run Feedback** and the self-issue review create a **public**
issue on [github.com/sujan-poudel-03/moag](https://github.com/sujan-poudel-03/moag/issues). MOAG
redacts the text (secrets, your home folder and workspace paths) and shows you the exact title and
body before anything is posted; nothing is posted until you click **Post publicly**. Without a
signed-in `gh`, MOAG opens a prefilled page in your browser instead and you submit it yourself.

**Export Diagnostics** writes a redacted report to a file you choose; MOAG never sends it anywhere.

## What stays on your machine

- `.moag/` in your workspace: the plan, AI rules, the run queue, internal error log, usage log
  (rotated at 5 MB; your git email is recorded only with
  `agentTaskPlayer.contributionLedger.recordDeveloperEmail`), verification reports, screenshots.
  MOAG asks once per workspace before adding `.moag` rules to `.gitignore`. Plans can contain
  variables and environment values: do not commit or share a plan that holds secrets.
- VS Code's workspace storage: run history and sessions.
- VS Code's secret storage: the Anthropic API key.
- Your user config folder (`%APPDATA%\moag`, `~/.config/moag`): the ONOSOO pairing and the relay's
  unsent-event spool.

## Questions

Open an issue at [github.com/sujan-poudel-03/moag/issues](https://github.com/sujan-poudel-03/moag/issues).
For a security problem, see [SECURITY.md](SECURITY.md) instead.
