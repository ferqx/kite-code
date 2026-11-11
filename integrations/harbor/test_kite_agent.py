"""No model, process launcher, network, credentials, or Docker required."""
import asyncio
import copy
import json
from pathlib import Path, PurePosixPath
import shlex
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from harbor.models.agent.context import AgentContext
from kite_agent import KiteAgent, KiteRunError, MAX_REPORT_BYTES, validate_report


def report():
    return {
        "schema": "kite-harbor-run-1", "status": "succeeded", "cliExitCode": 0,
        "sourceCommit": "a" * 40, "classification": "deterministic-mock-plumbing-only",
        "realModelEvaluation": False,
        "originalIds": {key: "original-" + key for key in ("storeId", "sessionId", "commandId", "runId", "executionId")},
        "trajectory": {"exported": True, "eventCount": 4, "evidenceCount": 2, "evidenceIssueCount": 0},
    }


def result(code=0, stdout=""):
    return SimpleNamespace(return_code=code, stdout=stdout, stderr="")


class FakeEnvironment:
    def __init__(self, payload=None, exit_code=0, launch_error=None, artifact_error=None):
        self.payload = report() if payload is None else payload
        self.exit_code = exit_code
        self.launch_error = launch_error
        self.artifact_error = artifact_error
        self.commands = []
        self.uploads = []
        self.exec = AsyncMock(side_effect=self.execute)
        self.upload_file = AsyncMock(side_effect=self.upload)

    async def execute(self, **kwargs):
        self.commands.append(kwargs)
        command = kwargs["command"]
        if "head -c" in command:
            if self.artifact_error:
                raise self.artifact_error
            return result(stdout=self.payload if isinstance(self.payload, str) else json.dumps(self.payload))
        if "--instruction-file" in command:
            if self.launch_error:
                raise self.launch_error
            return result(self.exit_code)
        return result()

    async def upload(self, source, target):
        self.uploads.append((Path(source).read_text(), target))


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.agent = KiteAgent(logs_dir=Path(self.directory.name),
                               environment_logs_dir=PurePosixPath("/logs/agent"))
        self.context = AgentContext()

    async def test_instruction_is_uploaded_not_interpolated(self):
        env = FakeEnvironment()
        instruction = "do '$HOME' `touch /bad` $(false)\n你好\n"
        await self.agent.setup(env)
        await self.agent.run(instruction, env, self.context)
        self.assertEqual(env.uploads[0][0], instruction)
        self.assertRegex(env.uploads[0][1], r"^/tmp/kite-harbor-[0-9a-f-]+/instruction.txt$")
        calls = [c for c in env.commands if "--instruction-file" in c["command"]]
        self.assertEqual(len(calls), 1)
        self.assertNotIn(instruction, calls[0]["command"])
        self.assertEqual(shlex.split(calls[0]["command"])[0], "/opt/kite-harbor/launch")
        self.assertEqual(calls[0]["timeout_sec"], 180)
        self.assertEqual(self.context.metadata["kite"]["report"]["originalIds"], report()["originalIds"])
        self.assertIsNone(self.context.n_input_tokens)
        self.assertIsNone(self.context.cost_usd)
        self.assertFalse(self.agent.capabilities.atif)

    async def test_quoted_workspace_and_launcher(self):
        self.agent.workspace = "/app/a ' b"
        self.agent.launcher = "/opt/a ' b"
        env = FakeEnvironment()
        await self.agent.run("instruction", env, self.context)
        call = next(c for c in env.commands if "--instruction-file" in c["command"])
        words = shlex.split(call["command"])
        self.assertEqual(words[0], self.agent.launcher)
        self.assertEqual(words[words.index("--workspace") + 1], self.agent.workspace)

    async def test_non_success_statuses_preserved(self):
        for status in ("failed", "unknown", "needs_input", "cancelled", "timed_out"):
            with self.subTest(status=status):
                payload = report()
                payload.update(status=status, cliExitCode=2, originalIds={})
                payload["trajectory"]["exported"] = False
                env = FakeEnvironment(payload)
                context = AgentContext()
                with self.assertRaises(KiteRunError):
                    await self.agent.run("task", env, context)
                self.assertEqual(context.metadata["kite"]["report"]["status"], status)
                self.assertEqual(context.metadata["kite"]["adapterStatus"], status)
                self.assertEqual(sum("--instruction-file" in c["command"] for c in env.commands), 1)

    async def test_nonzero_launcher_cannot_succeed(self):
        env = FakeEnvironment(exit_code=7)
        with self.assertRaisesRegex(KiteRunError, "code 7"):
            await self.agent.run("task", env, self.context)
        self.assertEqual(self.context.metadata["kite"]["adapterStatus"], "unknown")

    async def test_artifact_error_does_not_mask_nonzero(self):
        env = FakeEnvironment(exit_code=7, artifact_error=OSError("artifact failed"))
        with self.assertRaisesRegex(KiteRunError, "code 7"):
            await self.agent.run("task", env, self.context)

    async def test_artifact_error_does_not_mask_launch_error(self):
        original = RuntimeError("original launch failed")
        env = FakeEnvironment(launch_error=original, artifact_error=OSError("artifact failed"))
        with self.assertRaises(RuntimeError) as caught:
            await self.agent.run("task", env, self.context)
        self.assertIs(caught.exception, original)
        self.assertTrue(self.context.metadata["kite"]["reportUnavailable"])

    async def test_cancellation_propagates(self):
        env = FakeEnvironment(launch_error=asyncio.CancelledError(), artifact_error=OSError("gone"))
        with self.assertRaises(asyncio.CancelledError):
            await self.agent.run("task", env, self.context)
        self.assertEqual(self.context.metadata["kite"]["adapterStatus"], "cancelled")

    async def test_malformed_missing_and_oversize_reports(self):
        for payload in ("", "not json", "[]", "x" * (MAX_REPORT_BYTES + 1)):
            with self.subTest(length=len(payload)):
                with self.assertRaises(KiteRunError):
                    await self.agent.run("task", FakeEnvironment(payload), AgentContext())
        env = FakeEnvironment()
        original = env.execute
        async def missing(**kwargs):
            return result(1) if "head -c" in kwargs["command"] else await original(**kwargs)
        env.exec.side_effect = missing
        with self.assertRaisesRegex(KiteRunError, "missing"):
            await self.agent.run("task", env, self.context)

    async def test_success_requires_all_original_ids_and_evidence(self):
        mutations = [lambda p: p["originalIds"].pop("runId"),
                     lambda p: p["trajectory"].update(exported=False),
                     lambda p: p["trajectory"].update(eventCount=0),
                     lambda p: p["trajectory"].update(evidenceIssueCount=1),
                     lambda p: p.update(cliExitCode=None)]
        for mutate in mutations:
            payload = report()
            mutate(payload)
            with self.assertRaisesRegex(KiteRunError, "completion evidence"):
                await self.agent.run("task", FakeEnvironment(payload), AgentContext())

    def test_metadata_whitelist_and_schema(self):
        payload = report()
        payload.update(secret="do not copy", error="arbitrary text")
        payload["originalIds"]["secret"] = "no"
        clean = validate_report(json.dumps(payload))
        self.assertEqual(clean, report())
        for changes in ({"cliExitCode": True}, {"realModelEvaluation": True},
                        {"sourceCommit": "wrong"}, {"status": []}, {"schema": "wrong"}):
            invalid = copy.deepcopy(payload)
            invalid.update(changes)
            with self.assertRaises(KiteRunError):
                validate_report(json.dumps(invalid))

    def test_configured_model_flag_is_exact(self):
        payload = report()
        payload["classification"] = "configured-model-run"
        with self.assertRaisesRegex(KiteRunError, "flag disagree"):
            validate_report(json.dumps(payload))
        payload["realModelEvaluation"] = True
        self.assertTrue(validate_report(json.dumps(payload))["realModelEvaluation"])

    def test_unsupported_options_are_rejected(self):
        for kwargs in (
            {"mcp_servers": [{"name": "unsupported"}]}, {"skills_dir": "/skills"},
            {"load_trajectory": "/old-session"}, {"extra_env": {"ANY_VALUE": "ignored"}},
            {"model_name": "provider/not-applied"}, {"config": {}},
            {"base_url": "http://localhost"}, {"model_api_key_name": "NOT_READ"},
            {"reasoning_effort": "high"}, {"disable_web_search": True},
            {"unrecognized_option": True},
        ):
            with self.subTest(options=list(kwargs)):
                with self.assertRaises(ValueError):
                    KiteAgent(logs_dir=Path(self.directory.name), **kwargs)
        # Empty framework defaults are harmless; no optional capability is claimed.
        agent = KiteAgent(logs_dir=Path(self.directory.name), mcp_servers=[],
                          skills_dir=None, extra_env={}, load_trajectory=None)
        self.assertFalse(any(agent.capabilities.model_dump().values()))

    def test_model_override_rejected_before_provider_parsing(self):
        with patch("harbor.agents.base.BaseAgent._init_model_info") as parse:
            with self.assertRaises(ValueError):
                KiteAgent(Path(self.directory.name), "provider/model")
            with self.assertRaises(ValueError):
                KiteAgent(logs_dir=Path(self.directory.name), model_name="provider/model")
            parse.assert_not_called()

    def test_preflight_rejects_unsupported_and_invalid_options(self):
        for kwargs in ({"config": {}}, {"launcher": "relative"}, {"deadline_ms": True},
                       {"disable_web_search": True}, {"reasoning_effort": "high"}):
            with self.subTest(options=list(kwargs)):
                with self.assertRaises(ValueError):
                    KiteAgent.preflight(kwargs)
        KiteAgent.preflight({"launcher": "/opt/launch", "deadline_ms": 1000})

    def test_invalid_options_rejected(self):
        for kwargs in ({"launcher": "relative"}, {"workspace": "/app/../tmp"},
                       {"deadline_ms": True}, {"deadline_ms": 0}):
            with self.assertRaises(ValueError):
                KiteAgent(logs_dir=Path(self.directory.name), **kwargs)


if __name__ == "__main__":
    unittest.main()
