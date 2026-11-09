# Install locally as a packaged extension

Package it (writes `build/agent-task-player-<version>.vsix`; `build/` is not committed):

```bash
npm run package
```

Install it:

```bash
code --install-extension build/agent-task-player-<version>.vsix --force
```
