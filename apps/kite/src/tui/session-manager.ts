/** App-local presentation facade injected by the single bootstrap root. */
// biome-ignore lint/suspicious/noExplicitAny: temporary structural bridge removed with the RM App execution adapter.
export type SessionManager = any;

// biome-ignore lint/suspicious/noExplicitAny: dependency shape remains bootstrap-private during the RM compatibility stage.
export type TuiSessionManagerFactory = (dependencies: Record<string, any>) => SessionManager;
