## The Agent Task Player Panel

```
┌─────────────────────────────────┐
│ $(rocket)  AGENT TASK PLAYER    │
├─────────────────────────────────┤
│ PLAN                            │
│ ├── $(list-tree) Setup          │  ← Playlist (phase)
│ │   ├── $(circle) Init project  │  ← Task (pending)
│ │   └── $(circle) Add database  │  ← Task (pending)
│ └── $(list-tree) Features       │
│     ├── $(circle) Add auth      │
│     └── $(circle) Add API       │
├─────────────────────────────────┤
│ HISTORY                         │
│ └── $(calendar) 2026-02-24 (3)  │
└─────────────────────────────────┘
```

### Panel Toolbar

| Icon | Action |
|------|--------|
| $(folder-opened) | Open an existing plan file |
| $(new-file) | Create a new plan |
| $(add) | Add a playlist |
| $(play) | Start execution |
| $(debug-pause) | Pause between tasks |
| $(debug-stop) | Stop and kill process |
