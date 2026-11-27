---
description: "The model-facing preview_start, preview_status, preview_stop, and preview_probe tools: one shared live instance of the mutation clone's app, watched by the user and probed by the agent, for users and maintainers of supervised mutation runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory-preview

English | [中文](README.zh.md)

## Summary

This package is the shared-live-preview layer of the agentic software factory: inside a mutation clone it launches the clone's own web app on the port recorded at spawn, so the user in the factory UI and the mutation agent observe and test the exact same running instance. `preview_start` is idempotent — it launches the app when nothing is serving and reuses the live process otherwise — while `preview_status`, `preview_stop`, and `preview_probe` report, stop, and HTTP-probe that one origin. A preview that will not start or answer is a red gate: every failure carries the server log tail and a specific diagnosis instead of a silent fallback. All mechanics are process and file operations; no model judgment lives in this package.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Register the package as a plugin inside a mutation clone and it contributes the four preview tools plus one static policy section describing the shared-instance rule. The plugin accepts four config keys: `repositoryPath`, the clone whose preview is managed (default the process working directory, empty refused), `command` and `args`, an optional launcher override (default the clone's own `node_modules/.bin/dsh web --port`), and `startTimeoutMs`, the startup budget in milliseconds (default 120000, must be a positive safe integer).

All four tools refuse to operate outside a spawned mutation clone: without a `MUTATION_SPAWN.json` in the repository path they fail with a specific message. `preview_start` and `preview_status` take no arguments; `preview_probe` takes an optional `path` (default `/`) and reports the HTTP status, content type, and a body excerpt; `preview_stop` stops the recorded process, first politely and then forcefully, and preserves milestone state — `preview_start` relaunches on the same reserved port.

## Understand the implementation

State lives under `.mutation-home/preview/` in the clone: `state.json` records `running`, `pid`, `port`, `startedAt`, and `command`, and `server.log` accumulates the app's stdout and stderr plus lifecycle lines. Before anything, the spawn record is read for the reserved port and a stale state whose process is gone is settled to stopped. Launching spawns the clone's app with `DSH_HOME` pointed at the clone's mutation home, and a missing process id or a startup failure — abort, spawn error, early exit, or no answer within the budget — abandons the launch: the child is killed, the reason and log tail are recorded, the state is written stopped, and a diagnostic error is thrown. Probing issues one real request to `http://127.0.0.1:<port>` with a short timeout and honors an abort signal. Log writes are fail-soft so a broken log can never crash a launch.

## Model Experience

The model sees the shared-instance policy in its system prompt: one preview instance, the same origin the user watches, probes as verification evidence, tests that must clean up after themselves, and the refusal to point the preview at the factory mother's origin. The tools render outcomes in plain text: launched at the shared URL or already serving, serving or not with a log tail, a stop that preserves milestone state, and a probe answer as `GET <url> → <status> (<type>); body starts: ...` — with a no-answer report steering the model back to `preview_start`.

## Known Limitations and Deferred Work

Verification is an HTTP probe, not a browser: console errors, rendering, and interaction are not observed yet; a browser-based probe and the factory-side client plugin for the user's sidebar are deferred work. The launcher defaults to the clone's own `dsh` binary, so clones whose app needs extra dependencies must have them installed before the first start — the diagnostic says so explicitly. State is single-instance: one preview process per clone, by design.
