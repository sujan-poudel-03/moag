// ─── Anthropic API direct adapter ───
// Calls @anthropic-ai/sdk directly — no CLI required.
// Features: agentic tool-use loop (read/write/bash), real extended thinking,
// multi-turn sessions per playlist, live streaming output, browser vision.

import { getConfig } from '../core/host';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { EngineAdapter, EngineRunOptions } from './engine';
import { EngineResult, EngineId, TokenUsage } from '../models/types';
import { capturePageScreenshotBase64, runPlaywrightSpec } from '../sandbox/browser-driver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySDK = any;

interface MessageParam {
  role: 'user' | 'assistant';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: string | any[];
}

/** A tool result content block — either plain text or an image array */
type ToolResultContent = string | Array<{ type: string; [key: string]: unknown }>;

const MAX_AGENT_ITERATIONS = 40;
const MAX_SESSION_TURNS = 20;
const TOOL_TIMEOUT_MS = 60_000;
/** Cap run_bash output so a runaway agent can't OOM the extension host. */
const MAX_TOOL_OUTPUT_BYTES = 1 * 1024 * 1024;

const AGENT_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the full contents of a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace root or absolute).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating it and parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace root or absolute).' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories inside a directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_bash',
    description: 'Execute a shell command and return its combined stdout+stderr output.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Working directory override (optional).' },
      },
      required: ['command'],
    },
  },
];

const BROWSER_TOOLS = [
  {
    name: 'take_screenshot',
    description: 'Capture a full-page screenshot of a URL and return it as an image for visual analysis.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to screenshot. Omit to use the sandbox URL provided in context.',
        },
      },
      required: [],
    },
  },
  {
    name: 'run_playwright_test',
    description: 'Run a Playwright test spec file and return its output.',
    input_schema: {
      type: 'object',
      properties: {
        spec_file: { type: 'string', description: 'Path to the Playwright spec file (relative to cwd).' },
        cwd: { type: 'string', description: 'Working directory override (optional).' },
      },
      required: ['spec_file'],
    },
  },
];

export class AnthropicAdapter implements EngineAdapter {
  readonly id: EngineId = 'anthropic';
  readonly displayName = 'Anthropic API';

  private _sessions = new Map<string, MessageParam[]>();

  getCommand(): string {
    return 'anthropic-api';
  }

  clearSession(sessionId: string): void {
    this._sessions.delete(sessionId);
  }

  clearAllSessions(): void {
    this._sessions.clear();
  }

