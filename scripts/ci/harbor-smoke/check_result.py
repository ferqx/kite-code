"""Fail closed on Harbor 0.25.0's one-task Docker/separate-verifier result.

A zero Harbor process exit code does not imply a successful trial. This checker
requires complete execution, zero errors/retries, the requested agent, an actual
independent verifier result, and its persisted reward. It is not a Kite model
benchmark or a general sandbox security qualification.
"""

import argparse
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


def check(job_dir, agent, process_exit_code, task_dir, docker_events):
    require(agent in ("oracle", "nop"), "unsupported agent")
    require(process_exit_code == 0, f"Harbor exited {process_exit_code}")
    expected = 1 if agent == "oracle" else 0
    task = tomllib.loads((task_dir / "task.toml").read_text())
    require(task["verifier"]["environment_mode"] == "separate", "task verifier is not separate")
    for env in (task["environment"], task["verifier"]["environment"]):
        require(env["network_mode"] == "no-network", "task networking is enabled")

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
    require(trial["task_name"] == "harbor/separate-verifier-environment", "unexpected task")
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
    require(config["agent"]["name"] == agent, "wrong configured agent")
    require(config["agent"]["import_path"] is None, "unexpected custom agent")
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
    statuses = {entry["source"]: entry["status"] for entry in manifest}
    if agent == "oracle":
        require(statuses.get("/logs/artifacts") == "ok", "convention artifact was not collected")
        require(statuses.get("/tmp/configured-artifact.txt") == "ok", "configured artifact was not collected")
        require((artifacts / "logs/artifacts/answer.txt").read_text() == "separate verifier ok\n", "wrong answer artifact")
        require((artifacts / "tmp/configured-artifact.txt").read_text() == "configured artifact ok\n", "wrong configured artifact")
    else:
        # Downloading an empty directory reports "ok"; a mounted empty directory
        # reports "empty". Actual missing output, not this label, is decisive.
        require(statuses.get("/logs/artifacts") in ("ok", "empty"), "nop convention directory was not collected")
        require(not any((artifacts / "logs/artifacts").rglob("*")), "nop unexpectedly produced convention artifacts")
        require(not (artifacts / "tmp/configured-artifact.txt").exists(), "nop unexpectedly exported a configured artifact")
        require(statuses.get("/tmp/configured-artifact.txt") == "failed", "nop unexpectedly produced configured artifact")
        stdout = (paths[0].parent / "verifier/test-stdout.txt").read_text()
        require("missing /logs/artifacts/answer.txt" in stdout and "missing configured artifact" in stdout, "missing negative-control verifier evidence")

    # Independent Docker daemon evidence must identify distinct started containers.
    project = re.sub(r"[^a-z0-9_-]", "-", trial["trial_name"].lower())
    require(bool(re.match(r"^[a-z0-9]", project)), "unexpected trial project name")
    starts = {}
    for line in docker_events.read_text().splitlines():
        event = json.loads(line)
        if event.get("Type") == "container" and event.get("Action") == "start":
            actor = event["Actor"]
            if actor["Attributes"].get("com.docker.compose.service") != "main":
                continue
            label = actor["Attributes"].get("com.docker.compose.project")
            starts.setdefault(label, set()).add(actor["ID"])
    agent_ids = starts.get(project + "__env", set())
    verifier_ids = starts.get(project + "__verifier__trial", set())
    require(len(agent_ids) == 1 and len(verifier_ids) == 1 and agent_ids.isdisjoint(verifier_ids), "missing distinct agent/verifier Docker container starts")
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
        "scope": "Official Harbor isolation smoke only; not a Kite model benchmark.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--agent", choices=("oracle", "nop"), required=True)
    parser.add_argument("--process-exit-code", type=int, required=True)
    parser.add_argument("--task-dir", type=Path, required=True)
    parser.add_argument("--docker-events", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = check(args.job_dir, args.agent, args.process_exit_code, args.task_dir, args.docker_events)
    except (InvalidResult, OSError, ValueError, KeyError, TypeError) as error:
        result = {"status": "failed", "agent": args.agent, "error": str(error)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
