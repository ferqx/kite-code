import type { SqliteOperations } from './operations';

/** Called inside the transaction that appends the original persisted user Message. */
export function applyFirstUserSessionTitle(
  db: SqliteOperations,
  sessionId: string,
  messageId: string,
): void {
  const first = db.row(
    "SELECT m.id,p.json FROM message m JOIN message_part p ON p.message_id=m.id AND p.ordinal=0 WHERE m.session_id=? AND m.role='user' ORDER BY m.seq LIMIT 1",
    sessionId,
  );
  if (!first || first.id !== messageId) return;
  const body: unknown = JSON.parse(String(first.json));
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const content = (body as { content?: unknown }).content;
  if (typeof content !== 'string') return;
  const title = content.slice(0, 120);
  if (!title.length) return;
  // Empty title is an explicit unnamed-session marker. The original control
  // revision fences a management rename, including one accepted before Run start.
  const updated = db.row(
    "UPDATE session SET title=?,control_revision=control_revision+1 WHERE id=? AND title='' AND control_revision=0 AND delete_requested=0 RETURNING control_revision",
    title,
    sessionId,
  );
  if (updated)
    db.event(sessionId, sessionId, 'session.renamed', {
      controlRevision: String(updated.control_revision),
    });
}
