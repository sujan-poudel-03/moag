// ─── Server packaging: Dockerfile, .dockerignore, VSIX exclusion, operator docs ───
//
// Static checks only (Docker is not needed to run them). The security-relevant
// image properties — Node 20, non-root, CI never set, data on a volume, a
// health check — must not drift silently.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const read = (f: string): string => fs.readFileSync(path.join(REPO, f), 'utf-8');

describe('server packaging', () => {
  const docker = read('Dockerfile');
  const lines = docker.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const body = lines.join('\n');

  it('builds and runs on node:20', () => {
    const froms = lines.filter((l) => /^FROM\s/i.test(l));
    assert.ok(froms.length >= 2, 'multi-stage build');
    for (const f of froms) { assert.match(f, /^FROM\s+node:20[-\w.]*/i, f); }
  });

  it('runs as a non-root user', () => {
    const users = lines.filter((l) => /^USER\s/i.test(l));
    assert.ok(users.length > 0);
    const last = users[users.length - 1].trim().split(/\s+/)[1];
    assert.notEqual(last, 'root');
    assert.notEqual(last, '0');
  });

  it('never sets CI (CI=true would auto-approve ship gates)', () => {
    assert.doesNotMatch(body, /(^|\s)CI\s*=|ENV\s+CI\b|--build-arg\s+CI/m);
  });

  it('keeps state on a /data volume and points the server at it', () => {
    assert.match(body, /^VOLUME\s+\/data\b/m);
    assert.match(body, /MOAG_DATA_DIR=\/data\b/);
    assert.match(body, /MOAG_PROJECTS_ROOT=\/data\/workspaces\b/);
    assert.match(body, /MOAG_HOST=0\.0\.0\.0/);
  });

  it('exposes 8080, health-checks /healthz and starts the server entry', () => {
    assert.match(body, /^EXPOSE\s+8080\b/m);
    assert.match(body, /HEALTHCHECK[\s\S]*\/healthz/);
    assert.match(body, /^CMD\s+\["node",\s*"out\/server\/main\.js"\]/m);
  });

  it('installs only production dependencies at runtime and ships out/ and web/', () => {
    assert.match(body, /npm ci --omit=dev/);
    assert.match(body, /COPY --from=build \S+\/out \.\/out/);
    assert.match(body, /COPY web \.\/web/);
  });

  it('.dockerignore keeps the git dir, local state and build output out of the context', () => {
    const ignore = read('.dockerignore').split(/\r?\n/).map((l) => l.trim());
    for (const e of ['node_modules', 'out', '.git', '.moag', '*.vsix', '.vscode-test', '.claude']) {
      assert.ok(ignore.includes(e), e);
    }
  });

  it('the extension package excludes the Docker files', () => {
    const ignore = read('.vscodeignore').split(/\r?\n/).map((l) => l.trim());
    assert.ok(ignore.includes('Dockerfile'));
    assert.ok(ignore.includes('.dockerignore'));
  });

  it('docs/server.md covers TLS, bootstrap, backup, CLIs, the CI lock, passthrough and the same-uid residual', () => {
    const doc = read('docs/server.md');
    for (const s of ['MOAG_TRUST_PROXY=1', '__Host-moag_sid', 'MOAG_BOOTSTRAP_TOKEN', 'MOAG_MASTER_KEY_FILE',
      '## Data volume and backups', '## Engine CLIs and API keys', '## The CI lock', 'MOAG_RUN_ENV_PASSTHROUGH',
      '## Threat model', 'Agents run as the same OS user as the server', 'one instance per trust domain']) {
      assert.ok(doc.includes(s), s);
    }
  });
});
