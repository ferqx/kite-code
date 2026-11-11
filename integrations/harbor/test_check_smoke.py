"""Synthetic checker tests following persisted schemas; not execution evidence."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from check_smoke import InvalidResult, check, check_kite

SHA = "a83387c6b1623f5b46264b21bf080b91d4ed349e"


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.job = self.root / "job"
        self.trial = self.job / "real-cli-file-smoke__abc123"
        self.task = self.root / "task"
        self.events = self.root / "docker-events.jsonl"
        self.logs = self.trial / "agent/kite"
        for path in (self.logs, self.trial / "verifier", self.trial / "artifacts/app", self.task / "tests"):
            path.mkdir(parents=True)
        (self.task / "task.toml").write_text('''artifacts = ["/app/answer.txt"]
[task]
name = "kite/real-cli-file-smoke"
[environment]
network_mode = "no-network"
[verifier]
environment_mode = "separate"
[verifier.environment]
network_mode = "no-network"
''')
        (self.task / "tests/Dockerfile").write_text("FROM ubuntu:24.04\nCOPY test.sh /tests/test.sh\n")
        timing = {"started_at": "2026-11-11T08:00:00Z", "finished_at": "2026-11-11T08:01:00Z"}
        self.aggregate = {"n_trials": 1, "n_errors": 0, "exception_stats": {}, "reward_stats": {"reward": {"1.0": [self.trial.name]}}}
        self.job_data = {"n_total_trials": 1, "finished_at": timing["finished_at"], "stats": {
            "n_completed_trials": 1, "n_errored_trials": 0, "n_running_trials": 0,
            "n_pending_trials": 0, "n_cancelled_trials": 0, "n_retries": 0,
            "evals": {"kite_agent:KiteAgent__adhoc": self.aggregate}}}
        self.trial_data = {
            "id": "synthetic-trial", "task_name": "kite/real-cli-file-smoke", "trial_name": self.trial.name,
            "task_checksum": "synthetic-checksum", "exception_info": None, **timing,
            **{phase: dict(timing) for phase in ("environment_setup", "agent_setup", "agent_execution", "verifier")},
            "agent_info": {"name": "kite", "model_info": None},
            "config": {"install_only": False,
                "agent": {"name": "kite_agent:KiteAgent", "import_path": None, "model_name": None},
                "environment": {"type": "docker", "import_path": None}, "verifier": {"disable": False}},
            "verifier_environment_mode": "separate", "verifier_result": {"rewards": {"reward": 1}},
        }
        self.docker = []
        for action, id_, suffix, timestamp in (("start", "agent", "__env", 100),
                ("destroy", "agent", "__env", 200), ("start", "verifier", "__verifier__trial", 300)):
            self.docker.append({"Type": "container", "Action": action, "timeNano": timestamp,
                "Actor": {"ID": id_, "Attributes": {"com.docker.compose.project": self.trial.name + suffix, "com.docker.compose.service": "main"}}})
        self.ids = {key: "original-" + key for key in ("storeId", "sessionId", "commandId", "runId", "executionId")}
        self.report = {"schema": "kite-harbor-run-1", "status": "succeeded", "cliExitCode": 0,
            "sourceCommit": SHA, "sourceDirty": False, "classification": "deterministic-mock-plumbing-only",
            "realModelEvaluation": False, "originalIds": self.ids,
            "trajectory": {"exported": True, "eventCount": 1, "evidenceCount": 1, "evidenceIssueCount": 0},
            "startedAt": timing["started_at"], "finishedAt": timing["finished_at"]}
        origin = {"originStoreId": self.ids["storeId"], "sessionId": self.ids["sessionId"]}
        self.command = {**origin, "id": self.ids["commandId"], "kind": "run.start", "status": "applied", "receipt": {"runId": self.ids["runId"]}}
        self.run = {**origin, "id": self.ids["runId"], "originCommandId": self.ids["commandId"], "status": "completed", "isActive": False,
            "configuration": {"snapshot": {"configuration": {"modelId": "harbor-local-fixture", "models": [{"id": "harbor-local-fixture", "provider": "compatible", "model": "deterministic-tool-fixture", "baseURL": "http://127.0.0.1:12345/v1", "modelCapabilities": {"contextWindowTokens": 32768}}]}}}}
        self.execution = {**origin, "id": self.ids["executionId"], "runId": self.ids["runId"], "kind": "model", "status": "succeeded", "definitionId": "harbor-local-fixture"}
        self.fixture = {"classification": "deterministic-mock-plumbing-only", "businessRequests": 2, "titleRequests": 1, "writeCalls": 1, "outputProducedByRealKiteTool": True}
        self.native_event = {"schema": "kite.trajectory", "eventId": "event1", "origin": {"storeId": self.ids["storeId"]}, "evidenceRefs": [{"evidenceId": "ev1", "contentVersion": "content-version"}], "runId": self.ids["runId"], "sessionId": self.ids["sessionId"], "kind": "tool", "recordedStatus": "succeeded", "attributes": {"definitionId": "files.write"}}
        self.make_bundle()
        self.write_json(self.trial / "artifacts/manifest.json", [{"source": "/app/answer.txt", "status": "ok"}])
        (self.trial / "artifacts/app/answer.txt").write_bytes(b"Kite Harbor adapter smoke passed\n")
        (self.trial / "verifier/reward.txt").write_text("1\n")
        (self.trial / "verifier/test-stdout.txt").write_text("")

    def write_json(self, path, value):
        path.write_text(json.dumps(value))

    def make_bundle(self):
        root = self.logs / "kite-trajectory"
        sections = []
        for name, kind, data in (("events/00000000.jsonl", "events", (json.dumps(self.native_event) + "\n").encode()), ("evidence/sample.bin", "evidence", b"native retained evidence")):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            section = {"kind": kind, "path": name, "bytes": str(len(data)), "sha256": hashlib.sha256(data).hexdigest()}
            section.update({"eventCount": 1} if kind == "events" else {"availability": "partial", "eventId": "event1", "evidenceId": "ev1", "contentVersion": "content-version"})
            sections.append(section)
        self.bundle = {"format": "kite.trajectory-bundle", "version": 1, "completePrefix": True,
            "integrity": {"facts": "unknown", "identityConfidence": "verified_origin", "reasons": []},
            "snapshot": {key: self.ids[key] for key in ("storeId", "sessionId", "runId")}, "sections": sections}
        self.write_json(root / "manifest.json", self.bundle)

    def evaluate(self, agent="kite", code=0, source=SHA):
        self.write_json(self.job / "result.json", self.job_data)
        self.write_json(self.trial / "result.json", self.trial_data)
        if agent == "kite":
            for name, value in (("kite-run", self.report), ("original-command", self.command), ("original-run", self.run), ("original-execution", self.execution), ("fixture-summary", self.fixture)):
                self.write_json(self.logs / (name + ".json"), value)
        self.events.write_text("\n".join(json.dumps(event) for event in self.docker) + "\n")
        return check(self.job, agent, code, self.task, self.events, source)

    def test_kite_success_retains_native_unknown_integrity(self):
        self.assertEqual(self.evaluate()["reward"], 1)

    def test_deprecated_explicit_import_is_also_exact(self):
        self.trial_data["config"]["agent"].update(name=None, import_path="kite_agent:KiteAgent")
        self.assertEqual(self.evaluate()["status"], "passed")

    def prepare_nop(self):
        self.trial_data["agent_info"]["name"] = "nop"
        self.trial_data["config"]["agent"].update(name="nop", import_path=None)
        self.trial_data["verifier_result"]["rewards"]["reward"] = 0
        self.aggregate["reward_stats"] = {"reward": {"0.0": [self.trial.name]}}
        (self.trial / "verifier/reward.txt").write_text("0\n")
        (self.trial / "verifier/test-stdout.txt").write_text("missing /app/answer.txt\n")
        (self.trial / "artifacts/app/answer.txt").unlink()
        self.write_json(self.trial / "artifacts/manifest.json", [{"source": "/app/answer.txt", "status": "failed"}])

    def test_nop_negative_control(self):
        self.prepare_nop()
        self.assertEqual(self.evaluate("nop")["reward"], 0)

    def test_nop_existing_output_is_rejected(self):
        self.prepare_nop()
        (self.trial / "artifacts/app/answer.txt").write_text("unexpected")
        with self.assertRaises(InvalidResult): self.evaluate("nop")

    def test_nop_requires_actual_missing_marker(self):
        self.prepare_nop()
        (self.trial / "verifier/test-stdout.txt").write_text("")
        with self.assertRaises(InvalidResult): self.evaluate("nop")

    def test_wrong_source_and_process_exit(self):
        for kwargs in ({"source": "b" * 40}, {"source": "invalid"}, {"code": 1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(InvalidResult): self.evaluate(**kwargs)

    def test_report_mutations(self):
        original = copy.deepcopy(self.report)
        for changes in ({"status": "unknown"}, {"status": "timed_out"}, {"cliExitCode": 2},
                {"cliExitCode": False}, {"sourceDirty": True}, {"realModelEvaluation": True},
                {"classification": "configured-model-run"}, {"error": "failed"}, {"finishedAt": None},
                {"originalIds": {key: "" for key in self.ids}}):
            with self.subTest(changes=changes), self.assertRaises(InvalidResult):
                self.report = {**copy.deepcopy(original), **changes}
                self.evaluate()
        self.report = original

    def test_trajectory_counts_and_export_mutations(self):
        original = copy.deepcopy(self.report["trajectory"])
        for changes in ({"eventCount": 0}, {"evidenceCount": 0}, {"exported": False},
                        {"evidenceIssueCount": 1}, {"eventCount": 20}):
            with self.subTest(changes=changes), self.assertRaises(InvalidResult):
                self.report["trajectory"] = {**original, **changes}
                self.evaluate()

    def test_cold_identity_mismatches(self):
        for record in (self.command, self.run, self.execution):
            for field in ("id", "originStoreId", "sessionId"):
                old = record[field]
                with self.subTest(field=field), self.assertRaises(InvalidResult):
                    record[field] = "different"
                    self.evaluate()
                record[field] = old

    def test_loopback_fixture_only(self):
        model = self.run["configuration"]["snapshot"]["configuration"]["models"][0]
        for url in ("https://example.com/v1", "http://127.0.0.1.evil/v1", "http://user:password@127.0.0.1:12/v1"):
            with self.subTest(url=url), self.assertRaises(InvalidResult):
                model["baseURL"] = url
                self.evaluate()

    def test_fixture_counters(self):
        for key, wrong in (("businessRequests", 3), ("writeCalls", 0), ("outputProducedByRealKiteTool", False)):
            old = self.fixture[key]
            with self.subTest(field=key), self.assertRaises(InvalidResult):
                self.fixture[key] = wrong
                self.evaluate()
            self.fixture[key] = old

    def test_native_bundle_corruption(self):
        (self.logs / "kite-trajectory/evidence/sample.bin").write_bytes(b"corrupted")
        with self.assertRaises(InvalidResult): self.evaluate()

    def test_bundle_path_traversal(self):
        self.bundle["sections"][0]["path"] = "../../outside"
        self.write_json(self.logs / "kite-trajectory/manifest.json", self.bundle)
        with self.assertRaises(InvalidResult): self.evaluate()

    def test_native_evidence_must_match_event_reference(self):
        self.bundle["sections"][1]["eventId"] = "orphan"
        self.write_json(self.logs / "kite-trajectory/manifest.json", self.bundle)
        with self.assertRaises(InvalidResult): self.evaluate()

    def test_native_tool_failure(self):
        self.native_event["recordedStatus"] = "failed"
        self.make_bundle()
        with self.assertRaises(InvalidResult): self.evaluate()

    def test_not_atif_or_missing_native(self):
        self.bundle["format"] = "ATIF"
        self.write_json(self.logs / "kite-trajectory/manifest.json", self.bundle)
        with self.assertRaises(InvalidResult): self.evaluate()

    def test_harbor_error_retry_or_incomplete_phase(self):
        for field in ("n_errored_trials", "n_retries", "n_running_trials", "n_pending_trials"):
            with self.subTest(field=field), self.assertRaises(InvalidResult):
                self.job_data["stats"][field] = 1
                self.evaluate()
            self.job_data["stats"][field] = 0
        for phase in ("environment_setup", "agent_setup", "agent_execution", "verifier"):
            old = self.trial_data[phase]
            with self.subTest(phase=phase), self.assertRaises(InvalidResult):
                self.trial_data[phase] = None
                self.evaluate()
            self.trial_data[phase] = old

    def test_exception_even_with_success_aggregate(self):
        self.trial_data["exception_info"] = {"exception_type": "RuntimeError"}
        with self.assertRaises(InvalidResult): self.evaluate()

    def test_reward_file_and_aggregate_must_match(self):
        (self.trial / "verifier/reward.txt").write_text("0\n")
        with self.assertRaises(InvalidResult): self.evaluate()
        (self.trial / "verifier/reward.txt").write_text("1\n")
        self.aggregate["reward_stats"] = {"reward": {"0": [self.trial.name]}}
        with self.assertRaises(InvalidResult): self.evaluate()

    def test_real_separation_and_order(self):
        original = copy.deepcopy(self.docker)
        mutations = [lambda: self.docker.pop(1), lambda: self.docker[1].update(timeNano=400),
            lambda: self.docker[2]["Actor"].update(ID="agent"),
            lambda: self.docker[0]["Actor"]["Attributes"].update({"com.docker.compose.service": "sidecar"}),
            lambda: self.docker[1].pop("timeNano")]
        for mutate in mutations:
            self.docker = copy.deepcopy(original)
            mutate()
            with self.assertRaises(InvalidResult): self.evaluate()

    def test_network_and_verifier_image(self):
        task = self.task / "task.toml"
        text = task.read_text()
        task.write_text(text.replace('"no-network"', '"bridge"'))
        with self.assertRaises(InvalidResult): self.evaluate()
        task.write_text(text)
        (self.task / "tests/Dockerfile").write_text("FROM alpine:latest\n")
        with self.assertRaises(InvalidResult): self.evaluate()

    def test_wrong_agent_and_model(self):
        config = self.trial_data["config"]["agent"]
        original = dict(config)
        for changes in ({"name": "kite"}, {"import_path": "other:Agent"}, {"model_name": "paid-model"}, {"base_url": "https://example.com"}):
            self.trial_data["config"]["agent"] = {**original, **changes}
            with self.assertRaises(InvalidResult): self.evaluate()

    def test_additional_trial_rejected(self):
        extra = self.job / "extra"
        extra.mkdir()
        (extra / "result.json").write_text("{}")
        with self.assertRaises(InvalidResult): self.evaluate()


if __name__ == "__main__":
    unittest.main()
