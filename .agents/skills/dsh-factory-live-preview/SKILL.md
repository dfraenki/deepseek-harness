---
name: dsh-factory-live-preview
description: Expose and verify the live preview of a mutating clone — one shared app instance the user watches in the mother's UI and the agent drives through its browser-use session. Use when setting up or using preview during a factory run.
---

# The shared live preview

A mutation run is watched, not just reported. The clone's application runs as one preview instance that both the user and the clone's agent see and act on: the user follows the transformation in real time and probes it directly; the agent's verification gates exercise the same instance. One instance, two observers, zero divergence between "what the user saw" and "what the agent tested".

## One instance, both observers

The clone's web profile runs on its isolated port (assigned at spawn, recorded in `MUTATION_SPAWN.json`). All preview consumers point at that one server:

- **User side.** The mother factory's client renders the preview in a dedicated surface — a right-sidebar tab embedding the clone's app in a frame, next to the factory conversation. It shows the run header (target identity, current milestone, gate status) above the embedded app, so the user always knows which milestone they are looking at. Setup belongs to a mother-side client plugin (a `ui-factory-preview` package filling an existing sidebar slot); it is a slot occupant like every other client capability, never a separate app.
- **Agent side.** The clone's agent attaches its browser-use session to the same origin: [browser-use-playwright-mcp](../../../packages/experimental/browser-use-playwright-mcp/README.md) or [browser-use-stagehand-native](../../../packages/experimental/browser-use-stagehand-native/README.md) navigate their Chromium to the preview URL and gain screenshots, element operations, and extraction against the real app. For console and network evidence during gate runs, [inspector](../../../packages/experimental/inspector/README.md) provides the DevTools-level view.
- **Shared server state.** Because both observers talk to the same server with the clone's own database, application state created by one side is visible to the other — a project the user starts in the preview is the project the agent's tests inspect. Verification that mutates state (creating documents, playing sequences) must clean up after itself or run against a disposable profile so the user's session is not trashed mid-watch.

## Real-time behavior during a run

- **Between gates (development mode):** the preview runs the clone's dev server with hot module replacement, so every file the loop writes updates the preview within seconds — the user literally watches the app take shape, including the broken intermediate states. The run header labels this state clearly ("milestone in progress — not verified").
- **At each gate:** the boot smoke and UI assertions run against a freshly built output, not the HMR stream, so a green verdict always reflects what a shipped build does. After a green verdict the preview switches to the verified build and the run header flips to "milestone green".
- **On rollback:** after a `git reset --hard` the preview rebuilds from the restored commit; the header explains the rollback and the approach being retried, so the user is never left staring at an unexplained regression.

## The MVP implementation (`factory-preview`)

The clone-side plugin `@deepseek-ai/dsh-experimental-factory-preview` owns the mechanics. It launches the clone's own `dsh web --port <port>` as a child process with `DSH_HOME` pointed at the clone's `.mutation-home`, so the app boots with the clone's home, database, and port, and never collides with the mother. Four tools:

- `preview_start` — idempotent launch: reads the spawn record for the reserved port, restarts if the recorded pid is dead, polls the origin until it answers HTTP (or the start budget expires), and returns the shared URL.
- `preview_status` — pid liveness plus a fresh HTTP probe, with the log tail.
- `preview_stop` — SIGTERM with a kill fallback after a short grace.
- `preview_probe` — one HTTP request against the same origin the user watches; this is how the agent tests the shared instance (browser-use sessions attach to the same URL for full interaction).

State and logs live under `.mutation-home/preview/` (`state.json`, `server.log`), already excluded from git, so a rollback never resurrects a stale process record. The command is plugin config (`command`/`args`), defaulting to the clone's `node_modules/.bin/dsh web --port <port>`; a clone without installed dependencies fails the start with that exact diagnosis.

## Rules

- The preview is read-and-probe for the user; the only writes to the clone's tree come from the loop. User feedback travels through the conversation and an explicit goal revision, never by editing clone files from the mother.
- The preview surface must never expose the mother factory's own origin, cookies, or credentials to the clone's app — the frame is cross-origin to the clone's port and carries no mother-side tokens; the clone is untrusted code by [SAFETY.md](../../../SAFETY.md)'s definition.
- A dead or hung preview instance is a red gate, not a rendering problem to hide: the loop reports it as a boot-smoke failure with the instance's logs.
