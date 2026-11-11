"""Fail closed on Harbor 0.25.0's one-task Docker/separate-verifier result.

A zero Harbor process exit code does not imply a successful trial. This checker
requires complete execution, zero errors/retries, the requested agent, an actual
independent verifier result, and its persisted reward. It is not a Kite model
benchmark or a general sandbox security qualification.
"""

import argparse
import hashlib
from urllib.parse import urlparse
import json
import re
from pathlib import Path
import tomllib


class InvalidResult(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidResult(message)


def read_json(path):
    return json.loads(path.read_text())



def positive_int(value):
    return type(value) is int and value > 0


def check_bundle(root, ids, trajectory):
    manifest = read_json(root / "manifest.json")
    require(manifest["format"] == "kite.trajectory-bundle" and manifest["version"] == 1, "not a native Kite bundle")
    require(manifest["completePrefix"] is True, "incomplete native prefix")
    for key in ("storeId", "sessionId", "runId"):
        require(manifest["snapshot"][key] == ids[key], "native snapshot identity mismatch")
    events, evidence_count, paths = [], 0, set()
    evidence_keys = set()
    for section in manifest["sections"]:
        relative = Path(section["path"])
        require(not relative.is_absolute() and ".." not in relative.parts, "unsafe bundle path")
        path = root / relative
        require(path.resolve().is_relative_to(root.resolve()) and not path.is_symlink(), "bundle path escaped root")
        require(str(relative) not in paths, "duplicate bundle section")
        paths.add(str(relative))
        data = path.read_bytes()
        require(str(len(data)) == section["bytes"], "bundle section size mismatch")
        require(hashlib.sha256(data).hexdigest() == section["sha256"], "bundle section checksum mismatch")
        if section["kind"] == "events":
            batch = [json.loads(line) for line in data.splitlines()]
            require(len(batch) == section["eventCount"], "native event count mismatch")
            events.extend(batch)
        elif section["kind"] == "evidence":
            # Native partial evidence is a real retained fact, not export failure.
            require(section["availability"] in ("available", "partial"), "unavailable native evidence")
            key = (section["eventId"], section["evidenceId"], section["contentVersion"])
            require(key not in evidence_keys, "duplicate native evidence identity")
            evidence_keys.add(key)
            evidence_count += 1
        else:
            raise InvalidResult("unexpected native section")
    require(len(events) == trajectory["eventCount"] and evidence_count == trajectory["evidenceCount"], "reported native counts differ")
    require(len({event["eventId"] for event in events}) == len(events), "duplicate native events")
    referenced_evidence = set()
    for event in events:
        require(event["schema"] == "kite.trajectory", "wrong native event schema")
        require(event["origin"]["storeId"] == ids["storeId"], "native event origin mismatch")
        for ref in event["evidenceRefs"]:
            referenced_evidence.add((event["eventId"], ref["evidenceId"], ref["contentVersion"]))
        require(event["sessionId"] == ids["sessionId"] and event["runId"] == ids["runId"], "native event identity mismatch")
    require(evidence_keys == referenced_evidence, "native evidence references differ from exported sections")
    require(sum(event["kind"] == "tool" and event["recordedStatus"] == "succeeded" and event["attributes"].get("definitionId") == "files.write" for event in events) == 1, "missing real successful write tool event")


def check_kite(root, source_commit):
    report = read_json(root / "kite-run.json")
    require(report["schema"] == "kite-harbor-run-1", "wrong launcher schema")
    require(report["status"] == "succeeded" and type(report["cliExitCode"]) is int and report["cliExitCode"] == 0, "Kite did not succeed")
    require(report["sourceCommit"] == source_commit and report["sourceDirty"] is False, "wrong or dirty Kite source")
    require(report["classification"] == "deterministic-mock-plumbing-only" and report["realModelEvaluation"] is False, "not a mock-only run")
    require(not report.get("error") and not report.get("cleanup"), "runtime error or cleanup uncertainty")
    require(bool(report["startedAt"]) and bool(report["finishedAt"]), "unfinished Kite run")
    ids = report["originalIds"]
    for key in ("storeId", "sessionId", "commandId", "runId", "executionId"):
        require(isinstance(ids[key], str) and bool(ids[key].strip()), "missing original identity")
    trajectory = report["trajectory"]
    require(trajectory["exported"] is True and positive_int(trajectory["eventCount"]) and positive_int(trajectory["evidenceCount"]), "missing native trajectory export")
    require(type(trajectory["evidenceIssueCount"]) is int and trajectory["evidenceIssueCount"] == 0, "trajectory evidence errors")
    command = read_json(root / "original-command.json")
    run = read_json(root / "original-run.json")
    execution = read_json(root / "original-execution.json")
    for record in (command, run, execution):
        require(record["originStoreId"] == ids["storeId"] and record["sessionId"] == ids["sessionId"], "cold identity mismatch")
    require(command["id"] == ids["commandId"] and command["kind"] == "run.start" and command["status"] == "applied", "wrong original command")
    require(command["receipt"]["runId"] == ids["runId"], "command receipt mismatch")
    require(run["id"] == ids["runId"] and run["originCommandId"] == ids["commandId"] and run["status"] == "completed" and run["isActive"] is False, "wrong original run")
    require(execution["id"] == ids["executionId"] and execution["runId"] == ids["runId"] and execution["kind"] == "model" and execution["status"] == "succeeded", "wrong original execution")
    require(execution["definitionId"] == "harbor-local-fixture", "unexpected execution provider")
    configuration = run["configuration"]["snapshot"]["configuration"]
    require(configuration["modelId"] == "harbor-local-fixture", "wrong configured fixture")
    models = configuration["models"]
    require(len(models) == 1, "unexpected model configurations")
    model = models[0]
    require(model["id"] == "harbor-local-fixture" and model["model"] == "deterministic-tool-fixture" and model["provider"] == "compatible", "unexpected fixture model")
    url = urlparse(model["baseURL"])
    require(url.scheme == "http" and url.hostname == "127.0.0.1" and url.port and url.path == "/v1" and not url.username and not url.password and not url.query and not url.fragment, "fixture endpoint is not owned loopback")
    require(not any("key" in key.lower() or "token" in key.lower() or "auth" in key.lower() for key in model), "unexpected fixture credential fields")
    fixture = read_json(root / "fixture-summary.json")
    require(fixture["classification"] == "deterministic-mock-plumbing-only", "wrong fixture classification")
    require(type(fixture["businessRequests"]) is int and fixture["businessRequests"] == 2 and type(fixture["writeCalls"]) is int and fixture["writeCalls"] == 1 and fixture["outputProducedByRealKiteTool"] is True, "fixture did not execute expected real tool path")
    check_bundle(root / "kite-trajectory", ids, trajectory)


def check(job_dir, agent, process_exit_code, task_dir, docker_events, source_commit):
    require(agent in ("kite", "nop"), "unsupported agent")
    require(process_exit_code == 0, f"Harbor exited {process_exit_code}")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", source_commit)), "invalid expected source commit")
    expected = 1 if agent == "kite" else 0
    task = tomllib.loads((task_dir / "task.toml").read_text())
    require(task["verifier"]["environment_mode"] == "separate", "task verifier is not separate")
    for env in (task["environment"], task["verifier"]["environment"]):
        require(env["network_mode"] == "no-network", "task networking is enabled")

    require(task["task"]["name"] == "kite/real-cli-file-smoke", "wrong source task")
    require(task["artifacts"] == ["/app/answer.txt"], "wrong task artifact selection")
    dockerfile = (task_dir / "tests/Dockerfile").read_text()
    require(re.search(r"(?im)^FROM\s+ubuntu:24\.04\s*$", dockerfile) is not None, "verifier is not the expected Ubuntu image")
    job = read_json(job_dir / "result.json")
    require(job["n_total_trials"] == 1, "expected exactly one scheduled trial")
    require(bool(job["finished_at"]), "job did not finish")
    stats = job["stats"]
    for field, value in {
        "n_completed_trials": 1,
        "n_errored_trials": 0,
        "n_running_trials": 0,
        "n_pending_trials": 0,
        "n_cancelled_trials": 0,
        "n_retries": 0,
    }.items():
        require(stats[field] == value, f"unexpected {field}: {stats[field]}")
    evals = stats["evals"]
    require(len(evals) == 1, "expected exactly one aggregate evaluation")
    evaluation = next(iter(evals.values()))
    require(evaluation["n_trials"] == 1, "no completed verifier evaluation")
    require(evaluation["n_errors"] == 0, "aggregate evaluation contains errors")
    require(not evaluation["exception_stats"], "aggregate exceptions are present")

    paths = sorted(job_dir.glob("*/result.json"))
    require(len(paths) == 1, f"expected exactly one trial result, found {len(paths)}")
    trial = read_json(paths[0])
    require(trial["task_name"] == "kite/real-cli-file-smoke", "unexpected task")
    require(trial["exception_info"] is None, "trial contains an exception")
    require(not trial.get("step_results"), "unexpected multi-step result")
    require(bool(trial["started_at"]) and bool(trial["finished_at"]), "trial is incomplete")
    for phase in ("environment_setup", "agent_setup", "agent_execution", "verifier"):
        timing = trial[phase]
        require(isinstance(timing, dict) and bool(timing.get("started_at")) and bool(timing.get("finished_at")), f"{phase} did not finish")
    require(trial["agent_info"]["name"] == agent, "wrong agent result")
    require(trial["agent_info"]["model_info"] is None, "unexpected model use")
    config = trial["config"]
    require(config["install_only"] is False, "install-only trial")
    if agent == "kite":
        require((config["agent"]["name"], config["agent"]["import_path"]) in (("kite_agent:KiteAgent", None), (None, "kite_agent:KiteAgent")), "wrong custom agent")
    else:
        require(config["agent"]["name"] == "nop" and config["agent"]["import_path"] is None, "wrong nop agent")
    for key in ("base_url", "model_api_key_name", "model_api_format"):
        require(config["agent"].get(key) is None, "unexpected inference configuration")
    require(not config["agent"].get("env"), "unexpected agent environment overlay")
    require(set(config["agent"].get("kwargs", {})) <= {"launcher", "workspace", "deadline_ms"}, "unexpected agent options")
    require(not config["agent"].get("mcp_servers") and not config["agent"].get("skills"), "unexpected agent integrations")
    require(config["agent"]["model_name"] is None, "unexpected configured model")
    require(config["environment"]["type"] == "docker", "not the official Docker environment")
    require(config["environment"]["import_path"] is None, "unexpected custom environment")
    require(config["verifier"]["disable"] is False, "verifier was disabled")
    require(trial["verifier_environment_mode"] == "separate", "verifier did not run separately")
    verifier_result = trial["verifier_result"]
    require(isinstance(verifier_result, dict), "missing verifier result")
    require(verifier_result["rewards"] == {"reward": expected}, f"expected reward {expected}")
    reward_path = paths[0].parent / "verifier" / "reward.txt"
    require(reward_path.read_text().strip() == str(expected), "persisted reward does not match")
    require(not list(job_dir.rglob("exception.txt")), "exception evidence exists")
    reward_stats = evaluation["reward_stats"]
    require(set(reward_stats) == {"reward"}, "unexpected aggregate reward keys")
    values = reward_stats["reward"]
    require(len(values) == 1, "unexpected aggregate reward values")
    value, names = next(iter(values.items()))
    require(float(value) == expected and names == [trial["trial_name"]], "aggregate reward differs from trial")

    artifacts = paths[0].parent / "artifacts"
    manifest = read_json(artifacts / "manifest.json")
    require(isinstance(manifest, list), "invalid artifact manifest")
    sources = [entry["source"] for entry in manifest]
    require(len(sources) == len(set(sources)), "duplicate artifact sources")
    statuses = {entry["source"]: entry["status"] for entry in manifest}
    answer_path = artifacts / "app/answer.txt"
    if agent == "kite":
        require(statuses.get("/app/answer.txt") == "ok", "answer artifact not collected")
        require(answer_path.read_bytes() == b"Kite Harbor adapter smoke passed\n", "wrong answer artifact")
        check_kite(paths[0].parent / "agent/kite", source_commit)
    else:
        require(statuses.get("/app/answer.txt") == "failed", "nop unexpectedly produced answer")
        require(not answer_path.exists(), "nop unexpectedly exported answer")
        require(not (paths[0].parent / "agent/kite/kite-run.json").exists(), "nop has Kite run evidence")
        stdout = (paths[0].parent / "verifier/test-stdout.txt").read_text()
        require("missing /app/answer.txt" in stdout, "missing negative-control verifier evidence")

    # Independent Docker daemon evidence must identify distinct started containers.
    project = re.sub(r"[^a-z0-9_-]", "-", trial["trial_name"].lower())
    require(bool(re.match(r"^[a-z0-9]", project)), "unexpected trial project name")
    starts = {}
    lifecycle = []
    for line in docker_events.read_text().splitlines():
        event = json.loads(line)
        if event.get("Type") == "container" and event.get("Action") in ("start", "destroy"):
            actor = event["Actor"]
            if actor["Attributes"].get("com.docker.compose.service") != "main":
                continue
            label = actor["Attributes"].get("com.docker.compose.project")
            if label not in (project + "__env", project + "__verifier__trial"):
                continue
            require(type(event.get("timeNano")) is int, "Docker event lacks nanosecond timestamp")
            lifecycle.append((event["Action"], actor["ID"], event["timeNano"]))
            if event["Action"] == "start":
                starts.setdefault(label, set()).add(actor["ID"])
    agent_ids = starts.get(project + "__env", set())
    verifier_ids = starts.get(project + "__verifier__trial", set())
    require(len(agent_ids) == 1 and len(verifier_ids) == 1 and agent_ids.isdisjoint(verifier_ids), "missing distinct agent/verifier Docker container starts")
    agent_id, verifier_id = next(iter(agent_ids)), next(iter(verifier_ids))
    agent_start = [time for action, id_, time in lifecycle if action == "start" and id_ == agent_id]
    agent_destroy = [time for action, id_, time in lifecycle if action == "destroy" and id_ == agent_id]
    verifier_start = [time for action, id_, time in lifecycle if action == "start" and id_ == verifier_id]
    require(len(agent_start) == len(agent_destroy) == len(verifier_start) == 1, "ambiguous container lifecycle")
    require(agent_start[0] < agent_destroy[0] < verifier_start[0], "agent not destroyed before verifier started")
    return {
        "status": "passed",
        "agent": agent,
        "reward": expected,
        "trial_id": trial["id"],
        "trial_name": trial["trial_name"],
        "task_checksum": trial["task_checksum"],
        "environment": "docker",
        "verifier_environment_mode": "separate",
        "n_exceptions": 0,
        "agent_container_ids": sorted(agent_ids),
        "verifier_container_ids": sorted(verifier_ids),
        "source_commit": source_commit,
        "scope": "Real Kite CLI/Service with deterministic loopback provider; not a real-model benchmark.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--agent", choices=("kite", "nop"), required=True)
    parser.add_argument("--process-exit-code", type=int, required=True)
    parser.add_argument("--task-dir", type=Path, required=True)
    parser.add_argument("--docker-events", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = check(args.job_dir, args.agent, args.process_exit_code, args.task_dir, args.docker_events, args.source_commit)
    except (InvalidResult, OSError, ValueError, KeyError, TypeError) as error:
        result = {"status": "failed", "agent": args.agent, "error": str(error)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
