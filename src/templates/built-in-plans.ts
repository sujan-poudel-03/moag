// ─── Built-in Plan Templates — ready-to-play plans for common workflows ───

import { Plan, EngineId } from '../models/types';
import { createEmptyPlan, createPlaylist, createTask } from '../models/plan';

export interface PlanTemplate {
  id: string;
  name: string;
  description: string;
  category: 'Scaffold' | 'Improve' | 'Fix' | 'Automate';
  buildPlan(projectName: string): Plan;
}

function plan(name: string, playlists: ReturnType<typeof createPlaylist>[]): Plan {
  const p = createEmptyPlan(name);
  p.playlists = playlists;
  return p;
}

function task(name: string, prompt: string, opts?: { verify?: string; engine?: EngineId }) {
  const t = createTask(name, prompt, opts?.engine);
  if (opts?.verify) { t.verifyCommand = opts.verify; }
  return t;
}

// ── Scaffold ──

const nextjsFullStack: PlanTemplate = {
  id: 'tpl-nextjs-fullstack',
  name: 'Next.js Full-Stack App',
  description: 'Scaffold a Next.js app with pages, API routes, Prisma DB, auth, and tests',
  category: 'Scaffold',
  buildPlan: (proj) => plan(`${proj} — Next.js Full-Stack`, [
    Object.assign(createPlaylist('Scaffold & Data Layer'), { tasks: [
      task('Initialize Next.js project', `Create a new Next.js 14 app in the current directory with TypeScript, Tailwind CSS, and App Router. Set up the project structure with src/ directory.`, { verify: 'npx next lint' }),
      task('Set up Prisma & database', `Install Prisma, initialize with SQLite for development. Create schema with User and Session models. Generate client and run initial migration.`, { verify: 'npx prisma validate' }),
      task('Add authentication', `Implement NextAuth.js with credentials provider. Create login/signup pages, API routes for auth, and session middleware. Protect dashboard routes.`),
      task('Build core pages', `Create the main application pages: landing page, dashboard, settings. Use server components where possible, add loading states and error boundaries.`),
      task('Add API routes', `Create RESTful API routes under app/api/ for the core resources. Include input validation with zod, proper error responses, and auth guards.`),
      task('Write tests', `Add Jest and React Testing Library. Write unit tests for API routes and integration tests for auth flow. Aim for key paths covered.`, { verify: 'npm test' }),
    ]}),
  ]),
};

const expressApi: PlanTemplate = {
  id: 'tpl-express-api',
  name: 'Express REST API',
  description: 'Build an Express API with routes, middleware, validation, error handling, and tests',
  category: 'Scaffold',
  buildPlan: (proj) => plan(`${proj} — Express REST API`, [
    Object.assign(createPlaylist('API Foundation'), { tasks: [
      task('Initialize Express project', `Create a new Express.js project with TypeScript. Set up tsconfig, nodemon for dev, and a clean folder structure: src/routes, src/middleware, src/models, src/utils.`, { verify: 'npx tsc --noEmit' }),
      task('Add middleware & error handling', `Create middleware for request logging, CORS, rate limiting, and a global error handler. Add a health check endpoint at GET /health.`),
      task('Build CRUD routes', `Create RESTful routes for a sample resource (e.g., /api/items) with GET (list/detail), POST, PUT, DELETE. Use zod for request validation.`),
      task('Add database layer', `Set up a database connection (SQLite via better-sqlite3 for simplicity). Create a repository pattern for data access with migrations support.`),
      task('Write tests', `Add Jest and supertest. Write tests for each route covering success cases, validation errors, and not-found scenarios.`, { verify: 'npm test' }),
    ]}),
  ]),
};

