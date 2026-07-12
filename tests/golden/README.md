# Runtime golden tests

Each JSON fixture is a deterministic sequence of durable `RuntimeEvent` facts. The shared runner applies it through the production reducer and verifies the expected event names and selected final-state paths.

Run them with `bun test tests/golden/`. Add a fixture whenever a policy or lifecycle change has a stable state transition worth protecting. Keep fixtures free of model I/O, wall-clock values, files, and TUI rendering.
