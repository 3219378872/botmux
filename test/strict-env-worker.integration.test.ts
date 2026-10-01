import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inheritBotEnv } from '../src/core/env-policy.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional native tool */ }
const cases = [{ cliId: 'codex', restore: false }, { cliId: 'claude-code', restore: false }, ...(realTmux ? [{ cliId: 'claude-code', restore: true }] : [])];
describe('strict worker IPC to real CLI child', () => {
  it.each(cases)('$cliId enforces policy and identity (unstamped tmux restore=$restore)', async ({ cliId, restore }) => {
    const dir = mkdtempSync(join(restore ? '/tmp' : tmpdir(), 'worker-env-probe-'));
    const socket = join(dir, 'socket'); let oldPid: number | undefined;
    const script = join(dir, 'fake-cli'); const report = join(dir, 'report');
    const bots = join(dir, 'bots.json');
    const source = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(cliId === 'codex' ? 'codex-cli 0.136.0' : '2.1.0 (Claude Code)')}); process.exit(); }
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
 unknownAbsent: !('UNLISTED_CLOUD_CREDENTIAL' in process.env),
 authPresent: process.env.MODEL_AUTH === 'bot-sentinel',
 proxyPresent: process.env.HTTPS_PROXY === 'proxy-sentinel',
 owner: process.env.BOTMUX_OWNER_OPEN_ID === 'ou_owner',
 daemonAbsent: !('LARK_APP_SECRET' in process.env),
 siblingAbsent: !('SIBLING_AUTH' in process.env)
}));
console.log('Ready >'); setTimeout(() => {}, 30000);
`;
    writeFileSync(script, source, { mode: 0o700 });
    writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, cliId }]));
    const env = { ...inheritBotEnv(process.env, { mode: 'strict' }), HOME: dir, SESSION_DATA_DIR: join(dir, 'data'),
      BOTS_CONFIG: bots, BOTMUX_NO_CLAIM: '1', UNLISTED_CLOUD_CREDENTIAL: 'host-sentinel', SIBLING_AUTH: 'sibling-sentinel', HTTPS_PROXY: 'proxy-sentinel' };
    if (restore) {
      const bin = join(dir, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o700 });
      env.PATH = `${bin}:${env.PATH}`;
      execFileSync(realTmux!, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'bmx-11111111', '/bin/sleep', '60'], { env, stdio: 'ignore' });
      oldPid = Number(execFileSync(realTmux!, ['-S', socket, 'display-message', '-p', '-t', 'bmx-11111111', '#{pane_pid}'], { encoding: 'utf8' }));
    }
    const worker = spawnNodeTsScript('src/worker.ts', [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = '';
    worker.stdout?.on('data', data => diagnostics += String(data));
    worker.stderr?.on('data', data => diagnostics += String(data));
    try {
      worker.send({ type: 'init', sessionId: '11111111-1111-4111-8111-111111111111', chatId: 'virtual_probe', rootMessageId: 'probe',
        workingDir: dir, cliId, cliPathOverride: script, backendType: restore ? 'tmux' : 'pty', prompt: '',
        apiOnly: true, larkAppId: 'app_probe', larkAppSecret: '', ownerOpenId: 'ou_owner',
        envPolicy: { mode: 'strict', inherit: ['HTTPS_PROXY'] }, env: { MODEL_AUTH: 'bot-sentinel' },
        loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none' });
      await vi.waitFor(() => expect(existsSync(report), diagnostics).toBe(true), { timeout: 20000 });
      for (const [key, ok] of Object.entries(JSON.parse(readFileSync(report, 'utf8')))) expect(ok, key).toBe(true);
      if (restore) {
        expect(() => process.kill(oldPid!, 0)).toThrow();
        await vi.waitFor(() => expect(existsSync(join(dir, 'data/sessions/11111111-1111-4111-8111-111111111111.env-policy'))).toBe(true));
      }
    } finally {
      if (worker.connected) worker.send({ type: 'close' });
      await new Promise(resolve => setTimeout(resolve, 300));
      worker.kill('SIGTERM');
      if (restore) { try { execFileSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
