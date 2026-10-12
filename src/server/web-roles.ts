// ─── Web roles (server-owned closed enumeration) ───
//
// Roles for hosted-server accounts. Deliberately separate from `RoleId`
// (agent roles in the engine core): a web role grants HTTP permissions, an
// agent role shapes a prompt. Defined here and nowhere else.

export const WEB_ROLES = ['product-owner', 'reviewer', 'approver', 'admin'] as const;
export type WebRole = typeof WEB_ROLES[number];

/** True when `value` is exactly one of {@link WEB_ROLES}. */
export function isWebRole(value: unknown): value is WebRole {
  return typeof value === 'string' && (WEB_ROLES as readonly string[]).includes(value);
}

/**
 * Parse an untrusted role list. Returns the roles when `raw` is a non-empty
 * array of known, unique web roles; otherwise `null`.
 */
export function parseRoles(raw: unknown): WebRole[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WEB_ROLES.length) { return null; }
  const seen = new Set<WebRole>();
  for (const r of raw) {
    if (!isWebRole(r) || seen.has(r)) { return null; }
    seen.add(r);
  }
  return [...seen];
}
