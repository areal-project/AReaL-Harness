// Local diagnostics only; no remote telemetry.
export const logger = { debug: (..._args: unknown[]) => {}, info: (..._args: unknown[]) => {}, warn: console.warn, error: console.error };
