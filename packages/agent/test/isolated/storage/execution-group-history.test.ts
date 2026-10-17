import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readExecutionGroupSafetySnapshot } from '../../../src/storage/sqlite/execution-group-safety';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

function fixture() {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(
      new URL('../../../src/storage/migrations/0001-baseline.sql', import.meta.url),
      'utf8',
    ),
  );
  db.run("INSERT INTO storage_meta(singleton,store_id,format_major) VALUES(1,'store',1)");
  db.run("INSERT INTO workspace(id,root_uri,name) VALUES('w','file:///owned','owned')");
  db.run(
    "INSERT INTO session(id,workspace_id,root_id,title,context_selection_id) VALUES('s','w','s','history','context')",
  );
  db.run(
    "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq) VALUES('create','s',1,'session.create','owner','digest','{}','applied','store','create',1)",
  );
  db.run(
    "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq) VALUES('work','s',2,'run.start','owner','digest','{}','applied','store','work',2)",
  );
  db.run(
    "INSERT INTO run(id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,status,is_active,config_json,started_at,finished_at,context_selection_id) VALUES('run','s','work','store','work',2,'completed',0,'{}','0','1','context')",
  );
  db.run(
    "INSERT INTO context_snapshot(id,session_id,selection_id,sources_json,request_json,kind) VALUES('context','s','context','[]','{}','selection')",
  );
  const operations = new SqliteOperations(db, true);
  const safety = () => {
    try {
      return readExecutionGroupSafetySnapshot(operations, {
        expectedStoreId: 'store',
        sessionId: 's',
        subjectId: 'owner',
      });
    } finally {
      operations.releaseStatements();
    }
  };
  const messages = (count: number, parts = 0) =>
    db.transaction(() => {
      const message = db.prepare(
        "INSERT INTO message(id,session_id,run_id,seq,role,status,source_json) VALUES(?,'s','run',?,'assistant','complete','{}')",
      );
      const part = db.prepare(
        "INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) VALUES(?,?,'text',1,1,'{}')",
      );
      try {
        for (let index = 0; index < count; index++) {
          const id = `message-${String(index).padStart(5, '0')}`;
          message.run(id, index + 3);
          for (let ordinal = 0; ordinal < parts; ordinal++) part.run(id, ordinal);
        }
      } finally {
        message.finalize();
        part.finalize();
      }
      db.run("UPDATE session SET next_seq=? WHERE id='s'", [count + 3]);
    })();
  return {
    db,
    operations,
    safety,
    messages,
    close() {
      operations.releaseStatements();
      db.close();
    },
  };
}

test('completed root message history past 8192 remains quiescent and its last message remains a context dependency', () => {
  const f = fixture();
  try {
    f.messages(8192);
    const prior = f.safety();
    expect(prior.quiescent).toBe(true);
    f.db.run(
      "INSERT INTO message(id,session_id,run_id,seq,role,status,source_json) VALUES('z-last','s','run',9000,'assistant','complete','{}')",
    );
    const complete = f.safety();
    expect(complete.quiescent).toBe(true);
    expect(complete.contextRevision).not.toBe(prior.contextRevision);
    expect(complete.revision).not.toBe(prior.revision);
    f.db.run("UPDATE message SET seq=9001 WHERE id='z-last'");
    expect(f.safety().contextRevision).not.toBe(complete.contextRevision);
  } finally {
    f.close();
  }
});

test('complete message parts past 8192 are all hashed without a historical count ceiling', () => {
  const f = fixture();
  try {
    f.messages(4097, 2);
    const prior = f.safety();
    expect(prior.quiescent).toBe(true);
    f.db.run("UPDATE message_part SET revision=2 WHERE message_id='message-04096' AND ordinal=1");
    expect(f.safety().contextRevision).not.toBe(prior.contextRevision);
  } finally {
    f.close();
  }
});

test('historical child Sessions past 8192 retain complete lineage, scope checks and cycle rejection', () => {
  const f = fixture();
  try {
    f.db.transaction(() => {
      const insert = f.db.prepare(
        "INSERT INTO session(id,workspace_id,parent_id,root_id,title,context_selection_id) VALUES(?,'w','s','s','completed child','child-context')",
      );
      try {
        for (let index = 0; index < 8192; index++)
          insert.run(`child-${String(index).padStart(5, '0')}`);
      } finally {
        insert.finalize();
      }
    })();
    const prior = f.safety();
    expect(prior.quiescent).toBe(true);
    f.db.run("UPDATE session SET context_selection_id='changed' WHERE id='child-08191'");
    expect(f.safety().contextRevision).not.toBe(prior.contextRevision);
    f.db.run("UPDATE session SET root_id='foreign' WHERE id='child-08191'");
    expect(f.safety).toThrow('execution_group_scope_denied');
    f.db.run("UPDATE session SET root_id='s',parent_id='child-08191' WHERE id='child-08191'");
    expect(f.safety).toThrow('execution_group_scope_denied');
  } finally {
    f.close();
  }
});

test('the existing bound applies to actual outstanding Commands and never returns partial quiescence', () => {
  const f = fixture();
  try {
    f.db.transaction(() => {
      const insert = f.db.prepare(
        "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq) VALUES(?,'s',?,'run.start','owner','digest','{}','accepted','store','work',2)",
      );
      try {
        for (let index = 0; index < 8193; index++) insert.run(`pending-${index}`, index + 3);
      } finally {
        insert.finalize();
      }
    })();
    expect(f.safety).toThrow('execution_group_safety_unavailable');
    f.db.run("UPDATE command SET status='applied' WHERE id LIKE 'pending-%'");
    expect(f.safety().quiescent).toBe(true);
  } finally {
    f.close();
  }
});
