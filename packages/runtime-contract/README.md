# Runtime Contract

Private, in-process client boundary for Kite Runtime. It exposes neutral
commands, queries, subscriptions, and presentation facts without importing App,
TUI, storage, provider, or concrete execution types. Commands, queries,
notifications, and projections have dedicated modules; `index.ts` only combines
the client-facing contract.
