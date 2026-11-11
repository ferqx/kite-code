"""Harbor transport for a preinstalled Kite launcher, not an installer or scorer."""
from __future__ import annotations

import asyncio
import json
import re
import shlex
import tempfile
from pathlib import Path, PurePosixPath
from uuid import uuid4

from harbor.agents.base import BaseAgent
from harbor.models.agent.context import AgentContext
from harbor.agents.options import AgentOptions
from pydantic import Field, StrictInt, field_validator

MAX_REPORT_BYTES = 1024 * 1024
STATUSES = {"succeeded", "failed", "unknown", "needs_input", "cancelled", "timed_out"}
ID_FIELDS = ("storeId", "sessionId", "commandId", "runId", "executionId")


class KiteRunError(RuntimeError):
    """Launcher failed or its completion could not be verified. Never retry here."""


def _absolute_path(value: str) -> str:
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise ValueError("Expected an absolute POSIX path")
    if ".." in PurePosixPath(value).parts:
        raise ValueError("Parent path segments are not permitted")
    return value


def validate_report(raw: str) -> dict:
    """Validate structural facts; exclude arbitrary launcher fields from metadata."""
    if len(raw.encode("utf-8")) > MAX_REPORT_BYTES:
        raise KiteRunError("Kite report exceeds size limit")
    try:
        report = json.loads(raw)
    except (ValueError, RecursionError) as exc:
        raise KiteRunError("Malformed Kite report") from exc
    if not isinstance(report, dict) or report.get("schema") != "kite-harbor-run-1":
        raise KiteRunError("Unsupported Kite report")
    if not isinstance(report.get("status"), str) or report["status"] not in STATUSES:
        raise KiteRunError("Invalid Kite status")
    code = report.get("cliExitCode")
    if code is not None and type(code) is not int:
        raise KiteRunError("Invalid CLI exit code")
    if not isinstance(report.get("sourceCommit"), str) or not re.fullmatch(r"[0-9a-f]{40}", report["sourceCommit"]):
        raise KiteRunError("Invalid source commit")
    classification = report.get("classification")
    if classification not in ("deterministic-mock-plumbing-only", "configured-model-run"):
        raise KiteRunError("Invalid run classification")
    if type(report.get("realModelEvaluation")) is not bool:
        raise KiteRunError("Invalid model evaluation flag")
    if report["realModelEvaluation"] != (classification == "configured-model-run"):
        raise KiteRunError("Classification and model evaluation flag disagree")
    ids, trajectory = report.get("originalIds"), report.get("trajectory")
    if not isinstance(ids, dict) or not isinstance(trajectory, dict):
        raise KiteRunError("Missing identity or trajectory report")
    clean_ids = {}
    for key in ID_FIELDS:
        value = ids.get(key)
        if value is not None:
            if not isinstance(value, str) or not value.strip() or len(value) > 1024:
                raise KiteRunError("Invalid original identity")
            clean_ids[key] = value
    if type(trajectory.get("exported")) is not bool:
        raise KiteRunError("Invalid trajectory export flag")
    clean_trajectory = {"exported": trajectory["exported"]}
    for key in ("eventCount", "evidenceCount", "evidenceIssueCount"):
        value = trajectory.get(key)
        if type(value) is not int or value < 0:
            raise KiteRunError("Invalid trajectory count")
        clean_trajectory[key] = value
    clean = {key: report[key] for key in (
        "schema", "status", "sourceCommit", "classification", "realModelEvaluation"
    )}
    clean.update(cliExitCode=code, originalIds=clean_ids, trajectory=clean_trajectory)
    # Arbitrary error text stays in the raw artifact, not replicated into metadata.
    return clean


class KiteOptions(AgentOptions):
    launcher: str = "/opt/kite-harbor/launch"
    workspace: str = "/app"
    deadline_ms: StrictInt = Field(default=120000, ge=1, le=86400000)

    @field_validator("launcher", "workspace")
    @classmethod
    def absolute_paths(cls, value):
        return _absolute_path(value)

    @field_validator("disable_web_search")
    @classmethod
    def no_native_web_override(cls, value):
        if value:
            raise ValueError("Kite launcher does not apply Harbor web-tool overrides")
        return value


