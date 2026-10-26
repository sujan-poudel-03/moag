// ─── Report redaction — what leaves the machine in a bug report ─────────────
//
// Bug reports, feedback and diagnostics are posted publicly, so everything they
// carry passes through one redactor first:
//   1. exact secret values: the workspace .env files, engine API keys in the
//      environment, a few more token variables, and caller-supplied extras
//      (the Anthropic key from SecretStorage, the ONOSOO device key);
//   2. known secret shapes (sk-…, ghp_…, AWS keys, JWTs, PEM blocks);
//   3. paths: the workspace becomes `.`, the home folder `~`.
//
// Lives in ui/ because it composes headless/ helpers; utils/ stays fs/path-only.
// No `vscode` import: the caller passes cwd, home and env in.

import { createRedactor } from '../utils/redact';
import { reportingSecretValues } from '../headless/task-reporting';
import { scrubPaths } from '../headless/onosoo-relay';

/** Environment variables whose values are always treated as secrets in a report. */
const REPORT_SECRET_ENV = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'MOAG_ONOSOO_KEY',
] as const;

/** What a report says when redaction itself failed: never the unredacted text. */
export const REDACTION_FAILED_TEXT = '[report redaction failed; nothing included]';

export interface ReportRedactorOptions {
  /** Workspace root; null means no workspace (no .env is read). */
  cwd: string | null;
  /** The user's home folder, shortened to `~`; null to skip. */
  home: string | null;
  env: NodeJS.ProcessEnv;
  /** Exact values to remove in addition to the ones found here. */
  extraSecrets: readonly string[];
}

/**
 * Build the redactor every outbound report goes through.
 * The returned function never throws: on any failure it returns
 * {@link REDACTION_FAILED_TEXT} instead of the input.
 */
export function buildReportRedactor(o: ReportRedactorOptions): (text: string) => string {
  try {
    // Never reportingSecretValues('') — readEnvFileSecrets('') reads .env from the process cwd.
    const values = o.cwd ? reportingSecretValues(o.cwd, o.env, o.extraSecrets) : [...o.extraSecrets];
    for (const name of REPORT_SECRET_ENV) {
      const v = o.env[name];
      if (typeof v === 'string' && v.length > 0) { values.push(v); }
    }
    const redactor = createRedactor(values);
    return (text: string): string => {
      try {
        return scrubPaths(redactor.redact(text).text, o.cwd, o.home);
      } catch {
        return REDACTION_FAILED_TEXT;
      }
    };
  } catch {
    return () => REDACTION_FAILED_TEXT;
  }
}
