## What is a Plan?

A **plan** is a `.agent-plan.json` file that defines your workflow:

```
Plan
├── Playlist: "Setup"          ← Phase/group of related tasks
│   ├── Task: "Init project"   ← A single prompt for the AI agent
│   └── Task: "Add database"
├── Playlist: "Features"
│   ├── Task: "User CRUD"
│   └── Task: "Authentication"
└── Playlist: "Testing"
    └── Task: "Write tests"
```

### Minimal example

```json
{
  "version": "1.0",
  "name": "My Project",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "setup",
      "name": "Setup",
      "autoplay": true,
      "tasks": [
        {
          "id": "task-1",
          "name": "Create project",
          "prompt": "Create a Node.js project with TypeScript and Express."
        }
      ]
    }
  ]
}
```

Save this in your workspace and the extension auto-loads it.
