// ─── Tech stacks (server-owned closed enumeration) ───
//
// The stack a hosted project builds in. Stored on the server's project record
// only — never on `Plan` — and stamped onto recorded outcomes so the stack
// recommendation can group evidence by engine × stack. The enumeration itself is
// in shared/stacks.ts, because the standards profiles and the headless CLI ship
// in the extension and the server does not.

import type { StackId } from '../shared/stacks';

export type { StackId } from '../shared/stacks';
export { STACK_IDS, isStackId } from '../shared/stacks';

/** Fallback used when there is neither measured evidence nor a repo marker. */
export const STATIC_DEFAULT_STACK: StackId = 'node-ts';
