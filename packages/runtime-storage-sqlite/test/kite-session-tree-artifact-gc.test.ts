import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { removeUnreferencedKiteSessionTreeArtifacts } from '../src/kite-session-tree-deletion';

type Candidate = {
  readonly table: 'model_artifacts' | 'plan_artifacts';
  readonly artifactId: string;
};

function database(): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE model_artifacts (artifact_id TEXT PRIMARY KEY, canonical_json TEXT)');
  db.run('CREATE TABLE plan_artifacts (artifact_id TEXT PRIMARY KEY, markdown TEXT)');
  db.run('CREATE TABLE notes (body TEXT, second_body TEXT)');
  return db;
}

function remaining(db: Database): readonly string[] {
  return ['model_artifacts', 'plan_artifacts'].flatMap((table) =>
    db
      .query<{ artifact_id: string }, []>(`SELECT artifact_id FROM ${table} ORDER BY artifact_id`)
      .all()
      .map(({ artifact_id }) => `${table}:${artifact_id}`),
  );
}

/** The previous SQL rule, kept only as a differential test oracle. */
function removeWithOriginalRule(db: Database, candidates: readonly Candidate[]): void {
  for (const { table, artifactId } of candidates) {
    let retained = false;
    for (const name of ['model_artifacts', 'plan_artifacts', 'notes']) {
      const columns = db
        .query<{ name: string; type: string }, []>(`PRAGMA table_info(${name})`)
        .all()
        .filter(({ type }) => type === 'TEXT')
        .map(({ name: column }) => column);
      const match = columns.map((column) => `instr(${column}, ?) > 0`).join(' OR ');
      const excludeSelf = name === table ? ' AND artifact_id <> ?' : '';
      const args = columns.map(() => artifactId);
      if (excludeSelf) args.push(artifactId);
      if (db.query(`SELECT 1 FROM ${name} WHERE (${match})${excludeSelf} LIMIT 1`).get(...args)) {
        retained = true;
        break;
      }
    }
    if (!retained) db.query(`DELETE FROM ${table} WHERE artifact_id=?`).run(artifactId);
  }
}

test('one-pass artifact GC matches ordered SQL scans for self, shared, substring and malformed text refs', () => {
  for (let seed = 0; seed < 24; seed++) {
    const fast = database();
    const original = database();
    try {
      const candidates: Candidate[] = [];
      for (let index = 0; index < 24; index++) {
        const table = index % 4 === 0 ? 'plan_artifacts' : 'model_artifacts';
        // Include prefix overlap and the same ID in two artifact tables.
        const artifactId = index === 20 ? 'artifact-1' : `artifact-${index}`;
        candidates.push({ table, artifactId });
      }
      let random = seed + 1;
      const next = () => {
        random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
        return random;
      };
      for (const db of [fast, original]) {
        for (const [index, candidate] of candidates.entries()) {
          const referenced = candidates[next() % candidates.length]!.artifactId;
          const raw = index % 5 === 0 ? `{malformed:${referenced}` : `prefix:${referenced}:suffix`;
          db.query(
            `INSERT INTO ${candidate.table}(artifact_id, ${candidate.table === 'model_artifacts' ? 'canonical_json' : 'markdown'}) VALUES (?, ?)`,
          ).run(candidate.artifactId, raw);
        }
        db.query('INSERT INTO notes(body, second_body) VALUES (?, ?)').run(
          `shared:${candidates[seed % candidates.length]!.artifactId}`,
          `raw\u0000${candidates[(seed + 1) % candidates.length]!.artifactId}`,
        );
        db.query('INSERT INTO notes(body, second_body) VALUES (?, ?)').run(
          Buffer.from(`blob:${candidates[(seed + 2) % candidates.length]!.artifactId}`),
          null,
        );
        // Recreate the same deterministic graph for the second database.
        random = seed + 1;
      }
      removeUnreferencedKiteSessionTreeArtifacts(fast, candidates);
      removeWithOriginalRule(original, candidates);
      expect(remaining(fast)).toEqual(remaining(original));
    } finally {
      fast.close();
      original.close();
    }
  }
});

