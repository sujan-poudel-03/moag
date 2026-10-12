import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  UserStore, LastAdminError, UsernameTakenError, InvalidUserInputError, UserNotFoundError, toPublicUser, USERS_FILE,
} from '../../../server/users';
import { verifyPassword } from '../../../server/passwords';

describe('UserStore', function () {
  this.timeout(20000);
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-users-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const PW = 'Plaintext-Never-Stored-42';
  const raw = () => fs.readFileSync(path.join(dir, USERS_FILE), 'utf-8');

  it('creates a user whose raw file never contains the plaintext password', async () => {
    const store = new UserStore(dir);
    const u = await store.create({ username: 'Dana', displayName: 'Dana Ruiz', roles: ['product-owner'], password: PW });
    assert.equal(u.username, 'dana');
    assert.equal(raw().includes(PW), false);
    assert.equal(await verifyPassword(PW, store.findById(u.id)?.passwordHash), true);
    assert.equal(JSON.parse(raw()).schemaVersion, 1);
  });

  it('persists across instances and finds usernames case-insensitively', async () => {
    const u = await new UserStore(dir).create({ username: 'sam', roles: ['reviewer'], password: PW });
    const again = new UserStore(dir);
    assert.equal(again.findByUsername('SAM')?.id, u.id);
    assert.equal(again.findByUsername(' sam ')?.id, u.id);
    assert.equal(again.findByUsername('nobody'), undefined);
    assert.equal(again.findByUsername(undefined), undefined);
  });

  it('rejects invalid usernames, bad roles and duplicates', async () => {
    const store = new UserStore(dir);
    await assert.rejects(store.create({ username: '-bad', roles: ['admin'], password: PW }), InvalidUserInputError);
    await assert.rejects(store.create({ username: 'a', roles: ['admin'], password: PW }), InvalidUserInputError);
    await assert.rejects(store.create({ username: 'x y', roles: ['admin'], password: PW }), InvalidUserInputError);
    await assert.rejects(store.create({ username: 'ok', roles: ['architect'], password: PW }), InvalidUserInputError);
    await assert.rejects(store.create({ username: 'ok', roles: [], password: PW }), InvalidUserInputError);
    await store.create({ username: 'kim', roles: ['approver'], password: PW });
    await assert.rejects(store.create({ username: 'KIM', roles: ['approver'], password: PW }), UsernameTakenError);
  });

  it('two concurrent creates of the same username: exactly one wins', async () => {
    const store = new UserStore(dir);
    const results = await Promise.allSettled([
      store.create({ username: 'race', roles: ['admin'], password: PW }),
      store.create({ username: 'race', roles: ['admin'], password: PW }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(store.list().length, 1);
  });

  it('guards the last active admin on setRoles and disable', async () => {
    const store = new UserStore(dir);
    const admin = await store.create({ username: 'root', roles: ['admin'], password: PW });
    assert.throws(() => store.setRoles(admin.id, ['reviewer']), LastAdminError);
    assert.throws(() => store.disable(admin.id), LastAdminError);
    assert.deepEqual(store.findById(admin.id)?.roles, ['admin'], 'no partial write');
    assert.equal(store.findById(admin.id)?.disabled, false);

    const second = await store.create({ username: 'ops', roles: ['admin', 'reviewer'], password: PW });
    store.setRoles(admin.id, ['reviewer']);
    assert.equal(store.countActiveAdmins(), 1);
    assert.throws(() => store.disable(second.id), LastAdminError);
  });

  it('a disabled admin does not count as active', async () => {
    const store = new UserStore(dir);
    const a = await store.create({ username: 'a1', roles: ['admin'], password: PW });
    const b = await store.create({ username: 'b1', roles: ['admin'], password: PW });
    store.disable(a.id);
    assert.equal(store.countActiveAdmins(), 1);
    assert.throws(() => store.setRoles(b.id, ['approver']), LastAdminError);
  });

  it('bumps sessionEpoch on setRoles, disable, enable and setPassword', async () => {
    const store = new UserStore(dir);
    await store.create({ username: 'root', roles: ['admin'], password: PW });
    const u = await store.create({ username: 'dana', roles: ['product-owner'], password: PW });
    assert.equal(u.sessionEpoch, 1);
    assert.equal(store.setRoles(u.id, ['reviewer']).sessionEpoch, 2);
    assert.equal(store.disable(u.id).sessionEpoch, 3);
    assert.equal(store.enable(u.id).sessionEpoch, 4);
    const after = await store.setPassword(u.id, 'Another-Password-99', true);
    assert.equal(after.sessionEpoch, 5);
    assert.equal(after.mustChangePassword, true);
    assert.equal(raw().includes('Another-Password-99'), false);
    assert.equal(new UserStore(dir).findById(u.id)?.sessionEpoch, 5, 'persisted');
  });

  it('throws UserNotFoundError for an unknown id', async () => {
    const store = new UserStore(dir);
    assert.throws(() => store.disable('nope'), UserNotFoundError);
    await assert.rejects(store.setPassword('nope', PW, false), UserNotFoundError);
  });

  it('toPublicUser strips the hash', async () => {
    const u = await new UserStore(dir).create({ username: 'pub', roles: ['admin'], password: PW });
    const p = toPublicUser(u);
    assert.equal('passwordHash' in p, false);
    assert.equal(JSON.stringify(p).includes('scrypt$'), false);
  });

  it('refuses to load a corrupt users.json rather than treating it as empty', () => {
    // An empty user list would re-open the bootstrap path, so corruption must be loud.
    fs.writeFileSync(path.join(dir, USERS_FILE), '{"users":"oops"}');
    assert.throws(() => new UserStore(dir), /unsupported format/);
    fs.writeFileSync(path.join(dir, USERS_FILE), '{not json');
    assert.throws(() => new UserStore(dir));
  });
});
