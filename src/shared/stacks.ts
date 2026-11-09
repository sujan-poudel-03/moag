// ─── Tech stacks (closed enumeration, shared) ───
//
// The stack a hosted project builds in. The server stores it on its project
// record only — never on `Plan` — and stamps it onto recorded outcomes so the
// stack recommendation can group evidence by engine × stack. The standards
// profiles and the headless CLI name stacks too, and they ship in the extension
// while the server does not, so the enumeration lives here (`server/stacks.ts`
// re-exports it).

export const STACK_IDS = ['node-ts', 'python', 'go', 'java', 'dotnet', 'static-web', 'other'] as const;
export type StackId = typeof STACK_IDS[number];

/** True when `value` is exactly one of {@link STACK_IDS}. */
export function isStackId(value: unknown): value is StackId {
  return typeof value === 'string' && (STACK_IDS as readonly string[]).includes(value);
}
