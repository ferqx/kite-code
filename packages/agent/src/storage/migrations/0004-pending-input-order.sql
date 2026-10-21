ALTER TABLE command ADD COLUMN pending_order INTEGER;
CREATE INDEX command_pending_order ON command(session_id,status,pending_order,seq);
CREATE TABLE pending_input_queue_revision (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0)
);
CREATE TRIGGER pending_input_queue_insert AFTER INSERT ON command
WHEN NEW.kind IN ('input.steer','input.follow_up','result.include') AND NEW.status='accepted' AND NEW.cancelled=0 AND COALESCE(json_extract(NEW.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')
BEGIN
  INSERT INTO pending_input_queue_revision VALUES(NEW.session_id,1)
  ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER pending_input_queue_update AFTER UPDATE OF status,cancelled,receipt_json,pending_order ON command
WHEN ((OLD.kind IN ('input.steer','input.follow_up','result.include') AND OLD.status='accepted' AND OLD.cancelled=0 AND COALESCE(json_extract(OLD.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')) != (NEW.kind IN ('input.steer','input.follow_up','result.include') AND NEW.status='accepted' AND NEW.cancelled=0 AND COALESCE(json_extract(NEW.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')))
  OR ((NEW.kind IN ('input.steer','input.follow_up','result.include') AND NEW.status='accepted' AND NEW.cancelled=0 AND COALESCE(json_extract(NEW.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')) AND NEW.pending_order IS NOT OLD.pending_order)
BEGIN
  INSERT INTO pending_input_queue_revision VALUES(NEW.session_id,1)
  ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER pending_input_queue_delete AFTER DELETE ON command
WHEN EXISTS(SELECT 1 FROM session WHERE id=OLD.session_id) AND OLD.kind IN ('input.steer','input.follow_up','result.include') AND OLD.status='accepted' AND OLD.cancelled=0 AND COALESCE(json_extract(OLD.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')
BEGIN
  INSERT INTO pending_input_queue_revision VALUES(OLD.session_id,1)
  ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
END;
