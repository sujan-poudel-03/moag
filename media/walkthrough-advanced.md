## Power Features

### Task Dependencies

Ensure tasks run in the right order:

```json
{
  "id": "task-auth",
  "name": "Add auth",
  "prompt": "Add JWT authentication...",
  "dependsOn": ["task-users"]
}
```

If `task-users` fails, `task-auth` is automatically **skipped**.

### Auto-Retry on Failure

```json
{
  "id": "task-tests",
  "name": "Write tests",
  "prompt": "Write unit tests...",
  "retryCount": 2
}
```

Retries up to 2 times with a delay between attempts.

### Parallel Execution

Run independent tasks concurrently:

```json
{
  "id": "pl-tests",
  "name": "Write Tests",
  "parallel": true,
  "tasks": [...]
}
```

### Verification Commands

Auto-validate task results:

```json
{
  "verifyCommand": "npm test"
}
```

Runs after the task succeeds. If it exits non-zero, the task is marked failed.

### Templates

- **Right-click a task** → "Save as Template" to reuse it later
- **Right-click a playlist** → "Add Task from Template" to pick from the library
- 10 built-in templates covering setup, features, testing, bugfixes, and more

### Import / Export

Share plans with your team:
- **Export** → copies JSON to clipboard or saves to file
- **Import** → loads from clipboard or file
