// ─── User-facing copy (UX spec §4, C1–C28) ───
//
// One module for every user-visible message, in the `{ text, actions }` shape
// used by the extension's user-messages. Here an action is an in-app route or
// control id, never a VS Code command. Entries that need values are functions
// returning the same shape.

/** @typedef {{ text: string, actions: string[] }} Msg */

const m = (text, actions = []) => ({ text, actions });

export const STR = Object.freeze({
  C1: m('No projects yet. A project connects MOAG to one git repository.', ['route:/projects/new']),
  C1b: m('No projects yet. Ask a product owner to create one.'),
  C2: m('Write and save a PRD first. Plans, runs and trace all start from a saved PRD version.', ['route:prd']),
  C3: m('No requirements yet. Lines in your PRD\'s requirement list get IDs (R-1, R-2…) when you save a version.'),
  /** @param {string} label @param {string|null} bump */
  C4: (label, bump) => m(bump ? `Saved ${label}, recommended bump: ${bump}.` : `Saved ${label}.`),
  /** @param {string} label */
  C5: (label) => m(`${label} was saved by someone else while you were editing. Your text is still here. Review their version, then save again.`, ['control:show-latest']),
  /** @param {string} from @param {string} to @param {string} bump @param {string} recommended */
  C6: (from, to, bump, recommended) => m(`Change ${from} to ${to} (${bump})? MOAG recommended ${recommended}. Your choice and the recommendation are both recorded in the audit log.`, ['control:cancel', 'control:apply-bump']),
  /** @param {string} from @param {string} to */
  C7: (from, to) => m(`${from} relabelled to ${to}.`),
  /** @param {number} n @param {string} ids @param {string} engine @param {string} cap */
  C8: (n, ids, engine, cap) => m(`Generate a plan for ${n} requirement${n === 1 ? '' : 's'} (${ids}) using ${engine}? This calls the engine and counts toward the ${cap}. A reviewer must approve the plan before it can run.`, ['control:cancel', 'control:generate-plan']),
  C9: m('The bump is locked because a plan was already requested for this version.'),
  C10: m('Nothing to plan: this version adds or changes no requirements.'),
  C11: m('The engine couldn\'t generate a plan. Nothing was added to the plan.', ['control:try-again']),
  C12: m('The engine replied, but its plan couldn\'t be read. Nothing was added.', ['control:try-again']),
  C13: m('Every generated task was dropped by validation, so nothing was added.', ['control:try-again']),
  C14: m('This is the first version. Delta plans compare two versions, so save another version to plan changes.'),
  /** @param {string} name @param {number} n */
  C15: (name, n) => m(`Approve '${name}' (${n} task${n === 1 ? '' : 's'})? Approving lets a reviewer or admin start it. Starting it runs coding agents on the server inside this project's workspace.`, ['control:cancel', 'control:approve-plan']),
  C16: m('Plan rejected. The product owner can request a new one.'),
  /** @param {number} n @param {string} engine @param {string} project @param {string} capLeft */
  C16a: (n, engine, project, capLeft) => m(`Start ${n} task${n === 1 ? '' : 's'} with ${engine} in ${project}? Agents can read and change files in this project's workspace and run commands there. ${capLeft}`, ['control:cancel', 'control:start-run']),
  C16b: m('Stop this run? The task in progress is interrupted and its changes may be incomplete. Completed tasks stay completed.', ['control:keep-running', 'control:stop-run']),
  /** @param {string} gateName @param {string} who */
  C16c: (gateName, who) => m(`Approve and ship? The run resumes after "${gateName}". Recorded as approved by ${who}.`, ['control:cancel', 'control:approve-ship']),
  C16d: m('Ship rejected. The run has ended and nothing after the gate ran.'),
  C16e: m('Skip the ship gate without approval? The remaining tasks run as if approved. This is recorded as a skip, not an approval, with your reason.', ['control:cancel', 'control:skip-gate']),
  /** @param {string} engine @param {boolean} isAdmin */
  C17: (engine, isAdmin) => m(`${engine} isn't installed on this server, so this run can't start.${isAdmin ? '' : ' Ask an admin.'}`, isAdmin ? ['route:/admin/engines'] : []),
  C18: m('Runs are disabled: the server sets CI=true, which would auto-approve ship gates. An admin must unset CI and restart the server.'),
  C19: m('This project is busy with another job. Runs can start when it finishes.'),
  C20: m('Your session ended. Sign in again to continue. Your unsaved PRD text is kept.', ['control:sign-in']),
  C21: m('You don\'t have permission to do that. Your roles may have changed. Refresh to see what you can do.'),
  /** @param {string} what @param {string} who @param {string} when */
  C22: (what, who, when) => m(`Already ${what}${who ? ` by ${who}` : ''}${when ? ` at ${when}` : ''}.`),
  C23: m('Username or password is incorrect.'),
  C24: m('Too many failed sign-in attempts. Try again in 15 minutes.'),
  /** @param {string} user @param {string} roles */
  C25: (user, roles) => m(`Change ${user}'s roles to ${roles}? ${user} will be signed out of all sessions.`, ['control:cancel', 'control:change-roles']),
  C26: m('At least one active admin is required.'),
  /** @param {string} engine */
  C27: (engine) => m(`Clear the ${engine} API key? Runs that use ${engine} will fail until a new key is set. The key can't be recovered.`, ['control:cancel', 'control:clear-key']),
  /** @param {string} user */
  C28: (user) => m(`Disable ${user}? ${user} is signed out and can't sign in. Their audit history is kept.`, ['control:cancel', 'control:disable-user']),
  /** @param {string} entries e.g. ".claude/, .mcp.json" */
  C29: (entries) => m(`This repo ships engine config or agent instructions: ${entries}. An approved run starts the agent inside the repo, so they load: config can run commands (hooks, MCP servers) as the server's user, and instruction files steer what the agent does. Approve only if you trust this repository.`),
  /** @param {string} engine the project's current default engine */
  C30: (engine) => m(`The project's engine changed to ${engine} after this plan was approved, so it can't start. Switch the engine back in Settings or request a new plan.`),
});

/** Copy for a failed request whose server message should be shown as-is. */
export function serverMessage(resp, fallback = 'Something went wrong. Try again.') {
  const b = resp && resp.body;
  return (b && typeof b.message === 'string' && b.message) || fallback;
}
