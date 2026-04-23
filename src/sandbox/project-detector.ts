// ─── Project type detector — scans the workspace to identify what's being built ───

import * as fs from 'fs';
import * as path from 'path';

export type ProjectType = 'web' | 'mobile' | 'desktop' | 'unknown';

export interface ProjectInfo {
  type: ProjectType;
  framework: string;
  /** Shell command to start the dev server / app */
  devCommand: string;
  /** Default port the dev server listens on (0 = N/A) */
  defaultPort: number;
  /** Resolved cwd where the command should run (may differ from workspace root in monorepos) */
  resolvedCwd?: string;
}

/** Directories that are common monorepo sub-package roots to scan */
const MONOREPO_SUB_DIRS = ['apps', 'packages', 'frontend', 'backend', 'web', 'api', 'services', 'client', 'server'];

/** Files at the repo root that indicate a monorepo */
const MONOREPO_ROOT_MARKERS = ['nx.json', 'turbo.json', 'lerna.json', 'pnpm-workspace.yaml'];

/**
 * Return true if cwd is a monorepo root (has a known monorepo config file
 * or a workspaces field in package.json but no runnable dev/start script of its own).
 */
function isMonorepoRoot(cwd: string, pkg: Record<string, unknown>): boolean {
  if (MONOREPO_ROOT_MARKERS.some(f => fs.existsSync(path.join(cwd, f)))) { return true; }
  const scripts = (pkg.scripts as Record<string, string>) ?? {};
  const hasWorkspaces = Array.isArray(pkg.workspaces) || typeof (pkg as Record<string, unknown>).workspaces === 'object';
  const hasNoDevScript = !scripts['dev'] && !scripts['start'] && !scripts['serve'];
  return hasWorkspaces && hasNoDevScript;
}

/**
 * Scan `cwd` and return what kind of project it is.
 * Checks Flutter, Android, React Native, Expo, Electron, Tauri,
 * and all major web frameworks (Next, Vite, CRA, Angular, Vue, Nuxt, Svelte).
 * When a monorepo root is detected, scans sub-directories and returns the best match.
 */
export function detectProject(cwd: string): ProjectInfo {
  // ── Flutter ──────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(cwd, 'pubspec.yaml'))) {
    return { type: 'mobile', framework: 'Flutter', devCommand: 'flutter run', defaultPort: 0 };
  }

  // ── Android native ────────────────────────────────────────────────────────
  if (
    fs.existsSync(path.join(cwd, 'android', 'gradlew')) ||
    fs.existsSync(path.join(cwd, 'gradlew'))
  ) {
    return { type: 'mobile', framework: 'Android', devCommand: './gradlew installDebug', defaultPort: 0 };
  }

  // ── Read package.json ─────────────────────────────────────────────────────
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    return { type: 'unknown', framework: 'unknown', devCommand: '', defaultPort: 0 };
  }

  const deps = (pkg.dependencies as Record<string, string>) ?? {};
  const devDeps = (pkg.devDependencies as Record<string, string>) ?? {};
  const all = { ...deps, ...devDeps };
  const scripts = (pkg.scripts as Record<string, string>) ?? {};

  // ── Monorepo root — scan sub-packages ────────────────────────────────────
  if (isMonorepoRoot(cwd, pkg)) {
    for (const subDir of MONOREPO_SUB_DIRS) {
      const subPath = path.join(cwd, subDir);
      if (!fs.existsSync(subPath)) { continue; }
      // Scan immediate children of the sub-directory
      const entries = fs.readdirSync(subPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const candidatePath = path.join(subPath, entry.name);
        const info = detectProject(candidatePath);
        if (info.type !== 'unknown') {
          return { ...info, resolvedCwd: candidatePath };
        }
      }
      // Also try the sub-directory itself (e.g. a single "frontend/" dir)
      const directInfo = detectProject(subPath);
      if (directInfo.type !== 'unknown') {
        return { ...directInfo, resolvedCwd: subPath };
      }
    }
    return { type: 'unknown', framework: 'monorepo', devCommand: '', defaultPort: 0 };
  }

  // ── Mobile: React Native / Expo ───────────────────────────────────────────
  if (all['react-native'] || all['expo']) {
    const framework = all['expo'] ? 'Expo' : 'React Native';
    const devCmd = scripts['start'] ?? (all['expo'] ? 'npx expo start' : 'npx react-native start');
    return { type: 'mobile', framework, devCommand: devCmd, defaultPort: 8081 };
  }

  // ── Desktop: Electron / Tauri ─────────────────────────────────────────────
  if (all['electron'] || all['@tauri-apps/cli']) {
    const framework = all['electron'] ? 'Electron' : 'Tauri';
    const devCmd = scripts['start'] ?? scripts['dev'] ?? 'npm run dev';
    return { type: 'desktop', framework, devCommand: devCmd, defaultPort: 0 };
  }

  // ── Web: Next.js ──────────────────────────────────────────────────────────
  if (all['next']) {
    return { type: 'web', framework: 'Next.js', devCommand: scripts['dev'] ?? 'npm run dev', defaultPort: 3000 };
  }

  // ── Web: Vite ─────────────────────────────────────────────────────────────
  if (all['vite'] || all['@vitejs/plugin-react'] || all['@vitejs/plugin-vue']) {
    return { type: 'web', framework: 'Vite', devCommand: scripts['dev'] ?? 'npm run dev', defaultPort: 5173 };
  }

  // ── Web: Create React App ─────────────────────────────────────────────────
  if (all['react-scripts']) {
    return { type: 'web', framework: 'Create React App', devCommand: scripts['start'] ?? 'npm start', defaultPort: 3000 };
  }

  // ── Web: Angular ──────────────────────────────────────────────────────────
  if (all['@angular/core'] || all['@angular/cli']) {
    return { type: 'web', framework: 'Angular', devCommand: scripts['start'] ?? 'ng serve', defaultPort: 4200 };
  }

  // ── Web: Nuxt ────────────────────────────────────────────────────────────
  if (all['nuxt'] || all['nuxt3'] || all['@nuxt/core']) {
    return { type: 'web', framework: 'Nuxt', devCommand: scripts['dev'] ?? 'npm run dev', defaultPort: 3000 };
  }

  // ── Web: SvelteKit ────────────────────────────────────────────────────────
  if (all['@sveltejs/kit']) {
    return { type: 'web', framework: 'SvelteKit', devCommand: scripts['dev'] ?? 'npm run dev', defaultPort: 5173 };
  }

  // ── Web: Vue CLI ──────────────────────────────────────────────────────────
  if (all['@vue/cli-service'] || (all['vue'] && scripts['serve'])) {
    return { type: 'web', framework: 'Vue', devCommand: scripts['serve'] ?? scripts['dev'] ?? 'npm run serve', defaultPort: 8080 };
  }

  // ── Web: generic (has a dev/start script) ────────────────────────────────
  if (scripts['dev'] || scripts['start']) {
    return { type: 'web', framework: 'Web', devCommand: scripts['dev'] ?? scripts['start'], defaultPort: 3000 };
  }

  return { type: 'unknown', framework: 'unknown', devCommand: '', defaultPort: 0 };
}
