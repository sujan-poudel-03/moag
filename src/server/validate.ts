// ─── Request-body validators ───
//
// Tiny hand-written schema combinators (no runtime dependency). A validator
// either returns the typed value or throws `ValidationError`, which the HTTP
// layer maps to 400 BEFORE any side effect runs. `obj()` rejects unknown keys,
// so a client cannot smuggle fields a handler might later spread.

import { ENGINE_IDS, EngineId, SEMVER_BUMPS, SemverBump } from '../models/types';
import { STACK_IDS, StackId } from './stacks';
import { WebRole, parseRoles } from './web-roles';

export class ValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(field ? `${field}: ${message}` : message);
    this.name = 'ValidationError';
  }
}

export type Validator<T> = ((value: unknown, field: string) => T) & { optional?: boolean };

/** A string of `min..max` characters, optionally matching `re`. */
export function str(min: number, max: number, re?: RegExp): Validator<string> {
  return (v, field) => {
    if (typeof v !== 'string') { throw new ValidationError(field, 'expected a string'); }
    if (v.length < min || v.length > max) { throw new ValidationError(field, `expected ${min}-${max} characters`); }
    if (re && !re.test(v)) { throw new ValidationError(field, 'has an invalid format'); }
    return v;
  };
}

/** Exactly one of `values`. */
export function oneOf<T extends string>(values: readonly T[]): Validator<T> {
  return (v, field) => {
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      throw new ValidationError(field, `expected one of ${values.join(', ')}`);
    }
    return v as T;
  };
}

export function bool(): Validator<boolean> {
  return (v, field) => {
    if (typeof v !== 'boolean') { throw new ValidationError(field, 'expected a boolean'); }
    return v;
  };
}

/** A finite number in `[min, max]`, optionally an integer. */
export function num(min: number, max: number, opts: { integer?: boolean } = {}): Validator<number> {
  return (v, field) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { throw new ValidationError(field, 'expected a finite number'); }
    if (opts.integer && !Number.isInteger(v)) { throw new ValidationError(field, 'expected an integer'); }
    if (v < min || v > max) { throw new ValidationError(field, `expected a number between ${min} and ${max}`); }
    return v;
  };
}

/** Mark a field optional: `undefined` passes through, anything else is validated. */
export function opt<T>(inner: Validator<T>): Validator<T | undefined> {
  const v: Validator<T | undefined> = (value, field) => (value === undefined ? undefined : inner(value, field));
  v.optional = true;
  return v;
}

/** Nullable: `null` passes through. */
export function nullable<T>(inner: Validator<T>): Validator<T | null> {
  return (value, field) => (value === null ? null : inner(value, field));
}

type Shape = Record<string, Validator<unknown>>;
export type Infer<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

/** A plain object with exactly the keys of `shape` (unknown keys rejected). */
export function obj<S extends Shape>(shape: S): Validator<Infer<S>> {
  return (v, field) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new ValidationError(field, 'expected an object');
    }
    const src = v as Record<string, unknown>;
    for (const k of Object.keys(src)) {
      if (!Object.prototype.hasOwnProperty.call(shape, k)) {
        throw new ValidationError(field ? `${field}.${k}` : k, 'unknown field');
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(shape)) {
      const sub = field ? `${field}.${k}` : k;
      if (src[k] === undefined && !val.optional) { throw new ValidationError(sub, 'is required'); }
      const parsed = val(src[k], sub);
      if (parsed !== undefined) { out[k] = parsed; }
    }
    return out as Infer<S>;
  };
}

// ─── Domain guards ───

export const engineId: Validator<EngineId> = oneOf(ENGINE_IDS);
export const bump: Validator<SemverBump> = oneOf(SEMVER_BUMPS);
export const stack: Validator<StackId> = oneOf(STACK_IDS);
export const roles: Validator<WebRole[]> = (v, field) => {
  const r = parseRoles(v);
  if (!r) { throw new ValidationError(field, 'expected a non-empty list of unique, known roles'); }
  return r;
};

/** Run a validator over a request body. */
export function parseBody<T>(validator: Validator<T>, body: unknown): T {
  return validator(body, '');
}
