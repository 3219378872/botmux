import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { parse } from 'smol-toml';
import {
  codexStatusLineConfigText, codexConfigPathFromProcessEnvironment,
  ensureCodexStatusLineConfig, codexStatusLineSetupNotice,
} from '../src/services/codex-statusline-config.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
}));

let index = 0;
function fixture(source?: string) {
  const dir = join(process.env.SESSION_DATA_DIR!, `statusline-${index++}`);
  mkdirSync(dir, { recursive: true });
  const path = join(realpathSync(dir), 'config.toml');
  if (source !== undefined) writeFileSync(path, source, { mode: 0o600 });
  return path;
}
const items = (source: string): unknown => parse(source).tui;
afterEach(() => vi.restoreAllMocks());

describe('Codex statusline config editing', () => {
  it('adds an ID without changing existing items, comments, or unrelated settings', () => {
    const before = '# keep\nmodel = "custom"\n[tui] # layout\nstatus_line = [\n  "model-with-reasoning", # model\n  \'context-used\', # usage\n]\nstatus_line_use_colors = false\n[mcp_servers.example]\ncommand = "private-value"\n';
    const after = codexStatusLineConfigText(before);
    expect(after).toBe(before.replace('status_line = [', 'status_line = ["session-id", '));
    expect(codexStatusLineConfigText(after)).toBe(after);
  });

  it.each(['session-id', 'thread-id'])('moves existing %s first and preserves comments', (id) => {
    const before = `[tui]\nstatus_line = ["model-name", # keep model\n "${id}" # keep id\n]\n`;
    const after = codexStatusLineConfigText(before);
    expect(items(after)).toEqual({ status_line: [id, 'model-name'] });
    expect(after).toContain('# keep model');
    expect(after).toContain('# keep id');
    expect(codexStatusLineConfigText(after)).toBe(after);
  });

  it('deduplicates aliases and leaves unicode items intact', () => {
    const after = codexStatusLineConfigText('[tui]\nstatus_line = ["🧪", "thread-id", "session-id", "context-used"]');
    expect(items(after)).toEqual({ status_line: ['thread-id', '🧪', 'context-used'] });
  });

  it.each(['', '[tui]\ntheme="github"\n', '[tui]\n', '[tui]'])('preserves native defaults when status_line is absent: %s', (source) => {
    expect(items(codexStatusLineConfigText(source))).toMatchObject({
      status_line: ['session-id', 'model-with-reasoning', 'current-dir', 'thread-name'],
    });
  });

  it('accepts an explicitly empty list without introducing extra display items', () => {
    expect(items(codexStatusLineConfigText('[tui]\nstatus_line=[]'))).toEqual({ status_line: ['session-id'] });
  });

  it('supports dotted and quoted keys and bracket characters inside strings', () => {
    expect(items(codexStatusLineConfigText('tui.status_line = ["a]b"]'))).toEqual({ status_line: ['session-id', 'a]b'] });
    expect(items(codexStatusLineConfigText('["tui"]\n"status_line" = ["model-name"]'))).toEqual({ status_line: ['session-id', 'model-name'] });
  });

  it('preserves CRLF, large integers, and literal strings outside the edited setting', () => {
    const source = 'large=9223372036854775807\r\n[tui]\r\nstatus_line = ["context-used"] # keep\r\n';
    const after = codexStatusLineConfigText(source);
    expect(after).toBe(source.replace('status_line = [', 'status_line = ["session-id", '));
  });

  it('does not confuse multiline string contents or another table with the real setting', () => {
    const source = 'instructions = """\n[tui]\nstatus_line = ["model-name"]\n"""\n[other]\nstatus_line = ["model-name"]\n[tui]\nstatus_line = ["model-name"]\n';
    const after = codexStatusLineConfigText(source);
    expect(parse(after).instructions).toBe(parse(source).instructions);
    expect(parse(after).other).toEqual(parse(source).other);
    expect(items(after)).toEqual({ status_line: ['session-id', 'model-name'] });
  });

  it.each(['[tui]\nstatus_line="bad"', '[tui]\nstatus_line=[1]', '[tui]\nstatus_line=[', 'tui={status_line=["model-name"]}'])('refuses invalid or unsupported layout without overwriting it: %s', (source) => {
    const path = fixture(source);
    expect(ensureCodexStatusLineConfig(path).kind).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(source);
    expect(existsSync(`${path}.botmux-statusline.bak`)).toBe(false);
    expect(existsSync(`${path}.botmux-statusline.lock`)).toBe(false);
  });

  it('backs up the original and preserves permissions; subsequent calls do not rewrite', () => {
    const source = '[tui]\nstatus_line=["context-used"]\n';
    const path = fixture(source);
    chmodSync(path, 0o640);
    expect(ensureCodexStatusLineConfig(path)).toEqual({ kind: 'updated', configPath: path });
    expect(readFileSync(`${path}.botmux-statusline.bak`, 'utf8')).toBe(source);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    const mtime = statSync(path).mtimeMs;
    expect(ensureCodexStatusLineConfig(path)).toEqual({ kind: 'configured', configPath: path });
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  it('preserves a config symlink and edits its target', () => {
    const target = fixture('[tui]\nstatus_line=[]');
    const link = fixture();
    symlinkSync(target, link);
    expect(ensureCodexStatusLineConfig(link)).toEqual({ kind: 'updated', configPath: target });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(items(readFileSync(target, 'utf8'))).toEqual({ status_line: ['session-id'] });
  });

  it('preserves an external edit made while preparing the backup', () => {
    const path = fixture('[tui]\nstatus_line=[]');
    const edited = '# concurrent edit\n[tui]\nstatus_line=["model-name"]';
    const copy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, mode) => {
      copy(source, destination, mode);
      writeFileSync(path, edited);
    });
    expect(ensureCodexStatusLineConfig(path).kind).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });

  it('creates a private config when absent', () => {
    const path = fixture();
    expect(ensureCodexStatusLineConfig(path).kind).toBe('updated');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.botmux-statusline.bak`)).toBe(false);
  });

  it('does not steal another writer lock', () => {
    const path = fixture('[tui]\nstatus_line=[]');
    const before = readFileSync(path, 'utf8');
    writeFileSync(`${path}.botmux-statusline.lock`, 'other worker');
    expect(ensureCodexStatusLineConfig(path).kind).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readFileSync(`${path}.botmux-statusline.lock`, 'utf8')).toBe('other worker');
  });

  it('distinguishes saved, configured, and failed notices with live-terminal instructions', () => {
    for (const setup of [ensureCodexStatusLineConfig(fixture()), ensureCodexStatusLineConfig(fixture('[tui]\nstatus_line=["session-id"]')), ensureCodexStatusLineConfig(fixture('invalid'))]) {
      const notice = codexStatusLineSetupNotice(setup);
      expect(notice).toContain('/statusline');
      expect(notice).toContain('thread-id');
      expect(notice).toContain(setup.configPath);
      expect(notice).not.toContain('invalid');
    }
  });
});

describe('observed Codex process config location', () => {
  it('uses the Linux target environment rather than the daemon environment', () => {
    expect(codexConfigPathFromProcessEnvironment('HOME=/home/user\0CODEX_HOME=/work/codex custom\0', true)).toBe('/work/codex custom/config.toml');
    expect(codexConfigPathFromProcessEnvironment('HOME=/home/user\0', true)).toBe('/home/user/.codex/config.toml');
    expect(codexConfigPathFromProcessEnvironment('HOME=/home/user\0CODEX_HOME=~/custom\0', true)).toBe('/home/user/custom/config.toml');
  });

  it('extracts macOS ps environment without leaking or depending on other variables', () => {
    expect(codexConfigPathFromProcessEnvironment('codex resume thread PATH=/bin HOME=/Users/test CODEX_HOME=/Users/test/My Codex TOKEN=secret', false)).toBe('/Users/test/My Codex/config.toml');
  });

  it('does not guess when the process environment is unavailable or relative', () => {
    expect(codexConfigPathFromProcessEnvironment('HOME=/home/user\0CODEX_HOME=/a\0CODEX_HOME=/b\0', true)).toBeUndefined();
    expect(codexConfigPathFromProcessEnvironment('', true)).toBeUndefined();
    expect(codexConfigPathFromProcessEnvironment('codex', false)).toBeUndefined();
    expect(codexConfigPathFromProcessEnvironment('HOME=/home/user\0CODEX_HOME=relative\0', true)).toBeUndefined();
  });
});
