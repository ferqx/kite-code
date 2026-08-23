# Agent Kernel

Private deterministic Kernel boundary and production Runtime State transition
owner through `decide`, `reduceAgentState`, `reduce`, and
`selectPendingEffects`. Host projects canonical `DecisionFacts` and supplies
allocated identities; the package cannot read clocks, allocate IDs, persist
state, or execute effects. Reducer order is compiled from the static domain
modules under `src/core` and `src/domains`; there is no public dynamic reducer
registration or caller-supplied reducer injection surface.
