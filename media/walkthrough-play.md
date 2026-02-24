## Execution Flow

```
  You hit Play
       │
       ▼
  ┌─────────────┐
  │ Pre-flight   │ ← Checks if CLI is installed
  │ validation   │   Warns you if missing
  └──────┬──────┘
         ▼
  ┌─────────────┐
  │ Task 1       │ ← Sends prompt to: claude -p "..."
  │ "Init proj"  │   Agent reads/writes your files
  └──────┬──────┘
         ▼
  ┌─────────────┐
  │ Verify       │ ← Optional: runs npm test
  │ (if set)     │   Exit 0 = pass, else fail
  └──────┬──────┘
         ▼
  ┌─────────────┐
  │ Task 2       │ ← Auto-advances after delay
  │ "Add auth"   │
  └──────┬──────┘
         ▼
      ✓ Done!
```

### Dashboard

Open the Dashboard to see live output streaming:
- **Plan** tab — see task statuses at a glance
- **Output** tab — live stdout/stderr from the agent
- **History** tab — browse past runs

### Controls during execution

| Action | What it does |
|--------|-------------|
| **Pause** | Finishes current task, then holds |
| **Stop** | Kills the running process immediately |
| **Play** (when paused) | Resumes from where it stopped |
