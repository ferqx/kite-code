# Shell Tools

`shell.test.ts` tests pure registration and cancellation-result wording with explicit structural contexts; it does not qualify SQLite authority or process cleanup. Actual default resolver, SDK, SQLite, dispatch ordering, output cursor, guardian assets, macOS process-group stop and original-command replay checks live in `apps/service/test/isolated/shell-configuration.test.ts`. Existing `jobs/shell.test.ts` and root `shell-service.test.ts` remain the supervision and paired lifecycle qualification owners.
