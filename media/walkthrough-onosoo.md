## Connect to ONOSOO Builds

ONOSOO Builds shows your MOAG runs as they happen: tasks in plan order, what each task changed, error output, cost, branch and pull request.

| Level | What works in ONOSOO | Machine | MOAG process |
|-------|----------------------|---------|--------------|
| **1. Watch** | Runs appear live | Windows, macOS or Linux | `moag run`, or any run from the VS Code panel |
| **2. Control** | Start, stop, approve, skip, retry | Linux or WSL2 only | `moag daemon` |
| **3. Open it live** | Open a running branch, health, logs | Linux or WSL2 only, with Docker | `moag host` |

### 1. Pair the machine

In ONOSOO open **Builds**, click **Pair machine**, name the machine and copy the key. The key starts with `onosoo_live_` and is shown **once**. A WSL2 Ubuntu on a Windows PC is a separate machine: pair it separately.

### 2. Save the key in your user folder

**Windows (PowerShell):**

```powershell
$dir = "$env:APPDATA\moag"
New-Item -ItemType Directory -Force $dir | Out-Null
@{ key = "<paste key>"; url = "https://<project-ref>.supabase.co" } | ConvertTo-Json | Set-Content "$dir\onosoo.json" -Encoding ascii
```

**Linux / WSL2 / macOS:**

```bash
mkdir -p ~/.config/moag && chmod 700 ~/.config/moag
printf '{"key":"<paste key>","url":"https://<project-ref>.supabase.co"}' > ~/.config/moag/onosoo.json
chmod 600 ~/.config/moag/onosoo.json
```

> Never put the key inside a project, and never set it account-wide (`setx`, System Properties, `/etc/environment`): every process would get it, including the AI agents MOAG runs.

### 3. Run something

Run any plan, from this panel or with `moag run`, and it appears in ONOSOO. From the terminal:

```bash
moag run --prompt "Add a short README describing this project" --cwd /path/to/repo
```

Open **Builds** in ONOSOO: within seconds the machine shows **online** and the run appears with its tasks. Runs from this panel relay while the status bar shows **☁ ONOSOO**; the setting `agentTaskPlayer.onosoo.relay` turns that off.

> No key at all turns the relay off silently. If nothing shows up, check the file path and that it is valid JSON. In WSL, the Windows file is not visible.

Full guide, including remote runs and live previews: [docs/onosoo-builds.md](https://github.com/sujan-poudel-03/moag/blob/master/docs/onosoo-builds.md)
