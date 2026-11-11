"""Synthetic tests of the checker, not Docker execution evidence."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

from check_result import InvalidResult, check


class CheckResultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.job = self.root / "job"
        self.trial = self.job / "separate-verifier-environment__abc123"
        self.task = self.root / "task"
        self.events = self.root / "events.jsonl"
        self.task.mkdir()
        (self.trial / "verifier").mkdir(parents=True)
        (self.trial / "artifacts/logs/artifacts").mkdir(parents=True)
        (self.trial / "artifacts/tmp").mkdir(parents=True)
        (self.task / "task.toml").write_text('''
[environment]
network_mode = "no-network"
[verifier]
environment_mode = "separate"
[verifier.environment]
network_mode = "no-network"
''')
        self.job_data = {
            "n_total_trials": 1,
            "finished_at": "2026-11-11T12:00:00Z",
            "stats": {
                "n_completed_trials": 1, "n_errored_trials": 0,
                "n_running_trials": 0, "n_pending_trials": 0,
                "n_cancelled_trials": 0, "n_retries": 0,
                "evals": {"expected__adhoc": {"n_trials": 1, "n_errors": 0, "exception_stats": {}, "reward_stats": {"reward": {"1.0": [self.trial.name]}}}},
            },
        }
        timing = {"started_at": "2026-11-11T11:59:00Z", "finished_at": "2026-11-11T12:00:00Z"}
        self.trial_data = {
            "id": "synthetic-trial-id", "task_name": "harbor/separate-verifier-environment",
            "trial_name": self.trial.name, "task_checksum": "synthetic-checksum",
            "exception_info": None, "started_at": timing["started_at"], "finished_at": timing["finished_at"],
            "environment_setup": timing, "agent_setup": timing, "agent_execution": timing, "verifier": timing,
            "agent_info": {"name": "oracle", "model_info": None},
            "config": {
                "install_only": False,
                "agent": {"name": "oracle", "import_path": None, "model_name": None},
                "environment": {"type": "docker", "import_path": None},
                "verifier": {"disable": False},
            },
            "verifier_environment_mode": "separate",
            "verifier_result": {"rewards": {"reward": 1}},
        }
        project = self.trial.name
        self.events.write_text("\n".join(json.dumps({"Type": "container", "Action": "start", "Actor": {"ID": id_, "Attributes": {"com.docker.compose.project": name, "com.docker.compose.service": "main"}}}) for id_, name in [("agent-container", project + "__env"), ("verifier-container", project + "__verifier__trial")]) + "\n")
        self.prepare_agent("oracle")

    def prepare_agent(self, agent):
        reward = 1 if agent == "oracle" else 0
        self.trial_data["agent_info"]["name"] = agent
        self.trial_data["config"]["agent"]["name"] = agent
        self.trial_data["verifier_result"] = {"rewards": {"reward": reward}}
        self.job_data["stats"]["evals"]["expected__adhoc"]["reward_stats"] = {"reward": {str(float(reward)): [self.trial.name]}}
        (self.trial / "verifier/reward.txt").write_text(str(reward) + "\n")
        (self.trial / "verifier/test-stdout.txt").write_text("missing /logs/artifacts/answer.txt from copied convention artifacts\nmissing configured artifact at /tmp/configured-artifact.txt\n" if agent == "nop" else "")
        (self.trial / "artifacts/manifest.json").write_text(json.dumps([
            {"source": "/logs/artifacts", "status": "ok" if agent == "oracle" else "empty"},
            {"source": "/tmp/configured-artifact.txt", "status": "ok" if agent == "oracle" else "failed"},
        ]))
        if agent == "nop":
            for artifact in ("logs/artifacts/answer.txt", "tmp/configured-artifact.txt"):
                (self.trial / "artifacts" / artifact).unlink(missing_ok=True)
        if agent == "oracle":
            (self.trial / "artifacts/logs/artifacts/answer.txt").write_text("separate verifier ok\n")
            (self.trial / "artifacts/tmp/configured-artifact.txt").write_text("configured artifact ok\n")

    def evaluate(self, agent="oracle", code=0):
        (self.job / "result.json").write_text(json.dumps(self.job_data))
        (self.trial / "result.json").write_text(json.dumps(self.trial_data))
        return check(self.job, agent, code, self.task, self.events)

    def test_oracle_pass(self):
        self.assertEqual(self.evaluate()["reward"], 1)

    def test_nop_pass_with_expected_missing_artifacts(self):
        self.prepare_agent("nop")
        self.assertEqual(self.evaluate("nop")["reward"], 0)

    def test_nop_downloaded_empty_directory_is_valid(self):
        self.prepare_agent("nop")
        manifest_path = self.trial / "artifacts/manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest[0]["status"] = "ok"
        manifest_path.write_text(json.dumps(manifest))
        self.assertEqual(self.evaluate("nop")["reward"], 0)

    def test_nop_unexpected_output_is_rejected(self):
        self.prepare_agent("nop")
        (self.trial / "artifacts/logs/artifacts/answer.txt").write_text("unexpected")
        with self.assertRaises(InvalidResult):
            self.evaluate("nop")

    def test_sidecar_does_not_prove_main_container_execution(self):
        self.events.write_text(self.events.read_text().replace('"main"', '"harbor-docker-egress-control-sidecar"'))
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_wrong_agent_project_is_rejected(self):
        self.events.write_text(self.events.read_text().replace("__env", "__other"))
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_nonzero_process_rejected(self):
        with self.assertRaises(InvalidResult):
            self.evaluate(code=1)

    def test_zero_exit_with_harbor_error_rejected(self):
        self.job_data["stats"]["n_errored_trials"] = 1
        self.trial_data["exception_info"] = {"exception_type": "RuntimeError"}
        self.trial_data["verifier_result"] = None
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_trial_error_rejected_even_when_aggregate_is_wrong(self):
        self.trial_data["exception_info"] = {"exception_type": "RuntimeError"}
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_each_incomplete_phase_rejected(self):
        original = copy.deepcopy(self.trial_data)
        for phase in ("environment_setup", "agent_setup", "agent_execution", "verifier"):
            with self.subTest(phase=phase), self.assertRaises(InvalidResult):
                self.trial_data = copy.deepcopy(original)
                self.trial_data[phase] = None
                self.evaluate()

    def test_shared_verifier_rejected(self):
        self.trial_data["verifier_environment_mode"] = "shared"
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_non_docker_rejected(self):
        self.trial_data["config"]["environment"]["type"] = "modal"
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_wrong_reward_rejected(self):
        self.trial_data["verifier_result"]["rewards"]["reward"] = 0
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_reward_file_mismatch_rejected(self):
        (self.trial / "verifier/reward.txt").write_text("0\n")
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_missing_verifier_result_rejected(self):
        self.trial_data["verifier_result"] = None
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_multiple_trials_rejected(self):
        extra = self.job / "extra"
        extra.mkdir()
        (extra / "result.json").write_text("{}")
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_retry_rejected(self):
        self.job_data["stats"]["n_retries"] = 1
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_missing_field_fails_closed(self):
        del self.trial_data["exception_info"]
        with self.assertRaises(KeyError):
            self.evaluate()

    def test_missing_artifact_rejected(self):
        (self.trial / "artifacts/logs/artifacts/answer.txt").unlink()
        with self.assertRaises(OSError):
            self.evaluate()

    def test_one_container_cannot_count_as_two(self):
        self.events.write_text(self.events.read_text().replace("verifier-container", "agent-container"))
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_missing_docker_events_rejected(self):
        self.events.write_text("")
        with self.assertRaises(InvalidResult):
            self.evaluate()

    def test_model_configuration_rejected(self):
        self.trial_data["config"]["agent"]["model_name"] = "unexpected-model"
        with self.assertRaises(InvalidResult):
            self.evaluate()


if __name__ == "__main__":
    unittest.main()
