# Kite App

Target application and sole concrete composition root. It wires the Kernel,
Host, Builtin Runtime, SQLite storage, CLI, and TUI adapters without exporting a
second concrete runtime assembly path. Runtime session coordination lives under
`src/runtime/session`; Tool routing and durable receipt projection live under
`src/runtime/tool-execution` and `src/runtime/tool-persistence`.
Presentation-specific adapters live under `src/adapters`; TUI code consumes the
typed session adapter and never receives Kernel or storage authority.
