## Connect to ONOSOO Builds

ONOSOO Builds shows your MOAG runs as they happen: tasks in plan order, what each task changed, error output, cost, branch and pull request.

| Level | What works in ONOSOO | Machine | MOAG process |
|-------|----------------------|---------|--------------|
| **1. Watch** | Runs appear live | Windows, macOS or Linux | `moag run`, or any run from the VS Code panel |
| **2. Control** | Start, stop, approve, skip, retry | Linux or WSL2 only | `moag daemon` |
| **3. Open it live** | Open a running branch, health, logs | Linux or WSL2 only, with Docker | `moag host` |

### 1. Get a device key

In ONOSOO, switch the app on in **Settings › Apps › Builds**, open **Builds**, click **Pair machine**, name the machine and copy the key. The key starts with `onosoo_live_` and is shown **once**. A WSL2 Ubuntu on a Windows PC is a separate machine: pair it separately.

### 2. Pair this machine

Run **MOAG: Connect to ONOSOO Builds** and paste the key. MOAG saves it in your user folder (`%APPDATA%\moag\onosoo.json` on Windows, `~/.config/moag/onosoo.json` elsewhere), checks it with ONOSOO, and the status bar shows **☁ ONOSOO**.

In a terminal, after **MOAG: Install Command-Line Tool**, `moag pair` does the same: paste the key at the prompt.

> Never put the key inside a project, and never set it account-wide (`setx`, System Properties, `/etc/environment`): every process would get it, including the AI agents MOAG runs.

### 3. Run something

Run any plan, from this panel or with `moag run`, and it appears in ONOSOO. From the terminal:

```bash
moag run --prompt "Add a short README describing this project" --cwd /path/to/repo
```

Open **Builds** in ONOSOO: within seconds the machine shows **online** and the run appears with its tasks. Runs from this panel relay while the status bar shows **☁ ONOSOO**; the setting `agentTaskPlayer.onosoo.relay` turns that off.

> If nothing shows up, run **MOAG: Connect to ONOSOO Builds** again: it says whether ONOSOO accepted the key. In WSL, the Windows pairing is not visible: pair inside WSL with `moag pair`.

Full guide, including remote runs and live previews: [docs/onosoo-builds.md](https://github.com/sujan-poudel-03/moag/blob/master/docs/onosoo-builds.md)
