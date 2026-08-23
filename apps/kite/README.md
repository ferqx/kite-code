# Kite App

Target application and sole concrete composition root. It wires the Kernel,
Host, Builtin Runtime, SQLite storage, CLI, and TUI adapters without exporting a
second concrete runtime assembly path. Runtime session coordination lives under
`src/runtime`; presentation-specific adapters live under `src/adapters`.
