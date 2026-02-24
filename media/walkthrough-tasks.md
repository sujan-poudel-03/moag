## Playlists and Tasks

### Playlist = a phase of work

Think of it as a folder that groups related tasks:
- "Project Setup"
- "Build Features"
- "Testing & QA"

### Task = one instruction for the AI agent

Each task has a **name** and a **prompt** — the exact instruction sent to the CLI:

```json
{
  "id": "task-auth",
  "name": "Add JWT authentication",
  "prompt": "Add JWT auth with login/register endpoints. Use bcrypt for password hashing. Protect write endpoints with auth middleware."
}
```

### Tips for writing good prompts

| Do | Don't |
|----|-------|
| Be specific about what to create | "Make it better" |
| Mention file paths and names | Leave structure ambiguous |
| Specify libraries/tools to use | Assume the agent knows your stack |
| One clear goal per task | Cram multiple unrelated changes |

### Optional task fields

- `files` — inject file contents as context
- `verifyCommand` — run `npm test` after the task
- `retryCount` — retry on failure
- `dependsOn` — wait for another task to finish first
- `engine` — use a different agent for this task