const reactComponentLib: PlanTemplate = {
  id: 'tpl-react-component-lib',
  name: 'React Component Library',
  description: 'Create a React component library with Storybook, TypeScript, testing, and build pipeline',
  category: 'Scaffold',
  buildPlan: (proj) => plan(`${proj} — React Component Library`, [
    Object.assign(createPlaylist('Library Setup'), { tasks: [
      task('Initialize library project', `Set up a React component library with TypeScript using Vite in library mode. Configure package.json for ESM/CJS dual output, set up src/components/ structure.`, { verify: 'npx tsc --noEmit' }),
      task('Add Storybook', `Install and configure Storybook 8. Create a .storybook config with TypeScript support and Tailwind CSS integration. Add a welcome story.`, { verify: 'npx storybook build --test' }),
      task('Build core components', `Create 3 foundational components: Button (variants, sizes, loading state), Input (with label, error, helper text), and Card (header, body, footer slots). Export from index.ts.`),
      task('Add component tests', `Install Vitest and Testing Library. Write tests for each component covering rendering, props, events, and accessibility. Add an a11y testing addon.`, { verify: 'npx vitest run' }),
      task('Configure build pipeline', `Set up Vite build for library output. Generate TypeScript declarations. Add a prepublish script and configure package.json exports map.`, { verify: 'npm run build' }),
    ]}),
  ]),
};

// ── Improve ──

const addTests: PlanTemplate = {
  id: 'tpl-add-tests',
  name: 'Add Comprehensive Tests',
  description: 'Analyze existing code and add unit tests, integration tests, and coverage config',
  category: 'Improve',
  buildPlan: (proj) => plan(`${proj} — Add Tests`, [
    Object.assign(createPlaylist('Testing'), { tasks: [
      task('Analyze code & set up test framework', `Examine the project structure and choose an appropriate test framework (Jest, Vitest, or Mocha). Install it along with any needed assertion/mocking libraries. Configure coverage reporting.`),
      task('Write unit tests for core modules', `Identify the 3-5 most important modules (business logic, utilities, data access). Write thorough unit tests covering happy paths, edge cases, and error scenarios.`, { verify: 'npm test' }),
      task('Write integration tests', `Write integration tests for the main workflows: API endpoints (if any), database operations, and key user-facing features. Use realistic test data.`, { verify: 'npm test' }),
      task('Add coverage config & CI check', `Configure coverage thresholds (aim for 70%+ on new code). Add a coverage reporting script. Create or update the CI config to run tests and enforce thresholds.`, { verify: 'npm test -- --coverage' }),
    ]}),
  ]),
};

const tsMigration: PlanTemplate = {
  id: 'tpl-ts-migration',
  name: 'TypeScript Migration',
  description: 'Incrementally migrate a JavaScript project to TypeScript with strict checks',
  category: 'Improve',
  buildPlan: (proj) => plan(`${proj} — TypeScript Migration`, [
    Object.assign(createPlaylist('Migration'), { tasks: [
      task('Install TypeScript & configure', `Install typescript and ts-node. Create a tsconfig.json with allowJs: true and strict: false initially. Configure paths, outDir, and include patterns. Rename entry file to .ts.`, { verify: 'npx tsc --noEmit' }),
      task('Convert core files', `Convert the 5-10 most-imported files from .js to .ts. Add type annotations for function signatures and exports. Fix any immediate type errors.`, { verify: 'npx tsc --noEmit' }),
      task('Convert remaining files', `Convert all remaining .js/.jsx files to .ts/.tsx. Add basic types — prefer explicit annotations over 'any'. Update import paths as needed.`, { verify: 'npx tsc --noEmit' }),
      task('Enable strict mode', `Turn on strict: true in tsconfig.json. Fix all resulting type errors: add null checks, type guards, and proper interface definitions. Eliminate any remaining 'any' types.`, { verify: 'npx tsc --noEmit' }),
      task('Update build & CI', `Update build scripts to use tsc. Update CI config to include type checking. Remove any now-unnecessary Babel config if TypeScript handles compilation.`, { verify: 'npm run build' }),
    ]}),
  ]),
};

