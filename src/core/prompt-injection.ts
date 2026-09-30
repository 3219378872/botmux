import { getBot } from '../bot-registry.js';
import type { LarkAttachment } from '../types.js';
import { supportsTranscriptReplyDelivery, supportsZeroPromptStructuredBridge } from '../services/structured-bridge-clis.js';
import type { DaemonSession } from './types.js';

export type PromptInjection = 'default' | 'none';

/** Whether a spawn runs in ANY local file sandbox (legacy bwrap oncall OR the
 *  full-root scratch COW), across the config flag, read isolation and the
 *  machine-wide BOTMUX_SANDBOX switch. Normalises the tri-state sandbox value
 *  master introduced ('off' | 'oncall' | 'scratch'). */
export function isSandboxRequested(opts?: {
  sandbox?: boolean | 'off' | 'oncall' | 'scratch';
  readIsolation?: boolean;
}): boolean {
  if (opts?.readIsolation) return true;
  if (opts?.sandbox === true || opts?.sandbox === 'oncall' || opts?.sandbox === 'scratch') return true;
  if (opts?.sandbox !== undefined) return false;
 return process.env.BOTMUX_SANDBOX === '1';
}

export type ZeroPromptSandboxValue = boolean | 'off' | 'oncall' | 'scratch';

/** Whether a spawn runs in the full-root COW scratch sandbox (as opposed to
 *  the deny-by-default oncall bwrap). Scratch bind-mounts a merged overlay as
 *  the container root and does NOT honor the adapter authPaths directory
 *  binds, so transcripts written under it live in the upper/merged tree. */
export function isScratchSandbox(opts?: {
  sandbox?: ZeroPromptSandboxValue;
  readIsolation?: boolean;
}): boolean {
  return opts?.sandbox === 'scratch';
}

/** Reuse the final-reply capability, rather than maintaining a second CLI
 * allowlist. Remote backends have their own prompt/decorate contracts.
 *
 * Two harvest channels qualify:
 *  - the ordinary transcript-reply CLIs (claude-code via its own bridge + the
 *    structured ALWAYS set), which deliver finals in every injection mode;
 *  - the zero-prompt-only structured CLIs (cursor / antigravity), whose bridge
 *    activates ONLY while promptInjection:'none' — default mode they answer via
 *    `botmux send` instead.
 *
 * Sandbox: cursor/antigravity are supported under the oncall bwrap sandbox
 * (and read isolation / the BOTMUX_SANDBOX switch) — their adapters declare
 * the whole `~/.cursor` / `~/.gemini` tree as readWrite authPaths, which
 * bind-mount the REAL host directories, so the daemon tails the same files the
 * CLI writes (this also keeps cursor's store.db fcntl locks working).
 *
 * The full-root COW `sandbox: 'scratch'` mode is rejected for these two for
 * now: it bind-mounts a merged overlay as / and ignores authPaths, so their
 * transcripts land in the upper tree the host-side structured bridge does not
 * resolve yet (the existing structured bridges codex/grok have the same open
 * gap). Fail loudly here rather than silently dropping every reply. */
export function supportsZeroPromptInjection(cliId: string | undefined, opts?: {
  backendType?: string; codexRpcInput?: boolean;
  sandbox?: ZeroPromptSandboxValue;
  readIsolation?: boolean;
}): boolean {
  const localTranscript = supportsTranscriptReplyDelivery(cliId)
    || supportsZeroPromptStructuredBridge(cliId);
  if (!localTranscript) return false;
  if (opts?.backendType && !['pty', 'tmux', 'herdr', 'zellij', 'zmx'].includes(opts.backendType)) {
    return false;
  }
  if ((cliId === 'cursor' || cliId === 'antigravity') && isScratchSandbox(opts)) {
    return false;
  }
  return true;
}

export function sessionPromptInjection(ds: Pick<DaemonSession, 'session' | 'initConfig'>): PromptInjection {
  // Historical/adopted sessions predate this setting and retain their original
  // input contract. A live worker snapshot also covers an in-place upgrade.
  return ds.session.promptInjection ?? ds.initConfig?.promptInjection ?? 'default';
}

export function zeroPromptInjectionForBot(larkAppId?: string, cliId?: string, frozen?: PromptInjection): boolean {
  if (frozen !== undefined) return frozen === 'none';
  if (!larkAppId) return false;
  try {
    const cfg = getBot(larkAppId).config;
    return cfg.promptInjection === 'none' && supportsZeroPromptInjection(cliId ?? cfg.cliId, cfg);
  } catch {
    return false;
  }
}

/** Attachment names and paths are input data, not instructions. Deliberately
 * bypass customizable prompt fragments, even for the attachment label. */
export function buildZeroPromptInput(content: string, attachments?: LarkAttachment[]): string {
  if (!attachments?.length) return content;
  return [content, ...attachments.map(a => `[${a.type}] ${a.name}: ${a.path}`)].join('\n\n');
}
