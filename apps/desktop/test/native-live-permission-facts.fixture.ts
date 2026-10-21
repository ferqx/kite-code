import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LivePermissionActor,
  LivePermissionFacts,
} from './native-live-permissions-electron.fixture';

type Execution = {
  id: string;
  session_id: string;
  run_id: string | null;
  state: string;
  dispatched: number;
  attempt: number;
  cancel_requested_at: number | null;
  child_session_id: string | null;
  dispatch_authorization_json: string | null;
};
const rootSession = 'permission-root';

function fileContent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Read actual default Tool, Job and Interaction facts; never manufacture runtime state. */
export function readLivePermissionFacts(input: {
  dbPath: string;
  workspace: string;
  mainEffectPath: string;
  childEffectPath: string;
  storeId: string;
  calls: number;
  reviews: number;
}): LivePermissionFacts {
  const db = new Database(input.dbPath, { readonly: true });
  try {
    // All SQL facts belong to one committed snapshot even while Service advances.
    return db.transaction(() => {
      const metadata = db.query('SELECT store_id FROM storage_meta WHERE singleton=1').get() as {
        store_id: string;
      } | null;
      if (metadata?.store_id !== input.storeId) throw Error('live_permissions_store_mismatch');
      const savedMode = db
        .query(
          "SELECT CAST(rowid AS TEXT) AS revision,safe_request_json FROM host_mutation WHERE origin_store_id=? AND kind='permission.mode' AND scope=? AND state='applied' ORDER BY rowid DESC LIMIT 1",
        )
        .get(input.storeId, `session:${rootSession}`) as {
        revision: string;
        safe_request_json: string;
      } | null;
      const mode: LivePermissionFacts['mode'] = savedMode
        ? { mode: JSON.parse(savedMode.safe_request_json).mode, revision: savedMode.revision }
        : { mode: 'auto', revision: '0' };
      if (!['accept_edits', 'auto', 'full'].includes(mode.mode))
        throw Error('live_permissions_mode_invalid');
      const children = db
        .query(
          "SELECT carrier.* FROM execution carrier JOIN execution source ON source.id=carrier.parent_execution_id JOIN session child ON child.id=carrier.child_session_id WHERE source.session_id=? AND source.adapter_id='task.spawn' AND child.root_id=? ORDER BY carrier.rowid",
        )
        .all(rootSession, rootSession) as Execution[];

      function actor(sessionId: string, carrier: Execution | null, role: 'main' | 'child') {
        const shells = db
          .query(
            "SELECT * FROM execution WHERE session_id=? AND kind='tool' AND adapter_id='shell.execute' ORDER BY rowid",
          )
          .all(sessionId) as Execution[];
        const shell = shells[0];
        if (!shell?.run_id) return null;
        const jobs = db
          .query(
            "SELECT * FROM execution WHERE parent_execution_id=? AND kind='job' AND adapter_id='shell.command' ORDER BY rowid",
          )
          .all(shell.id) as Execution[];
        const job = jobs[0];
        const effectPath = role === 'main' ? input.mainEffectPath : input.childEffectPath;
        const targets = db
          .query(
            "SELECT * FROM execution WHERE session_id=? AND kind='tool' AND adapter_id='files.write_path' AND json_extract(intent_json,'$.path')=? ORDER BY rowid",
          )
          .all(sessionId, effectPath) as Execution[];
        const target = targets[0];
        const cards = target
          ? (
              db
                .query(
                  "SELECT id,state,answer_json,policy_revision FROM interaction WHERE execution_id=? AND kind='approval' ORDER BY rowid",
                )
                .all(target.id) as {
                id: string;
                state: 'pending' | 'answered' | 'cancelled';
                answer_json: string | null;
                policy_revision: string;
              }[]
            ).map((card) => ({
              id: card.id,
              state: card.state,
              answer: card.answer_json === null ? null : JSON.parse(card.answer_json),
              policyRevision: card.policy_revision,
            }))
          : [];
        const authorization = target?.dispatch_authorization_json
          ? (JSON.parse(target.dispatch_authorization_json) as {
              controlReads?: { kind: string; scope: string; revision: string }[];
            })
          : null;
        const effectContent = fileContent(effectPath);
        const value: LivePermissionActor = {
          sessionId,
          runId: shell.run_id,
          carrierId: carrier?.id ?? null,
          shell: {
            id: shell.id,
            status: shell.state,
            dispatched: shell.dispatched === 1,
            cancelRequestedAt:
              shell.cancel_requested_at === null ? null : String(shell.cancel_requested_at),
            jobId: job?.id ?? null,
            jobState: job?.state ?? null,
          },
          target: target
            ? {
                id: target.id,
                status: target.state,
                dispatched: target.dispatched === 1,
                attempt: target.attempt,
                // Child intersections merge the actual dispatch read set at this level.
                controlRevisions: (authorization?.controlReads ?? [])
                  .filter(
                    (read) =>
                      read.kind === 'permission.mode' && read.scope === `session:${rootSession}`,
                  )
                  .map((read) => read.revision),
              }
            : null,
          cards,
          markerContent: fileContent(join(input.workspace, `${role}.marker`)),
          effectExists: effectContent !== null,
          effectContent,
        };
        const run = db
          .query('SELECT status,is_active FROM run WHERE id=? AND session_id=?')
          .get(shell.run_id, sessionId) as { status: string; is_active: number } | null;
        const common =
          shells.length === 1 &&
          jobs.length === 1 &&
          shell.dispatched === 1 &&
          shell.cancel_requested_at === null &&
          job?.cancel_requested_at === null &&
          !!run;
        const title = role === 'main' ? 'MAIN' : 'CHILD';
        const finishedMarker = `${title} STARTED\n${title} FINISHED\n`;
        return {
          value,
          holding:
            common &&
            ['dispatching', 'running'].includes(shell.state) &&
            job?.state === 'running' &&
            targets.length === 0 &&
            value.markerContent === `${title} STARTED\n` &&
            !value.effectExists,
          pending:
            common &&
            shell.state === 'succeeded' &&
            job?.state === 'succeeded' &&
            targets.length === 1 &&
            target?.run_id === shell.run_id &&
            target.state === 'planned' &&
            target.dispatched === 0 &&
            target.cancel_requested_at === null &&
            cards.some((card) => card.state === 'pending' && card.answer === null) &&
            value.markerContent === finishedMarker &&
            !value.effectExists,
          terminal:
            common &&
            run?.status === 'completed' &&
            run.is_active === 0 &&
            (!carrier || (carrier.state === 'succeeded' && carrier.cancel_requested_at === null)) &&
            shell.state === 'succeeded' &&
            job?.state === 'succeeded' &&
            targets.length === 1 &&
            target?.run_id === shell.run_id &&
            target.state === 'succeeded' &&
            target.dispatched === 1 &&
            target.attempt === 1 &&
            target.cancel_requested_at === null &&
            value.target?.controlRevisions.includes(mode.revision) === true &&
            cards.length > 0 &&
            cards.every((card) => card.state === 'cancelled' && card.answer === null) &&
            value.markerContent === finishedMarker &&
            value.effectContent === `${title} EFFECT\n`,
        };
      }
      const main = actor(rootSession, null, 'main');
      const childCarrier = children[0];
      const child = childCarrier?.child_session_id
        ? actor(childCarrier.child_session_id, childCarrier, 'child')
        : null;
      const answers = db
        .query("SELECT COUNT(*) AS count FROM command WHERE kind='interaction.answer'")
        .get() as { count: number };
      return {
        storeId: metadata.store_id,
        mode,
        actors: { main: main?.value ?? null, child: child?.value ?? null },
        holding: children.length === 1 && !!main?.holding && !!child?.holding,
        pending: children.length === 1 && !!main?.pending && !!child?.pending,
        terminal: children.length === 1 && !!main?.terminal && !!child?.terminal,
        calls: input.calls,
        reviews: input.reviews,
        answerPosts: answers.count,
        childCount: children.length,
      };
    })();
  } finally {
    db.close();
  }
}