test('artifact GC preserves SQLite instr semantics for empty identifiers and BLOBs', () => {
  const fast = database();
  const original = database();
  try {
    const candidates: Candidate[] = [
      { table: 'model_artifacts', artifactId: '' },
      { table: 'plan_artifacts', artifactId: 'blob-only' },
    ];
    for (const db of [fast, original]) {
      db.query('INSERT INTO model_artifacts(artifact_id, canonical_json) VALUES (?, ?)').run(
        '',
        '',
      );
      db.query('INSERT INTO plan_artifacts(artifact_id, markdown) VALUES (?, ?)').run(
        'blob-only',
        null,
      );
      db.query('INSERT INTO notes(body, second_body) VALUES (?, ?)').run(
        Buffer.from('blob-only'),
        null,
      );
    }
    removeUnreferencedKiteSessionTreeArtifacts(fast, candidates);
    removeWithOriginalRule(original, candidates);
    expect(remaining(fast)).toEqual(remaining(original));
  } finally {
    fast.close();
    original.close();
  }
});

test('artifact GC scans a multi-megabyte Store once for many candidates', () => {
  const db = database();
  try {
    const candidates: Candidate[] = [];
    const insert = db.query(
      'INSERT INTO model_artifacts(artifact_id, canonical_json) VALUES (?, ?)',
    );
    for (let index = 0; index < 2_000; index++) {
      const artifactId = `pa_${index.toString(16).padStart(64, '0')}`;
      candidates.push({ table: 'model_artifacts', artifactId });
      insert.run(artifactId, artifactId);
    }
    const filler = 'no artifact references here. '.repeat(9_000);
    const insertNote = db.query('INSERT INTO notes(body, second_body) VALUES (?, ?)');
    for (let index = 0; index < 16; index++) insertNote.run(filler, filler);
    insertNote.run(`retained:${candidates[7]!.artifactId}`, null);
    const started = performance.now();
    removeUnreferencedKiteSessionTreeArtifacts(db, candidates);
    const elapsedMs = performance.now() - started;
    expect(remaining(db)).toEqual([`model_artifacts:${candidates[7]!.artifactId}`]);
    expect(elapsedMs).toBeLessThan(8_000);
  } finally {
    db.close();
  }
}, 15_000);

test.skipIf(process.env.KITE_ARTIFACT_GC_LARGE_BENCHMARK !== '1')(
  'artifact GC scans 100 MB of unrelated text with 2,000 candidates',
  () => {
    const db = database();
    try {
      const candidates: Candidate[] = [];
      const insert = db.query(
        'INSERT INTO model_artifacts(artifact_id, canonical_json) VALUES (?, ?)',
      );
      for (let index = 0; index < 2_000; index++) {
        const artifactId = `pa_${index.toString(16).padStart(64, '0')}`;
        candidates.push({ table: 'model_artifacts', artifactId });
        insert.run(artifactId, artifactId);
      }
      const filler = 'x'.repeat(1_000_000);
      const insertNote = db.query('INSERT INTO notes(body, second_body) VALUES (?, ?)');
      for (let index = 0; index < 100; index++) insertNote.run(filler, null);
      const started = performance.now();
      removeUnreferencedKiteSessionTreeArtifacts(db, candidates);
      const elapsedMs = performance.now() - started;
      console.info(`artifact GC 100 MB / 2,000 candidates: ${elapsedMs.toFixed(0)} ms`);
      expect(remaining(db)).toEqual([]);

      const fastSmall = database();
      const originalSmall = database();
      try {
        const smallCandidates: Candidate[] = [];
        const smallFiller = 'x'.repeat(500_000);
        for (let index = 0; index < 100; index++) {
          smallCandidates.push({
            table: 'model_artifacts',
            artifactId: `pa_${index.toString(16).padStart(64, '0')}`,
          });
        }
        for (const fixture of [fastSmall, originalSmall]) {
          const insertArtifact = fixture.query(
            'INSERT INTO model_artifacts(artifact_id, canonical_json) VALUES (?, ?)',
          );
          for (const candidate of smallCandidates)
            insertArtifact.run(candidate.artifactId, candidate.artifactId);
          const insertBody = fixture.query('INSERT INTO notes(body, second_body) VALUES (?, ?)');
          for (let index = 0; index < 16; index++) insertBody.run(smallFiller, null);
        }
        const fastStarted = performance.now();
        removeUnreferencedKiteSessionTreeArtifacts(fastSmall, smallCandidates);
        const fastMs = performance.now() - fastStarted;
        const oldStarted = performance.now();
        removeWithOriginalRule(originalSmall, smallCandidates);
        const oldMs = performance.now() - oldStarted;
        console.info(
          `artifact GC 8 MB / 100 candidates: new ${fastMs.toFixed(0)} ms, old ${oldMs.toFixed(0)} ms`,
        );
        expect(remaining(fastSmall)).toEqual(remaining(originalSmall));
      } finally {
        fastSmall.close();
        originalSmall.close();
      }
    } finally {
      db.close();
    }
  },
  120_000,
);