const addCiCd: PlanTemplate = {
  id: 'tpl-cicd-pipeline',
  name: 'Add CI/CD Pipeline',
  description: 'Set up GitHub Actions for linting, testing, building, and deploying',
  category: 'Improve',
  buildPlan: (proj) => plan(`${proj} — CI/CD Pipeline`, [
    Object.assign(createPlaylist('CI/CD'), { tasks: [
      task('Add linting config', `Set up ESLint (or the project-appropriate linter) with a sensible config. Add a lint script to package.json. Fix any existing lint errors.`, { verify: 'npm run lint' }),
      task('Create CI workflow', `Create .github/workflows/ci.yml that runs on push and PR: checkout, install deps, lint, test, and build. Use caching for node_modules. Add status badge to README.`),
      task('Add deployment workflow', `Create .github/workflows/deploy.yml that triggers on main branch push. Add environment variables setup, build step, and deployment to the target platform (Vercel/Netlify/AWS — choose based on project type).`),
      task('Add PR checks', `Add branch protection rules documentation. Create a PR template at .github/pull_request_template.md with checklist. Add a workflow that posts test coverage as a PR comment.`),
    ]}),
  ]),
};

// ── Fix ──

const securityAudit: PlanTemplate = {
  id: 'tpl-security-audit',
  name: 'Security Audit & Fix',
  description: 'Scan for vulnerabilities, fix OWASP top 10 issues, add security headers',
  category: 'Fix',
  buildPlan: (proj) => plan(`${proj} — Security Audit`, [
    Object.assign(createPlaylist('Security'), { tasks: [
      task('Audit dependencies', `Run npm audit and review all dependencies for known vulnerabilities. Update or replace vulnerable packages. Document any that cannot be updated with justification.`, { verify: 'npm audit --audit-level=high' }),
      task('Fix injection vulnerabilities', `Review all user input handling: SQL queries, shell commands, template rendering, and API parameters. Add parameterized queries, input sanitization, and output encoding where missing.`),
      task('Add security headers & auth hardening', `Add security headers (CSP, X-Frame-Options, HSTS, etc.) via middleware. Review auth: ensure passwords are hashed with bcrypt, tokens have expiry, and sessions are invalidated on logout.`),
      task('Add rate limiting & logging', `Add rate limiting to auth endpoints and API routes. Set up security event logging for failed logins, permission denials, and suspicious patterns. Add a security-focused test suite.`),
    ]}),
  ]),
};

const perfOptimization: PlanTemplate = {
  id: 'tpl-perf-optimization',
  name: 'Performance Optimization',
  description: 'Profile and optimize bundle size, lazy loading, and caching strategies',
  category: 'Fix',
  buildPlan: (proj) => plan(`${proj} — Performance Optimization`, [
    Object.assign(createPlaylist('Performance'), { tasks: [
      task('Analyze bundle & profile', `Analyze the current bundle size using webpack-bundle-analyzer or equivalent. Identify the largest dependencies and unused code. Document current metrics as a baseline.`),
      task('Optimize bundle size', `Remove unused dependencies, replace heavy libraries with lighter alternatives (e.g., date-fns instead of moment). Set up tree shaking and dead code elimination. Add dynamic imports for large features.`, { verify: 'npm run build' }),
      task('Add lazy loading', `Implement code splitting for routes and heavy components. Add lazy loading for images and below-the-fold content. Configure prefetching for likely next navigations.`),
      task('Add caching strategy', `Implement caching: HTTP cache headers for static assets, service worker for offline support (if applicable), and in-memory/Redis caching for API responses. Add cache invalidation logic.`),
    ]}),
  ]),
};

const a11yAudit: PlanTemplate = {
  id: 'tpl-a11y-audit',
  name: 'Accessibility Audit',
  description: 'Ensure WCAG compliance with aria labels, keyboard navigation, and screen reader support',
  category: 'Fix',
  buildPlan: (proj) => plan(`${proj} — Accessibility Audit`, [
    Object.assign(createPlaylist('Accessibility'), { tasks: [
      task('Run automated a11y scan', `Install and run axe-core or pa11y on all pages/routes. Document all violations grouped by severity. Create a prioritized fix list.`),
      task('Fix semantic HTML & ARIA', `Replace div/span soup with semantic HTML (nav, main, section, article, aside). Add ARIA labels, roles, and live regions where semantic HTML isn't sufficient. Ensure all images have meaningful alt text.`),
      task('Fix keyboard navigation', `Ensure all interactive elements are keyboard accessible. Add visible focus indicators, implement focus trapping in modals, and add skip-to-content links. Test tab order is logical.`),
      task('Add a11y tests', `Add automated accessibility tests using jest-axe or similar. Test color contrast ratios meet WCAG AA (4.5:1 for text). Add screen reader testing notes to the PR description.`, { verify: 'npm test' }),
    ]}),
  ]),
};

