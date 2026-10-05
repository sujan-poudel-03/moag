// ─── Tech stacks (server-owned closed enumeration) ───
//
// The stack a hosted project builds in. Stored on the server's project record
// only — never on `Plan` — and stamped onto recorded outcomes so the stack
// recommendation can group evidence by engine × stack.

export const STACK_IDS = ['node-ts', 'python', 'go', 'java', 'dotnet', 'static-web', 'other'] as const;
export type StackId = typeof STACK_IDS[number];

/** Fallback used when there is neither measured evidence nor a repo marker. */
export const STATIC_DEFAULT_STACK: StackId = 'node-ts';

/** True when `value` is exactly one of {@link STACK_IDS}. */
export function isStackId(value: unknown): value is StackId {
  return typeof value === 'string' && (STACK_IDS as readonly string[]).includes(value);
}
