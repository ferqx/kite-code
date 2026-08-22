# Agent Kernel

Private deterministic kernel boundary. RMV1-16 makes this package the
production State 25 transition owner through `decide`, `reduceAgentState`,
`reduce`, and `selectPendingEffects`. Host projects canonical `DecisionFacts`
and supplies allocated identities; the package cannot read clocks, allocate
IDs, persist state, or execute effects. The event table contains the fixed 136
current discriminants and the reducer order is compiled from the static
domain modules under `src/core` and `src/domains`. There is no public dynamic
reducer registration or caller-supplied reducer injection surface.
