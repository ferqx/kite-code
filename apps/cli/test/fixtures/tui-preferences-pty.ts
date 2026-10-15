import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { spawnTuiPTY, terminateTuiTree } from './tui-pty';

type Settings = {
  root: string;
  dataRoot: string;
  workspace: string;
  artifact?: unknown;
  server?: string;
  runner: string;
  preferencePath: string;
  databasePath: string;
  transcript: string;
  mode: 'paired' | 'shared';
};

async function main(settings: Settings) {
  const transcript: Uint8Array[] = [];
  const hosts: ReturnType<typeof spawnTuiPTY>[] = [];
  let active: ReturnType<typeof spawnTuiPTY>;
  const launch = () => {
    active = spawnTuiPTY({
      cmd: [process.execPath, '--no-install', settings.runner],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TUI_PREFERENCES_SETTINGS: JSON.stringify(settings),
        TERM: 'xterm-256color',
        FORCE_COLOR: '3',
      },
      onData: (bytes) => transcript.push(bytes.slice()),
    });
    hosts.push(active);
  };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Preserve actual PTY ANSI CSI assertions.
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
  const wait = async (text: string, material = false) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const frame = await active.projection();
      const candidate = material ? active.text().replace(ansi, '') : frame.text;
      if ((material || frame.fresh) && candidate.replace(/\s+/g, ' ').includes(text)) return;
      if (active.ended) throw Error(`host ended before ${text}`);
      await Bun.sleep(50);
    }
    throw Error(`expected ${text} tail=${active.text().slice(-7000)}`);
  };
  const choice = async (
    label: string,
    options: { selected?: boolean; current?: 'Current' | '当前' } = {},
  ) => {
    const end = Date.now() + 10000;
    for (;;) {
      const frame = await active.projection();
      if (
        frame.fresh &&
        frame.text.split('\n').some((line) => {
          const normalized = line.trim().replace(/\s+/g, ' ');
          const selected = normalized.startsWith('❯ ');
          if (options.selected !== undefined && selected !== options.selected) return false;
          const body = selected ? normalized.slice(2) : normalized;
          return body === `${label}${options.current ? ` ${options.current}` : ''}`;
        })
      )
        return;
      if (active.ended || Date.now() > end)
        throw Error(
          `expected preference row ${label} ${JSON.stringify(options)} tail=${active.text().slice(-7000)}`,
        );
      await Bun.sleep(50);
    }
  };
  const key = (value: string) => active.key(value);
  const counts = () => {
    const db = new Database(settings.databasePath, { readonly: true });
    try {
      return Object.fromEntries(
        ['session', 'run', 'execution', 'command', 'host_mutation'].map((table) => [
          table,
          (db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
        ]),
      );
    } finally {
      db.close();
    }
  };
  const preference = () => JSON.parse(readFileSync(settings.preferencePath, 'utf8'));
  const color = (value: 'teal' | 'blue') => {
    assert.match(
      active.sinceAction(),
      value === 'teal' ? /38;(?:2;78;201;176|5;115)m/ : /38;(?:2;86;156;214|5;110)m/,
    );
  };
  const close = async () => {
    await key('\x11');
    const end = Date.now() + 6000;
    while (!active.ended && Date.now() < end) await Bun.sleep(50);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [exit] = await Promise.race([
        Promise.all([active.host.exited, active.eof]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('preferences host exit timeout')), 3000);
        }),
      ]);
      assert.equal(exit, 0);
      await active.drain();
      active.close();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    launch();
    await wait('ORIGINAL English model body stays exact.', true);
    const baseline = counts();
    await key('/theme');
    await wait('/theme');
    await key('\r');
    await choice('Teal', { selected: true, current: 'Current' });
    await wait('Confirmed preferences');
    color('teal');
    await key('\x1b[B');
    await choice('Blue', { selected: true });
    await key('\r');
    await choice('Blue', { selected: true, current: 'Current' });
    await wait('Preference saved');
    color('blue');
    assert.equal(preference().colorPreset, 'blue');
    await key('\x1b');
    await wait('Session a');
    await wait('ORIGINAL English model body stays exact.', true);
    await key('/language');
    await wait('/language');
    await key('\r');
    await wait('Language');
    await key('\x1b[A');
    await choice('简体中文', { selected: true });
    await key('\r');
    await wait('偏好已保存');
    await choice('简体中文', { selected: true, current: '当前' });
    assert.equal(preference().language, 'zh-CN');
    await key('\x1b');
    await wait('会话 a');
    await wait('新 Run >');
    await wait('ORIGINAL English model body stays exact.', true);
    assert.deepEqual(counts(), baseline);
    await wait('终端界面 · Ctrl+N 新工作区会话 · Ctrl+Q');
    await wait(settings.mode === 'paired' ? '退出当前宿主' : '断开共享服务');
    await key('/background');
    await wait('/background');
    await key('\r');
    await wait('原后台任务 · 会话 a');
    await wait('当前快照中没有已核验的执行');
    await key('\x1b');
    await wait('会话 a');
    await wait('新 Run >');
    await key('/recovery');
    await wait('/recovery');
    await key('\r');
    await wait('显式恢复 · a');
    await wait('Ctrl+L 查询原申请');
    await key('\x1b');
    await wait('会话 a');
    await wait('新 Run >');
    await key('/rewind');
    await wait('/rewind');
    await key('\r');
    await wait('文件恢复');
    await wait('没有恢复点');
    await wait('读取状态： ready');
    await wait('Enter 继续');
    await key('\x1b');
    await wait('会话 a');
    await wait('新 Run >');
    const paste = 'Theme Language /Original/path\n中文🙂e\u0301'.repeat(4);
    await key(`\x1b[200~${paste}\x1b[201~`);
    await wait(`[已粘贴 ${Array.from(paste).length} 个字符]`);
    await key('\x7f');
    await wait('新 Run >');
    assert.deepEqual(counts(), baseline);
    console.log('CHINESE_OWNED_PANELS_AND_PASTE');
    await key('/theme');
    await wait('/theme');
    await key('\r');
    await wait('主题');
    await choice('蓝', { current: '当前' });
    renameSync(settings.preferencePath, `${settings.preferencePath}.saved`);
    mkdirSync(settings.preferencePath, { mode: 0o700 });
    await key('\x1b[B');
    await choice('紫', { selected: true });
    await key('\r');
    await wait('tui_preferences_unavailable');
    await wait('保留原值');
    await choice('蓝', { current: '当前' });
    color('blue');
    assert.deepEqual(counts(), baseline);
    rmdirSync(settings.preferencePath);
    renameSync(`${settings.preferencePath}.saved`, settings.preferencePath);
    await key('r');
    await choice('蓝', { current: '当前' });
    await key('\x1b');
    await wait('会话 a');
    await wait('新 Run >');
    await close();
    assert.deepEqual(counts(), baseline);
    launch();
    await wait('会话 a');
    await wait('ORIGINAL English model body stays exact.', true);
    await key('/theme');
    await wait('/theme');
    await key('\r');
    await wait('主题');
    await choice('蓝', { current: '当前' });
    color('blue');
    await key('\x1b');
    await wait('会话 a');
    await wait('新 Run >');
    await key('/language');
    await wait('/language');
    await key('\r');
    await wait('语言');
    await choice('简体中文', { selected: true, current: '当前' });
    await key('\x1b');
    await wait('会话 a');
    await wait('新 Run >');
    await wait('ORIGINAL English model body stays exact.', true);
    await close();
    assert.deepEqual(counts(), baseline);
    assert.deepEqual(preference(), { colorPreset: 'blue', language: 'zh-CN' });
    console.log('PREFERENCES_ORIGINAL_COMPLETE');
  } finally {
    writeFileSync(settings.transcript, Buffer.concat(transcript));
    for (const host of hosts) {
      if (!host.ended) await terminateTuiTree(host, { exitTimeoutMs: 3000 });
      host.close();
    }
  }
}

if (import.meta.main) {
  try {
    await main(JSON.parse(process.argv[2]!));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
