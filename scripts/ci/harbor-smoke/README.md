# Harbor Docker isolation smoke

This opt-in CI experiment validates the container prerequisite for a later Kite
adapter. It does not run Kite, call a model, or establish a benchmark score.

The dedicated `ci/harbor-isolation-smoke-20261111` branch triggers
`.github/workflows/harbor-isolation-smoke.yml`. It uses two standard GitHub-hosted
Ubuntu 24.04 jobs, each capped at 25 minutes, with a 15-minute Harbor command
limit. There is no schedule, PR trigger, deployment, or secret input. Repository
permissions are read-only; checkout does not persist credentials. The workflow
records raw results and logs as seven-day Actions artifacts.

Each job installs PyPI `harbor==0.25.0` and runs exactly one attempt, with no
retries, of the unmodified official `separate-verifier-environment` example from
Harbor commit `fdba28fc411e47e8765420a1a063b4918fce3def`. The example keeps both
agent and verifier network-disabled and transfers only declared output
artifacts into a separate verifier container. The official Ubuntu base image
uses a tag; resolved image IDs/digests and installed Python packages are retained
for provenance rather than claimed to be transitively locked.

`oracle` must produce reward 1. `nop` must produce reward 0 because its requested
files are absent. The nop missing-artifact manifest entries are expected, not
trial exceptions. Both must complete with zero exceptions. The checker requires
actual results, completed phases, the official Docker backend, separate-verifier
mode, aggregate/trial/reward-file agreement, artifact evidence, and distinct
agent/verifier container starts from Docker daemon events. A zero process exit
code alone is insufficient. The oracle's unconfigured agent-only file must not
be visible to the verifier, as checked by the unmodified official verifier.

Run checker unit tests locally:

```sh
python3 -m unittest discover -s scripts/ci/harbor-smoke -p 'test_*.py' -v
```

These synthetic tests verify rejection logic only. A successful Actions run is
still required for real Docker evidence. This smoke is neither an adversarial
sandbox audit nor Kite adapter, real-model, or platform-release qualification.
No product behavior or existing runtime contracts are changed.