  async runTask(options: EngineRunOptions): Promise<EngineResult> {
    const cfg = getConfig('agentTaskPlayer.engines.anthropic');
    const apiKey = cfg.get<string>('apiKey', '') || process.env.ANTHROPIC_API_KEY || '';

    if (!apiKey) {
      return {
        stdout: '',
        stderr:
          '[Anthropic] API key not configured.\n' +
          'Set the ANTHROPIC_API_KEY environment variable, or add it in:\n' +
          'Settings → agentTaskPlayer.engines.anthropic.apiKey',
        exitCode: 1,
        durationMs: 0,
      };
    }

    let sdk: AnySDK;
    try {
      sdk = require('@anthropic-ai/sdk');
    } catch {
      return {
        stdout: '',
        stderr:
          '[Anthropic] SDK not installed.\n' +
          'Run: npm install @anthropic-ai/sdk\n' +
          'inside the MOAG extension directory, then reload VS Code.',
        exitCode: 1,
        durationMs: 0,
      };
    }

    const model = options.modelId
      ?? cfg.get<string>('model', 'claude-sonnet-4-6');
    const maxTokens = cfg.get<number>('maxTokens', 16_000);
    const extendedThinking = cfg.get<boolean>('extendedThinking', false);
    const thinkingBudget = cfg.get<number>('thinkingBudget', 10_000);
    const multiTurn = cfg.get<boolean>('multiTurn', true);

    const AnthropicClass = sdk.default ?? sdk.Anthropic ?? sdk;
    const client = new AnthropicClass({ apiKey });

    const startTime = Date.now();

    // Multi-turn: load prior history for this playlist session
    const sessionId = options.sessionId;
    const priorHistory: MessageParam[] = (multiTurn && sessionId)
      ? (this._sessions.get(sessionId) ?? [])
      : [];

    const messages: MessageParam[] = [
      ...priorHistory,
      { role: 'user', content: options.prompt },
    ];

    let stdout = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let iteration = 0;

    options.onOutput?.(
      `── Anthropic API (${model})${extendedThinking ? ' + Extended Thinking' : ''} ──\n\n`,
      'stdout',
    );

    try {
      while (iteration++ < MAX_AGENT_ITERATIONS) {
        if (options.signal?.aborted) { break; }

        const activeTools = options.browserEnabled
          ? [...AGENT_TOOLS, ...BROWSER_TOOLS]
          : AGENT_TOOLS;

        const requestParams: AnySDK = {
          model,
          max_tokens: extendedThinking ? maxTokens + thinkingBudget : maxTokens,
          messages,
          tools: activeTools,
          tool_choice: { type: 'auto' },
        };

        if (extendedThinking) {
          requestParams.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
        }

        // Stream the response for live output. Passing the abort signal cancels the
        // HTTP request itself, so a stopped task stops costing money mid-stream.
        const stream = client.messages.stream(requestParams, { signal: options.signal });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolInputAccumulators = new Map<number, { id: string; name: string; json: string }>();

        for await (const event of stream) {
          if (options.signal?.aborted) { break; }

          if (event.type === 'content_block_start') {
            const blk = event.content_block;
            if (blk.type === 'tool_use') {
              toolInputAccumulators.set(event.index, { id: blk.id, name: blk.name, json: '' });
            }
          }

          if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              stdout += delta.text;
              options.onOutput?.(delta.text, 'stdout');
            } else if (delta.type === 'thinking_delta') {
              options.onOutput?.(`│ ${delta.thinking}`, 'stdout');
            } else if (delta.type === 'input_json_delta') {
              const acc = toolInputAccumulators.get(event.index);
              if (acc) { acc.json += delta.partial_json; }
            }
          }
        }

        if (options.signal?.aborted) { break; }

        const finalMsg = await stream.finalMessage();
        totalInputTokens += finalMsg.usage?.input_tokens ?? 0;
        totalOutputTokens += finalMsg.usage?.output_tokens ?? 0;

        if (finalMsg.stop_reason === 'end_turn') {
          // Save session for next task in this playlist
          if (multiTurn && sessionId) {
            const updatedHistory: MessageParam[] = [
              ...messages,
              { role: 'assistant', content: finalMsg.content },
            ];
            this._sessions.set(sessionId, updatedHistory.slice(-MAX_SESSION_TURNS));
          }
          break;
        }

        if (finalMsg.stop_reason === 'tool_use') {
          // Add assistant turn to conversation
          messages.push({ role: 'assistant', content: finalMsg.content });

          // Execute each tool call and collect results
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolResults: any[] = [];
          for (const block of finalMsg.content) {
            if (block.type !== 'tool_use') { continue; }

            options.onOutput?.(`\n[▶ ${block.name}] `, 'stdout');
            const result = await this.executeTool(
              block.name,
              block.input as Record<string, string>,
              options.cwd,
              options.signal,
              options.sandboxUrl,
            );
            const preview = typeof result === 'string'
              ? (result.length > 300 ? result.slice(0, 300) + '…' : result)
              : '[Screenshot captured]';
            options.onOutput?.(preview + '\n', 'stdout');

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            });
          }

          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        // max_tokens or other stop — break out
        break;
      }
    } catch (err) {
      // An abort is a stop, not a failure: fall through to the normal return with
      // whatever streamed before cancellation (same as the in-loop abort breaks above).
      if (!this.isAbortError(err, options.signal)) {
        const msg = err instanceof Error ? err.message : String(err);
        options.onOutput?.(`\n[Anthropic Error] ${msg}\n`, 'stderr');
        return {
          stdout,
          stderr: msg,
          exitCode: 1,
          durationMs: Date.now() - startTime,
          tokenUsage: this.buildUsage(totalInputTokens, totalOutputTokens),
        };
      }
      options.onOutput?.('\n[Anthropic] Request cancelled.\n', 'stdout');
    }

    const tokenUsage = this.buildUsage(totalInputTokens, totalOutputTokens);
    return {
      stdout,
      stderr: '',
      exitCode: 0,
      durationMs: Date.now() - startTime,
      tokenUsage,
    };
  }

  /**
   * True when an SDK error is our AbortSignal firing rather than a real API failure.
   * The SDK raises APIUserAbortError; the underlying fetch raises AbortError.
   */
  private isAbortError(err: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) { return true; }
    const name = (err as { name?: string } | null)?.name ?? '';
    return name === 'AbortError' || name === 'APIUserAbortError';
  }

  // ─── Tool execution ───────────────────────────────────────────────────────

  private async executeTool(
    name: string,
    input: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
    sandboxUrl?: string,
  ): Promise<ToolResultContent> {
    try {
      switch (name) {
        case 'read_file': {
          const resolved = this.resolvePath(input.path, cwd);
          return fs.readFileSync(resolved, 'utf-8');
        }
        case 'write_file': {
          const resolved = this.resolvePath(input.path, cwd);
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, input.content, 'utf-8');
          return `Written ${resolved} (${input.content.length} chars)`;
        }
        case 'list_directory': {
          const resolved = this.resolvePath(input.path, cwd);
          const entries = fs.readdirSync(resolved, { withFileTypes: true });
          return entries
            .map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
            .join('\n');
        }
        case 'run_bash': {
          const bashCwd = input.cwd ? this.resolvePath(input.cwd, cwd) : cwd;
          return await this.runShell(input.command, bashCwd, signal);
        }
        case 'take_screenshot': {
          const url = input.url || sandboxUrl || '';
          if (!url) {
            return 'No URL provided. Pass a url argument or ensure the sandbox is running.';
          }
          const base64 = await capturePageScreenshotBase64(url, cwd);
          if (!base64) {
            return 'Screenshot failed — Playwright may not be installed. Run: npx playwright install chromium';
          }
          return [
            { type: 'text', text: `Screenshot of ${url}:` },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          ];
        }
        case 'run_playwright_test': {
          const specFile = input.spec_file || '';
          if (!specFile) { return 'Missing required argument: spec_file'; }
          const testCwd = input.cwd ? this.resolvePath(input.cwd, cwd) : cwd;
          return await runPlaywrightSpec(specFile, testCwd);
        }
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private resolvePath(filePath: string, cwd: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  }

  private runShell(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      const proc = spawn(command, [], {
        shell: true,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      proc.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutTruncated) { return; }
        const text = chunk.toString();
        if (stdout.length + text.length > MAX_TOOL_OUTPUT_BYTES) {
          stdout += text.slice(0, MAX_TOOL_OUTPUT_BYTES - stdout.length) + '\n…[output truncated at 1MB]';
          stdoutTruncated = true;
        } else {
          stdout += text;
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        if (stderrTruncated) { return; }
        const text = chunk.toString();
        if (stderr.length + text.length > MAX_TOOL_OUTPUT_BYTES) {
          stderr += text.slice(0, MAX_TOOL_OUTPUT_BYTES - stderr.length) + '\n…[output truncated at 1MB]';
          stderrTruncated = true;
        } else {
          stderr += text;
        }
      });

      const timeout = setTimeout(() => {
        proc.kill();
        resolve(`[Timeout after ${TOOL_TIMEOUT_MS / 1000}s]\n${stdout}${stderr}`);
      }, TOOL_TIMEOUT_MS);

      const onAbort = () => {
        clearTimeout(timeout);
        proc.kill();
        resolve(`[Aborted]\n${stdout}${stderr}`);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      proc.on('error', (err: Error) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        resolve(`Error: ${err.message}\n${stderr}`);
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const combined = [stdout, stderr].filter(Boolean).join('\n');
        resolve(code === 0 ? combined || '(no output)' : `[exit ${code}]\n${combined}`);
      });
    });
  }

  // ─── Token accounting ─────────────────────────────────────────────────────

  private buildUsage(inputTokens: number, outputTokens: number): TokenUsage | undefined {
    if (!inputTokens && !outputTokens) { return undefined; }
    const totalTokens = inputTokens + outputTokens;
    // Claude Sonnet pricing: $3/M input, $15/M output
    const estimatedCost =
      Math.round((inputTokens * 3.0 / 1_000_000 + outputTokens * 15.0 / 1_000_000) * 10_000) / 10_000;
    return { inputTokens, outputTokens, totalTokens, estimatedCost };
  }
}
