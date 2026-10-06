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
  /** @param {number} n @param {string} state the project's standards state: pending | rejected | none */
  C31: (n, state) => m(
    state === 'pending' ? `Plans can't be generated yet. Standards v${n} is waiting for a reviewer; plans start once it is approved.`
      : state === 'rejected' ? `Plans can't be generated yet. Standards v${n} was rejected. Edit it and submit it again.`
        : 'Plans can\'t be generated yet. This project has no approved standards.',
    ['route:standards']),
  /** @param {number} n @param {number} k number of commands in the version */
  C32: (n, k) => m(`Approve standards v${n}? Every plan and agent prompt in this project will carry it, and every run is checked against it. ${k === 0 ? 'It runs no commands.' : `Its ${k} command${k === 1 ? '' : 's'} will run in the project workspace on every run, exactly as shown.`}`,
    ['control:cancel', 'control:approve-standards']),
  /** @param {number} n @param {number|null} inEffect the version that stays in effect, if any */
  C33: (n, inEffect) => m(`Standards v${n} rejected. ${inEffect ? `v${inEffect} stays in effect.` : 'The product owner can edit and submit again.'}`),
  /** @param {number} n @param {string} stack */
  C34: (n, stack) => m(`Accept standards v${n} without a reviewer? MOAG generated it from the repository and the ${stack} defaults, and nobody has reviewed it. It takes effect now and unblocks plan generation. The audit log records this as defaults accepted by you, not as a review.`,
    ['control:cancel', 'control:accept-defaults']),
  /** @param {number} n @param {number|null} inEffect */
  C35: (n, inEffect) => m(`Standards v${n} submitted for review.${inEffect ? ` v${inEffect} stays in effect until a reviewer approves it.` : ''}`),
  C36: m('Someone else proposed a newer version while you were editing. Your changes are still here. Review their version, then submit again.', ['control:show-latest']),
  C37: m('These standards changed after you opened them, so nothing was approved. Review the current version.'),
  /** @param {number} planV @param {number} nowV */
  C38: (planV, nowV) => m(`Standards v${nowV} was approved after this plan was generated under v${planV}. The run will use v${nowV}.`),
  C39: m('This run had no standards version. Its plan was approved before the project had standards, so nothing was checked and no version is recorded on the trace.'),
  C40: m('Not checked means MOAG could not decide the rule for these files, or the profile does not configure it. It is not a pass.'),
  /** @param {number} rules @param {number} findings */
  C41: (rules, findings) => m(`Standards stopped the release: ${rules} blocking rule${rules === 1 ? '' : 's'} or command${rules === 1 ? '' : 's'}, ${findings} finding${findings === 1 ? '' : 's'}. Nothing was marked shipped.`, ['control:view-standards-report']),
  /** @param {number} n @param {number} cap */
  C42: (n, cap) => m(`Free-text rules are ${n} characters. The limit is ${cap}.`),
  C43: m('This project was created before project standards existed. New plans are blocked until a reviewer approves the proposed standards or an admin accepts the defaults. Plans that are already approved can still run; those runs are not checked.'),
  C44: m('After you create the project, MOAG proposes standards from the repository and this stack. A reviewer approves them before the first plan can be generated.'),
  C45: m('Shown exactly as written. Approving lets these commands run in the project workspace on every run.'),
  C46: m('Standards are not approved for this project, so this can\'t continue.', ['route:standards']),
  C47: m('MOAG blocks on your project\'s own tools: a command (a real linter, formatter, type-checker or test) always blocks and is judged by its exit code. Every rule MOAG checks itself is advisory by default: it is reported with file, line and rule, says "findings" or "no findings", is never said to have passed, and stops nothing unless you promote it to blocking here.'),
  /** @param {number} n */
  C48: (n) => m(`${n} blocking rule${n === 1 ? '' : 's'} or command${n === 1 ? ' was' : 's were'} not checked. That is not a pass: nothing failed because nothing was evaluated, and the release is stopped.`),
  C49: m('Advisory findings come from heuristic scans, which can flag correct code and can miss real violations. They are shown to the reviewer and the approver and do not stop the run.'),
  C50: m('Changing a rule between blocking and advisory changes what can stop a release. It is a new version for a reviewer to approve, and it is recorded in the audit log.'),
  /** @param {number} n @param {number|null} approved the approved version it is compared with, or null for the defaults */
  C51: (n, approved) => m(`This version changes what can stop a release: ${n} rule${n === 1 ? '' : 's'} differ${n === 1 ? 's' : ''} from ${approved ? `v${approved}, the approved version before it` : 'the defaults (nothing was approved before it)'}.`),
  /** @param {string} rules the promoted scanner rules, comma-separated */
  C52: (rules) => m(`Heuristic rules that can stop a release here: ${rules}. Scanner rules are heuristic: as blocking rules they can stop correct code, and they can miss real violations.`),
  C53: m('These were not read by the line rules: vendored or generated files, file types MOAG has no scanner for, unreadable files, and directories that are repositories of their own (a nested repository or a submodule). Nothing in them counts towards "no findings".'),
  /** @param {number|null} approved the approved version it is compared with, or null */
  C55: (approved) => m(`Enforcement changes: this version differs from ${approved ? `v${approved}, the approved version before it,` : 'an empty baseline (nothing was approved before it)'} in what can stop a release. Every difference is shown below, before and after. MOAG does not judge whether a change tightens or loosens; read each line before approving.`),
  C56: m('Nothing was approved: this version changes what can stop a release, and the request did not confirm that you saw those changes. Tick the confirmation under the enforcement changes, then approve again.'),
  /** @param {number} n the version */
  C57: (n) => m(`I have read the enforcement changes of standards v${n} shown above (commands, rule severity, required directories) and approve them as they are.`),
  C58: m('No blocking rules configured: this profile has no command and no promoted rule, so nothing here can stop a release, and nothing here passed. MOAG blocks on your project\'s own tools; add a command to the standards to make a check binding.'),
  /** @param {number} failed @param {number} notChecked */
  C59: (failed, notChecked) => m(`This ship can't be approved yet: the standards check before the gate shows ${failed > 0 ? `${failed} blocking rule${failed === 1 ? '' : 's'} or command${failed === 1 ? '' : 's'} failed` : `${notChecked} blocking rule${notChecked === 1 ? '' : 's'} or command${notChecked === 1 ? '' : 's'} not checked`}. Reject the ship, or fix the work and run again.`, ['control:view-standards-report']),
  /** @param {string} rule the scanner rule being made blocking */
  C54: (rule) => m(`Heuristic rule. As a blocking rule, ${rule} can stop correct code and can miss real violations. Prefer a command (a linter, formatter or test) for anything that must stop a release.`),
});

/** Copy for a failed request whose server message should be shown as-is. */
export function serverMessage(resp, fallback = 'Something went wrong. Try again.') {
  const b = resp && resp.body;
  return (b && typeof b.message === 'string' && b.message) || fallback;
}
