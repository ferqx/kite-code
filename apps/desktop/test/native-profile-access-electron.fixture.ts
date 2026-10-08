import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [outdir, blockedApp, root, electronExecutable, control, bunExecutable] = process.argv.slice(
  2,
) as string[];
let assertions = 0;
const servicePids: number[] = [],
  nodePids: number[] = [];
function eq(a: unknown, b: unknown) {
  assert.equal(a, b);
  assertions++;
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_profile_step_timeout')), 30000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const request = async (path: string) =>
  (await fetch(`${control}/${path}`, { signal: AbortSignal.timeout(30000) })).text();
const launch = (path = outdir!, suffix = 'normal') =>
  _electron.launch({
    executablePath: electronExecutable,
    args: [path, `--user-data-dir=${join(root!, `electron-${suffix}`)}`],
    cwd: path,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 30000,
  });
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function stopped(pid: number) {
  const deadline = Date.now() + 30000;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw Error('owned_pid_not_stopped');
    await new Promise((r) => setTimeout(r, 20));
  }
  eq(alive(pid), false);
}
let app = await launch();
async function servicePid() {
  const parent = app.process().pid!;
  nodePids.push(parent);
  const line = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .split('\n')
    .find((line) => {
      const parts = line.trim().split(/\s+/);
      return Number(parts[1]) === parent && parts.slice(2).join(' ') === bunExecutable;
    });
  const pid = Number(line?.trim().split(/\s+/)[0]);
  assert.ok(pid > 0);
  assertions++;
  servicePids.push(pid);
  return pid;
}
async function ready() {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native A', { exact: true }).waitFor();
  await openSessionTools(page);
  return page;
}
try {
  let page = await ready();
  await page
    .getByRole('textbox', { name: '当前会话私有草稿' })
    .fill('Retained UI data while Service is dead');
  await page.getByRole('button', { name: '保留草稿', exact: true }).click();
  eq(await request('maintenance'), 'owner_busy');
  const first = await servicePid();
  process.kill(first, 'SIGKILL');
  await stopped(first);
  eq(app.windows().length, 1);
  eq(await request('maintenance'), 'owner_busy');
  eq(await request('other-maintenance'), 'available');
  // Explicit fixture authorizes owned application exit after its Service is already dead.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const firstNode = app.process().pid!;
  await app.evaluate(({ app }) => app.quit());
  await bounded(app.close());
  await stopped(firstNode);
  eq(await request('maintenance'), 'available');
  app = await launch(outdir!, 'kill');
  page = await ready();
  const second = await servicePid();
  process.kill(second, 'SIGKILL');
  await stopped(second);
  eq(await request('maintenance'), 'owner_busy');
  const killedNode = app.process().pid!;
  process.kill(killedNode, 'SIGKILL');
  await stopped(killedNode);
  await bounded(app.close()).catch(() => {});
  eq(await request('maintenance'), 'available');
  await request('hold');
  app = await launch(blockedApp!, 'blocked');
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page
    .getByText(/owner_busy|restore_reconciliation_required/i)
    .first()
    .waitFor();
  eq(JSON.parse(await request('blocked-ui')).present, false);
  await bounded(app.close());
  await request('release');
  await request('journal');
  app = await launch(blockedApp!, 'journal');
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page
    .getByText(/owner_busy|restore_reconciliation_required/i)
    .first()
    .waitFor();
  eq(JSON.parse(await request('blocked-ui')).present, false);
  await bounded(app.close());
  await request('clear-journal');
  eq(await request('count'), '0');
  console.log(
    'Native Profile Access Node assertions:',
    assertions,
    JSON.stringify({ servicePids, nodePids, stopped: true, provider: 0 }),
  );
} catch (error) {
  console.error(error, 'assertions', assertions);
  console.error(
    await app
      .windows()[0]
      ?.locator('main')
      .innerText()
      .catch(() => ''),
  );
  await bounded(app.close()).catch(() => {});
  throw error;
}
