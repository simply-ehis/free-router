import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/worker.mjs" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "free-router",
		compatibilityDate: "2026-10-06",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		env: {
			// Non-secret config JSON (selection, security, provider enable flags).
			// Secrets are set via `cf secret put` — never in this file. Provider
			// keys live in the KV-encrypted credential envelope, not here.
			CONFIG: bindings.text("{}"),
			GATEWAY_KEY: bindings.secret(),
			COMPAT_CREDENTIALS_KEY: bindings.secret(),
			// Catalog cache + audit log + runtime config persistence.
			DATA: bindings.kv({ id: "be5bfb543ba24fc791b778bf1d418c94" }),
		},
		triggers: [
			// Catalog refresh + probe revive/warm. Isolates can be evicted
			// between ticks, so the cron is the real scheduler here.
			triggers.scheduled({ schedule: "*/2 * * * *" }),
		],
	},
});
