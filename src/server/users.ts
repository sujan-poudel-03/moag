// ─── User store ───
//
// `users.json` under the data dir, written atomically (0600). Passwords are
// hashed here, so callers never hand the store a plaintext it could persist.
// Every security-relevant change (roles, disable/enable, password) bumps the
// user's `sessionEpoch`, which kills all of that user's sessions.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { writeFileAtomicSync } from '../utils/file-io';
import { WebRole, parseRoles } from './web-roles';
import { hashPassword } from './passwords';

export const USERS_FILE = 'users.json';
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const DISPLAY_NAME_MAX = 80;

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  roles: WebRole[];
  disabled: boolean;
  passwordHash: string;
  mustChangePassword: boolean;
  sessionEpoch: number;
  createdAt: string;
}

/** A user as it may leave the server — no password hash. */
export type PublicUser = Omit<UserRecord, 'passwordHash'>;

interface UsersFile { schemaVersion: 1; users: UserRecord[]; }

export class LastAdminError extends Error {
  constructor() { super('At least one active admin is required.'); this.name = 'LastAdminError'; }
}
export class UsernameTakenError extends Error {
  constructor() { super('That username is already taken.'); this.name = 'UsernameTakenError'; }
}
export class InvalidUserInputError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidUserInputError'; }
}
export class UserNotFoundError extends Error {
  constructor() { super('User not found.'); this.name = 'UserNotFoundError'; }
}

/** Strip the password hash. */
export function toPublicUser(u: UserRecord): PublicUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash: _omit, ...rest } = u;
  return { ...rest, roles: [...rest.roles] };
}

export interface CreateUserInput {
  username: string;
  displayName?: string;
  roles: unknown;
  password: string;
  mustChangePassword?: boolean;
}

export class UserStore {
  private readonly filePath: string;
  private users: UserRecord[];

  constructor(dataDir: string, private readonly now: () => Date = () => new Date()) {
    this.filePath = path.join(dataDir, USERS_FILE);
    this.users = this.load();
  }

  list(): UserRecord[] { return this.users.map((u) => ({ ...u, roles: [...u.roles] })); }

  findById(id: string): UserRecord | undefined {
    const u = this.users.find((x) => x.id === id);
    return u ? { ...u, roles: [...u.roles] } : undefined;
  }

  /** Case-insensitive lookup. */
  findByUsername(username: unknown): UserRecord | undefined {
    if (typeof username !== 'string') { return undefined; }
    const key = username.trim().toLowerCase();
    const u = this.users.find((x) => x.username === key);
    return u ? { ...u, roles: [...u.roles] } : undefined;
  }

  countActiveAdmins(): number {
    return this.users.filter((u) => !u.disabled && u.roles.includes('admin')).length;
  }

  /** Create a user, hashing `password`. Throws on invalid input or a taken username. */
  async create(input: CreateUserInput): Promise<UserRecord> {
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(username)) {
      throw new InvalidUserInputError('Username must be 2-32 characters: lowercase letters, digits, ".", "_" or "-".');
    }
    const roles = parseRoles(input.roles);
    if (!roles) { throw new InvalidUserInputError('Roles must be a non-empty list of known roles.'); }
    const displayName = (input.displayName ?? username).trim().slice(0, DISPLAY_NAME_MAX) || username;
    if (this.findByUsername(username)) { throw new UsernameTakenError(); }

    const passwordHash = await hashPassword(input.password);
    // Re-check after the await: another create may have won the race.
    if (this.findByUsername(username)) { throw new UsernameTakenError(); }

    const rec: UserRecord = {
      id: randomUUID(),
      username,
      displayName,
      roles,
      disabled: false,
      passwordHash,
      mustChangePassword: input.mustChangePassword ?? false,
      sessionEpoch: 1,
      createdAt: this.now().toISOString(),
    };
    this.users.push(rec);
    this.save();
    return { ...rec, roles: [...rec.roles] };
  }

  /** Replace a user's roles. Throws LastAdminError if this would leave no active admin. */
  setRoles(id: string, rolesRaw: unknown): UserRecord {
    const roles = parseRoles(rolesRaw);
    if (!roles) { throw new InvalidUserInputError('Roles must be a non-empty list of known roles.'); }
    const u = this.mustGet(id);
    if (!u.disabled && u.roles.includes('admin') && !roles.includes('admin') && this.countActiveAdmins() <= 1) {
      throw new LastAdminError();
    }
    u.roles = roles;
    u.sessionEpoch++;
    this.save();
    return { ...u, roles: [...u.roles] };
  }

  /** Disable a user. Throws LastAdminError for the last active admin. */
  disable(id: string): UserRecord {
    const u = this.mustGet(id);
    if (!u.disabled && u.roles.includes('admin') && this.countActiveAdmins() <= 1) {
      throw new LastAdminError();
    }
    u.disabled = true;
    u.sessionEpoch++;
    this.save();
    return { ...u, roles: [...u.roles] };
  }

  enable(id: string): UserRecord {
    const u = this.mustGet(id);
    u.disabled = false;
    u.sessionEpoch++;
    this.save();
    return { ...u, roles: [...u.roles] };
  }

  /** Set a new password (hashed here). `mustChangePassword` marks an admin-set temporary password. */
  async setPassword(id: string, password: string, mustChangePassword: boolean): Promise<UserRecord> {
    this.mustGet(id);
    const passwordHash = await hashPassword(password);
    const u = this.mustGet(id);
    u.passwordHash = passwordHash;
    u.mustChangePassword = mustChangePassword;
    u.sessionEpoch++;
    this.save();
    return { ...u, roles: [...u.roles] };
  }

  // ─── Internals ───

  private mustGet(id: string): UserRecord {
    const u = this.users.find((x) => x.id === id);
    if (!u) { throw new UserNotFoundError(); }
    return u;
  }

  private load(): UserRecord[] {
    let raw: string;
    try { raw = fs.readFileSync(this.filePath, 'utf-8'); } catch { return []; }
    const parsed = JSON.parse(raw) as Partial<UsersFile>;
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.users)) {
      throw new Error(`${USERS_FILE} has an unsupported format (expected schemaVersion 1).`);
    }
    return parsed.users;
  }

  private save(): void {
    const file: UsersFile = { schemaVersion: 1, users: this.users };
    writeFileAtomicSync(this.filePath, JSON.stringify(file, null, 2), 0o600);
  }
}
