/**
 * `src/core/prompt-injection.ts` 纯能力闸口：哪些 CLI 支持零注入（自动获取最终回复）。
 *
 * Run: vitest run --project unit test/prompt-injection.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => { throw new Error('not configured'); }),
}));

import { supportsZeroPromptInjection, sessionPromptInjection, isSandboxRequested } from '../src/core/prompt-injection.js';

describe('supportsZeroPromptInjection', () => {
  it('supports the classic transcript CLIs', () => {
    expect(supportsZeroPromptInjection('claude-code')).toBe(true);
    expect(supportsZeroPromptInjection('codex')).toBe(true);
    expect(supportsZeroPromptInjection('grok')).toBe(true);
  });

  it('supports cursor and antigravity', () => {
    expect(supportsZeroPromptInjection('cursor')).toBe(true);
    expect(supportsZeroPromptInjection('antigravity')).toBe(true);
  });

  it('keeps CLIs without a transcript bridge unsupported', () => {
    expect(supportsZeroPromptInjection('gemini')).toBe(false);
    expect(supportsZeroPromptInjection('kimi')).toBe(false);
    expect(supportsZeroPromptInjection(undefined)).toBe(false);
  });

  it('rejects remote backends even for otherwise-capable CLIs', () => {
    expect(supportsZeroPromptInjection('cursor', { backendType: 'pty' })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { backendType: 'tmux' })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { backendType: 'riff' })).toBe(false);
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'mojo' })).toBe(false);
    expect(supportsZeroPromptInjection('codex', { backendType: 'riff' })).toBe(false);
  });

  it('allows cursor/antigravity under the oncall bwrap sandbox (transcript dirs are directory-bound to the host fs)', () => {
    // ~/.cursor / ~/.gemini are adapter authPaths → real --bind in the oncall
    // bwrap, so the daemon reads the same transcript paths the CLI writes.
    expect(supportsZeroPromptInjection('cursor', { sandbox: true })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { sandbox: 'oncall' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: true, backendType: 'tmux' })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { readIsolation: true })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: false, readIsolation: true })).toBe(true);
  });

  it('rejects cursor/antigravity under the full-root scratch COW sandbox (structured bridge cannot resolve the merged tree yet)', () => {
    expect(supportsZeroPromptInjection('cursor', { sandbox: 'scratch' })).toBe(false);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: 'scratch', backendType: 'pty' })).toBe(false);
    // Explicit off is fine.
    expect(supportsZeroPromptInjection('antigravity', { sandbox: 'off' })).toBe(true);
    // The classic structured CLIs keep their existing scratch behaviour
    // (their host-view gap predates this PR and is not widened here).
    expect(supportsZeroPromptInjection('codex', { sandbox: 'scratch' })).toBe(true);
  });
});

describe('sessionPromptInjection', () => {
  it('prefers the live session value, then init config, then default', () => {
    expect(sessionPromptInjection({ session: { promptInjection: 'none' }, initConfig: { promptInjection: 'default' } } as any)).toBe('none');
    expect(sessionPromptInjection({ session: {}, initConfig: { promptInjection: 'none' } } as any)).toBe('none');
    expect(sessionPromptInjection({ session: {}, initConfig: {} } as any)).toBe('default');
  });
});

describe('isSandboxRequested', () => {
  const prev = process.env.BOTMUX_SANDBOX;
  const reset = () => {
    if (prev === undefined) delete process.env.BOTMUX_SANDBOX;
    else process.env.BOTMUX_SANDBOX = prev;
  };
  it('covers all enablement paths (incl. tri-state scratch/oncall) and defaults to false', () => {
    delete process.env.BOTMUX_SANDBOX;
    expect(isSandboxRequested()).toBe(false);
    expect(isSandboxRequested({ sandbox: true })).toBe(true);
    expect(isSandboxRequested({ sandbox: 'oncall' })).toBe(true);
    expect(isSandboxRequested({ sandbox: 'scratch' })).toBe(true);
    expect(isSandboxRequested({ sandbox: 'off' })).toBe(false);
    expect(isSandboxRequested({ sandbox: false })).toBe(false);
    expect(isSandboxRequested({ readIsolation: true })).toBe(true);
    expect(isSandboxRequested({})).toBe(false);
    process.env.BOTMUX_SANDBOX = '1';
    expect(isSandboxRequested()).toBe(true);
    // An explicit value takes precedence over the env switch; only an
    // unspecified field falls through to it.
    expect(isSandboxRequested({ sandbox: false, readIsolation: false })).toBe(false);
    expect(isSandboxRequested({ sandbox: 'off' })).toBe(false);
    expect(isSandboxRequested({})).toBe(true);
    reset();
  });
});
