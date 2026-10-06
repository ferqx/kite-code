import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireProfileAccess,
  acquireProfileDataLock,
  selectProfile,
} from '../../../src/platform/profile';

const repository = new URL('../../../../../', import.meta.url).pathname;
export const configBytes = Buffer.from(
  '// exact config with comments\n{"future":{"unchanged":true},"credentialRef":"credential:01234567-1234-1234-1234-012345678901"}\n',
);
/** Historical fixtures only downgrade after all owners close and additions are proven empty. */
function retainLegacyDatabaseFixture(
  profile: { dataRoot: string; profile: string },
  target: 5 | 6,
) {
  const access = acquireProfileAccess(profile, 'exclusive');
  try {
    const db = new Database(
      join(selectProfile(profile).profilePath, 'desktop-private/data.sqlite'),
    );
    try {
      const version = db
        .query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version;
      if (
        (version !== 6 && version !== 7) ||
        (version === 7 &&
          db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM mcp_intents').get()
            ?.count !== 0)
      )
        throw Error('legacy_fixture_requires_empty_db7_additions');
      if (
        target === 5 &&
        (db
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM configuration_intents')
          .get()?.count !== 0 ||
          db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM model_routes').get()
            ?.count !== 0)
      )
        throw Error('legacy_fixture_requires_empty_db6_additions');
      if (version === target) return;
      db.run('BEGIN IMMEDIATE');
      if (version === 7) db.run('DROP TABLE mcp_intents');
      if (target === 5) {
        db.run('DROP TABLE configuration_intents');
        db.run('DROP TABLE model_routes');
      }
      db.run(`PRAGMA user_version=${target}`);
      db.run('COMMIT');
    } finally {
      db.close(true);
    }
  } finally {
    access.lock.release();
  }
}
export function retainLegacyDb6Fixture(profile: { dataRoot: string; profile: string }) {
  retainLegacyDatabaseFixture(profile, 6);
}
export function retainLegacyDb5Fixture(profile: { dataRoot: string; profile: string }) {
  retainLegacyDatabaseFixture(profile, 5);
}
export async function nodeAssets(
  root: string,
  profile: { dataRoot: string; profile: string },
  storeId: string,
  action: 'seed' | 'read' | 'add' = 'seed',
) {
  const directory = join(root, 'node-ui-fixture');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const helper = join(directory, 'profile-access-helper.js'),
    driver = join(directory, 'driver.js');
  if (action === 'seed') {
    const build = await Bun.build({
      entrypoints: [join(repository, 'apps/desktop/electron/profile-access-helper.ts')],
      target: 'bun',
      packages: 'bundle',
      outdir: directory,
      naming: 'profile-access-helper.js',
    });
    if (!build.success) throw new AggregateError(build.logs, 'owned UI helper build');
    const source = join(directory, 'driver.ts');
    writeFileSync(
      source,
      `
import {acquireDesktopProfileAccess} from ${JSON.stringify(join(repository, 'apps/desktop/electron/profile-access.ts'))};
import {openPrivateData} from ${JSON.stringify(join(repository, 'apps/desktop/electron/private-data.ts'))};
const input=JSON.parse(process.argv[2]);
const lease=await acquireDesktopProfileAccess(input.access);
let data;
try {
 data=openPrivateData(input.profilePath,lease);
 if(input.action==='seed'){
  for(let i=0;i<133;i++)data.save({storeId:input.storeId,workspaceId:'w',rootSessionId:'root-'+i},0,'original draft '+i+' tail 🙂');
  data.begin({commandId:'unknown-create',expectedStoreId:input.storeId,workspaceId:'w',sessionId:'creation-original',title:'original intent'});
  data.finish('unknown-create','unknown');
  data.beginRecovery({observationId:1,storeId:input.storeId,sessionId:'s',kind:'run',targetId:'original-run',originalCommandId:'original-work',commandId:'original-recovery',phase:'submitting'});
  data.finishRecovery('original-recovery','outcome_unknown');
 }
 if(input.action==='add'){
  data.save({storeId:input.storeId,workspaceId:'w',rootSessionId:'root-later'},0,'later draft');
  data.beginRecovery({observationId:2,storeId:input.storeId,sessionId:'other',kind:'interrupt',commandId:'zz-later-recovery',phase:'submitting'});
  data.finishRecovery('zz-later-recovery','outcome_unknown');
 }
 const first=data.list(),second=data.list(first.nextId);
 console.log(JSON.stringify({count:first.drafts.length+second.drafts.length,original:data.read({storeId:input.storeId,workspaceId:'w',rootSessionId:'root-132'}),creations:data.creations(),recoveries:data.recoveries()}));
} finally {if(data)data.close();else lease.close();}
`,
      { mode: 0o600 },
    );
    const consumer = await Bun.build({
      entrypoints: [source],
      target: 'node',
      packages: 'bundle',
      outdir: directory,
      naming: 'driver.js',
    });
    if (!consumer.success) throw new AggregateError(consumer.logs, 'owned Node UI driver build');
    writeFileSync(join(directory, 'package.json'), ' {"type":"module"}', { mode: 0o600 });
  }
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const selected = selectProfile(profile),
    node = Bun.which('node');
  if (!node) throw Error('owned_node_unavailable');
  const child = Bun.spawn(
    [
      node,
      driver,
      JSON.stringify({
        action,
        storeId,
        profilePath: selected.profilePath,
        access: {
          profile,
          bunExecutable: process.execPath,
          bunSha256: digest(process.execPath),
          helperPath: helper,
          helperSha256: digest(helper),
        },
      }),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw Error(`owned_node_ui_failed: ${stderr}`);
  retainLegacyDb5Fixture(profile);
  return JSON.parse(stdout) as {
    count: number;
    original: { storeId: string; content: string };
    recoveries: {
      observationId: number;
      kind: string;
      storeId: string;
      sessionId: string;
      targetId: string;
      originalCommandId: string;
      commandId: string;
      phase: string;
    }[];
    creations: { input: { expectedStoreId: string; commandId: string }; phase: string }[];
  };
}
export async function seedAssets(
  root: string,
  profile: { dataRoot: string; profile: string },
  storeId: string,
) {
  writeFileSync(join(selectProfile(profile).profilePath, 'config.jsonc'), configBytes, {
    mode: 0o600,
  });
  writeFileSync(join(selectProfile(profile).profilePath, 'skill-workflow.jsonc'), workflowBytes, {
    mode: 0o600,
  });
  seedTuiAsset(profile, storeId);
  await seedRecoveryAsset(profile, storeId);
  writeFileSync(join(selectProfile(profile).profilePath, 'ui/preferences.jsonc'), preferenceBytes, {
    mode: 0o600,
  });
  return nodeAssets(root, profile, storeId);
}

export const tuiText = 'original unsent '.repeat(6000) + 'TUI_FULL_ORIGINAL_TAIL_🙂';
export function seedTuiAsset(
  profile: { dataRoot: string; profile: string },
  storeId: string,
  text = tuiText,
) {
  const parent = join(selectProfile(profile).profilePath, 'ui');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scope = [storeId, 'w', 's'];
  const id = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  writeFileSync(
    join(parent, 'tui.json'),
    JSON.stringify({
      version: 1,
      revision: '1',
      drafts: [{ id, storeId, workspaceId: 'w', sessionId: 's', revision: '1', text }],
    }) + '\n',
    { mode: 0o600 },
  );
}

export const preferenceBytes = Buffer.from(
  '// original TUI preferences\n{"language":"system","colorPreset":"purple","future":true}\n',
);

export const workflowBytes = Buffer.from(
  '// original Workflow flags; exact bytes\n{"skillActivation":true,"skillWorkflow":true,"verification":false,"unknown":{"keep":1}}\n',
);

export async function seedRecoveryAsset(
  profile: { dataRoot: string; profile: string },
  storeId: string,
  later = false,
) {
  const { openRecoveryJournal } = await import(
    join(repository, 'apps/cli/host/recovery-journal.ts')
  );
  const access = acquireProfileAccess(profile);
  const journal = openRecoveryJournal({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  try {
    for (const intent of [
      {
        kind: 'run',
        sessionId: 's',
        request: {
          kind: 'run.resume',
          expectedStoreId: storeId,
          commandId: 'tui-original-run',
          runId: 'original-run',
        },
      },
      {
        kind: 'report',
        sessionId: 's',
        reportCommandId: 'original-report',
        request: { expectedStoreId: storeId, commandId: 'tui-original-report' },
      },
      {
        kind: 'interrupt',
        sessionId: 's',
        request: {
          kind: 'session.recover',
          expectedStoreId: storeId,
          commandId: 'tui-original-interrupt',
          decision: 'interrupt',
        },
      },
    ]) {
      journal.prepare(intent);
      journal.record(intent, 'outcome_unknown');
    }
    if (later) {
      const intent = {
        kind: 'interrupt',
        sessionId: 'other',
        request: {
          kind: 'session.recover',
          expectedStoreId: storeId,
          commandId: 'tui-later-recovery',
          decision: 'interrupt',
        },
      };
      journal.prepare(intent);
      journal.record(intent, 'outcome_unknown');
    }
  } finally {
    journal.close();
    access.lock.release();
  }
}