// ── Automate ──

const apiDocs: PlanTemplate = {
  id: 'tpl-api-docs',
  name: 'API Documentation',
  description: 'Generate OpenAPI spec, add JSDoc comments, and create a documentation site',
  category: 'Automate',
  buildPlan: (proj) => plan(`${proj} — API Documentation`, [
    Object.assign(createPlaylist('Documentation'), { tasks: [
      task('Add JSDoc to all endpoints', `Add comprehensive JSDoc comments to all API route handlers: description, @param with types, @returns with response shape, and @throws for error cases.`),
      task('Generate OpenAPI spec', `Create an OpenAPI 3.0 spec (openapi.yaml) documenting all API endpoints, request/response schemas, auth requirements, and error formats. Validate the spec.`),
      task('Create docs site', `Set up a documentation page using Swagger UI or Redoc that serves the OpenAPI spec. Add a npm script to serve docs locally. Include example requests for each endpoint.`),
      task('Add request examples', `Create a docs/examples/ folder with curl commands and fetch snippets for every endpoint. Add a Postman/Insomnia collection export for easy API testing.`),
    ]}),
  ]),
};

const dbMigration: PlanTemplate = {
  id: 'tpl-db-migration',
  name: 'Database Migration',
  description: 'Plan and execute schema changes with migration scripts, seed data, and rollback',
  category: 'Automate',
  buildPlan: (proj) => plan(`${proj} — Database Migration`, [
    Object.assign(createPlaylist('Migration'), { tasks: [
      task('Set up migration tooling', `Install and configure a migration tool appropriate for the project (Prisma Migrate, knex, node-pg-migrate, etc.). Create the migrations directory and initial config.`),
      task('Create migration scripts', `Write migration scripts for the required schema changes. Each migration should be atomic and idempotent. Include both up and down migrations for rollback support.`),
      task('Add seed data', `Create seed scripts that populate the database with realistic sample data for development and testing. Include scripts for different environments (dev, test, staging).`),
      task('Test migrations', `Write tests that verify migrations run cleanly on a fresh database, that rollbacks work correctly, and that seed data loads without errors. Document the migration runbook.`, { verify: 'npm test' }),
    ]}),
  ]),
};

const monorepoSetup: PlanTemplate = {
  id: 'tpl-monorepo-setup',
  name: 'Monorepo Setup',
  description: 'Configure workspace packages, shared code, and build orchestration',
  category: 'Automate',
  buildPlan: (proj) => plan(`${proj} — Monorepo Setup`, [
    Object.assign(createPlaylist('Monorepo'), { tasks: [
      task('Initialize workspace', `Set up npm/pnpm/yarn workspaces. Create the monorepo structure: packages/ for shared libs, apps/ for applications. Configure the root package.json and tsconfig with project references.`, { verify: 'npx tsc --noEmit' }),
      task('Create shared packages', `Extract shared code into packages: packages/shared (types, utils), packages/ui (if applicable), packages/config (shared ESLint, TypeScript, Prettier configs). Set up each with its own package.json.`),
      task('Set up build orchestration', `Configure Turborepo or Nx for build orchestration. Define the task pipeline (build, test, lint) with proper dependency graph. Add caching for build outputs.`, { verify: 'npm run build' }),
      task('Update CI for monorepo', `Update CI configuration to work with the monorepo: install all workspace deps, run affected tests only, build packages in dependency order. Add change detection to skip unaffected packages.`),
    ]}),
  ]),
};

/** All built-in plan templates */
export const BUILT_IN_PLAN_TEMPLATES: PlanTemplate[] = [
  // Scaffold
  nextjsFullStack,
  expressApi,
  reactComponentLib,
  // Improve
  addTests,
  tsMigration,
  addCiCd,
  // Fix
  securityAudit,
  perfOptimization,
  a11yAudit,
  // Automate
  apiDocs,
  dbMigration,
  monorepoSetup,
];
