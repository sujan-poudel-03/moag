// ─── Host agent: run recipe and host config ───

import { strict as assert } from 'assert';
import * as path from 'path';

import { parseHostConfig } from '../../../host/host-config';
import { draftFromCompose, draftFromPackageJson, findComposeFile, guessRole, parseRecipe } from '../../../host/recipe';

const ok = (text: unknown) => {
  const r = parseRecipe(JSON.stringify(text));
  if (!r.ok) { throw new Error(r.error); }
  return r.recipe;
};
const bad = (text: unknown): string => {
  const r = parseRecipe(JSON.stringify(text));
  assert.equal(r.ok, false, 'expected a refusal');
  return (r as { error: string }).error;
};

describe('host/recipe', () => {
  it('reads services, the web port and a reset command', () => {
    const r = ok({
      compose_file: 'docker-compose.yml',
      services: { web: { role: 'web', port: 5173 }, api: { role: 'api' }, db: { role: 'db' }, x: { role: 'nonsense' } },
      reset_db: { service: 'api', command: ['npm', 'run', 'db:reset'] },
    });
    assert.deepEqual(r.web, { service: 'web', port: 5173 });
    assert.deepEqual(r.roles, { web: 'web', api: 'api', db: 'db', x: 'other' });
    assert.deepEqual(r.resetDb, { service: 'api', command: ['npm', 'run', 'db:reset'] });
    assert.equal(r.composeFromProject, false);
  });

  it('reads a compose file kept in the approved folder', () => {
    const r = ok({ compose_file: '@project/.moag/compose.generated.yml', services: {} });
    assert.equal(r.composeFromProject, true);
    assert.equal(r.composeFile, '.moag/compose.generated.yml');
  });

  it('refuses a compose path that leaves the project', () => {
    assert.match(bad({ compose_file: '../other/docker-compose.yml' }), /relative path/);
    assert.match(bad({ compose_file: '/etc/compose.yml' }), /relative path/);
    assert.match(bad({ compose_file: 'C:/x.yml' }), /relative path/);
    assert.match(bad({ compose_file: '@project/../../x.yml' }), /relative path/);
  });

  it('needs exactly one web service, with its port', () => {
    assert.match(bad({ services: { a: { role: 'web', port: 1 }, b: { role: 'web', port: 2 } } }), /Only one/);
    assert.match(bad({ services: { web: { role: 'web' } } }), /port/);
    assert.match(bad({ services: { web: { role: 'web', port: 70000 } } }), /port/);
  });

  it('refuses a malformed reset command and odd service names', () => {
    assert.match(bad({ reset_db: { service: 'db', command: 'rm -rf /' } }), /reset_db/);
    assert.match(bad({ reset_db: { service: 'db', command: [] } }), /reset_db/);
    assert.match(bad({ services: { 'a b': { role: 'api' } } }), /not valid/);
  });

  it('guesses roles from service names', () => {
    assert.equal(guessRole('frontend'), 'web');
    assert.equal(guessRole('web-app'), 'web');
    assert.equal(guessRole('api'), 'api');
    assert.equal(guessRole('postgres'), 'db');
    assert.equal(guessRole('worker'), 'worker');
    assert.equal(guessRole('redis'), 'other');
  });

  it('finds the project\'s own compose file', () => {
    assert.equal(findComposeFile((n) => n === 'docker-compose.yml'), 'docker-compose.yml');
    assert.equal(findComposeFile(() => false), null);
  });

  it('drafts from a compose file with one web service at most', () => {
    const d = draftFromCompose('compose.yaml', ['web', 'frontend', 'api', 'postgres']);
    const services = d.recipe.services as Record<string, { role: string }>;
    assert.equal(services.web.role, 'web');
    assert.equal(services.frontend.role, 'other');
    assert.equal(services.postgres.role, 'db');
    assert.ok(parseRecipe(JSON.stringify(d.recipe)).ok, 'a draft parses');
  });

  it('drafts a compose file for a Vite or Next project, and nothing for an unknown one', () => {
    const vite = draftFromPackageJson(JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }));
    assert.ok(vite);
    assert.match(vite.generatedCompose ?? '', /--host 0\.0\.0\.0 --port 5173/);
    assert.equal((vite.recipe.services as Record<string, { port: number }>).web.port, 5173);
    assert.ok(parseRecipe(JSON.stringify(vite.recipe)).ok);
    const next = draftFromPackageJson(JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14' } }));
    assert.equal((next!.recipe.services as Record<string, { port: number }>).web.port, 3000);
    assert.equal(draftFromPackageJson(JSON.stringify({ scripts: { dev: 'x' } })), null);
    assert.equal(draftFromPackageJson('{not json'), null);
  });
});

describe('host/host-config', () => {
  const stateDir = path.resolve('/state/moag');

  it('needs a preview domain and fills sensible defaults', () => {
    const r = parseHostConfig(JSON.stringify({ preview_domain: 'Preview.Onosoo.com' }), stateDir);
    assert.ok(r.ok);
    if (!r.ok) { return; }
    assert.equal(r.config.previewDomain, 'preview.onosoo.com');
    assert.equal(r.config.gatewayPort, 8787);
    assert.equal(r.config.maxEnvironments, 4);
    assert.deepEqual(r.config.appOrigins, ['https://app.onosoo.com']);
    assert.equal(r.config.tunnelTokenFile, null);
    assert.equal(r.config.stateFile, path.join(stateDir, 'host', 'state.json'));
  });

  it('refuses a preview domain with a scheme, port or path', () => {
    for (const d of ['https://p.example.com', 'p.example.com:8443', 'p.example.com/x', 'localhost', '']) {
      assert.equal(parseHostConfig(JSON.stringify({ preview_domain: d }), stateDir).ok, false, d);
    }
  });

  it('keeps only https origins and an absolute tunnel token file', () => {
    const r = parseHostConfig(JSON.stringify({
      preview_domain: 'p.example.com',
      app_origins: ['https://app.example.com', 'http://evil.example.com', 'http://localhost:8080'],
      tunnel: { token_file: path.resolve('/secrets/token') },
    }), stateDir);
    assert.ok(r.ok);
    if (!r.ok) { return; }
    assert.deepEqual(r.config.appOrigins, ['https://app.example.com', 'http://localhost:8080']);
    assert.equal(r.config.tunnelTokenFile, path.resolve('/secrets/token'));
    assert.equal(parseHostConfig(JSON.stringify({ preview_domain: 'p.example.com', tunnel: { token_file: 'relative' } }), stateDir).ok, false);
  });

  it('clamps limits to safe ranges', () => {
    const r = parseHostConfig(JSON.stringify({ preview_domain: 'p.example.com', gateway: { port: 80 }, limits: { max_environments: 9999, memory_mb: 1 } }), stateDir);
    assert.ok(r.ok);
    if (!r.ok) { return; }
    assert.equal(r.config.gatewayPort, 8787);
    assert.equal(r.config.maxEnvironments, 4);
    assert.equal(r.config.memoryMb, 2048);
  });
});