class KiteAgent(BaseAgent):
    """Generic launcher adapter. All optional Harbor capabilities remain false."""

    options_model = KiteOptions

    def __init__(self, *args, launcher="/opt/kite-harbor/launch", workspace="/app", deadline_ms=120000, **kwargs):
        # Reject before BaseAgent model parsing, which can import provider tooling.
        if kwargs.get("model_name") or (len(args) > 1 and args[1]):
            raise ValueError("Kite launcher does not apply Harbor model_name; provision runtime configuration explicitly")
        self.launcher = _absolute_path(launcher)
        self.workspace = _absolute_path(workspace)
        if type(deadline_ms) is not int or not 1 <= deadline_ms <= 86400000:
            raise ValueError("deadline_ms must be an integer between 1 and 86400000")
        self.deadline_ms = deadline_ms
        super().__init__(*args, launcher=launcher, workspace=workspace, deadline_ms=deadline_ms, **kwargs)
        for name, value in (
            ("mcp_servers", self.mcp_servers), ("skills_dir", self.skills_dir),
            ("load_trajectory", self.load_trajectory), ("extra_env", self._extra_env),
            ("model_name", self.model_name),
        ):
            if value:
                raise ValueError(f"Kite launcher does not apply Harbor {name}; provision runtime configuration explicitly")
        self.output = str(self.environment_logs_dir / "kite")

    @staticmethod
    def name() -> str:
        return "kite"

    def version(self) -> str:
        return "harbor-adapter-0.1.0"

    async def setup(self, environment) -> None:
        result = await environment.exec(
            command=f"test -x {shlex.quote(self.launcher)} && test -d {shlex.quote(self.workspace)}",
            timeout_sec=10,
        )
        if result.return_code != 0:
            raise KiteRunError("Preinstalled Kite launcher or workspace is unavailable")

    async def _read_report(self, environment) -> dict:
        path = shlex.quote(str(PurePosixPath(self.output) / "kite-run.json"))
        result = await environment.exec(
            command=f"test -f {path} && head -c {MAX_REPORT_BYTES + 1} -- {path}",
            timeout_sec=10,
        )
        if result.return_code != 0:
            raise KiteRunError("Kite report is missing or unreadable")
        return validate_report(result.stdout or "")

    async def run(self, instruction: str, environment, context: AgentContext) -> None:
        metadata = dict(context.metadata or {})
        state = {"adapterStatus": "starting", "reportPath": f"{self.output}/kite-run.json"}
        metadata["kite"] = state
        context.metadata = metadata
        input_dir = f"/tmp/kite-harbor-{uuid4()}"
        input_path = f"{input_dir}/instruction.txt"
        try:
            result = await environment.exec(
                command=f"umask 077; mkdir -p {shlex.quote(input_dir)} {shlex.quote(self.output)}",
                timeout_sec=10,
            )
            if result.return_code != 0:
                raise KiteRunError("Could not prepare Kite runtime directories")
            with tempfile.TemporaryDirectory(prefix="harbor-kite-input-") as directory:
                source = Path(directory) / "instruction.txt"
                source.write_text(instruction, encoding="utf-8")
                source.chmod(0o600)
                await asyncio.wait_for(environment.upload_file(source, input_path), timeout=10)
            argv = [self.launcher, "--instruction-file", input_path, "--workspace", self.workspace,
                    "--output", self.output, "--deadline-ms", str(self.deadline_ms)]
            state["adapterStatus"] = "running"
            result = await environment.exec(
                command=shlex.join(argv), cwd=self.workspace,
                timeout_sec=(self.deadline_ms + 999) // 1000 + 60,
            )
            state["launcherExitCode"] = result.return_code
            try:
                report = await self._read_report(environment)
            except Exception:
                if result.return_code != 0:
                    raise KiteRunError(f"Kite launcher exited with code {result.return_code}; report unavailable") from None
                raise
            state["report"] = report
            state["adapterStatus"] = report["status"]
            if result.return_code != 0:
                raise KiteRunError(f"Kite launcher exited with code {result.return_code}")
            if report["status"] != "succeeded":
                raise KiteRunError(f"Kite outcome: {report['status']}")
            if (report["cliExitCode"] != 0 or len(report["originalIds"]) != len(ID_FIELDS)
                    or not report["trajectory"]["exported"]
                    or report["trajectory"]["eventCount"] <= 0
                    or report["trajectory"]["evidenceIssueCount"] != 0):
                state["adapterStatus"] = "unknown"
                raise KiteRunError("Kite success report lacks verified completion evidence")
        except BaseException as exc:
            if isinstance(exc, asyncio.CancelledError):
                state["adapterStatus"] = "cancelled"
            elif state["adapterStatus"] in ("starting", "running", "succeeded"):
                state["adapterStatus"] = "unknown"
            if "report" not in state:
                try:
                    state["report"] = await asyncio.wait_for(self._read_report(environment), timeout=5)
                except (Exception, asyncio.CancelledError):
                    state["reportUnavailable"] = True
            raise
