---
name: dsh-factory-catalog
description: Record every completed application in the Artifork catalog and decide whether to publish it to a hosting provider or keep it catalog-only. Use when a mutation run finishes, or whenever the factory should report or publish its applications.
---

# The Artifork catalog and publish decisions

A development that ends silently is a development the factory cannot learn from. When a clone completes its mutation goal, the factory mother closes the loop: the application is recorded in the catalog derived from its own files and git history, and a publish decision is made with the human — publish to a hosting provider, or keep it catalog-only.

## Reading the catalog

`factory_catalog` takes no arguments and reports every spawned application under the configured apps directory:

- `complete` — clean tree whose history contains the final milestone's `Mutation:` commit; publish decisions are allowed.
- `in-progress` — dirty tree, or the final milestone's commit is missing; the loop state names the current milestone and last green commit.
- `paused` — a coach pause flag wins over everything else.

Directories without a spawn record are ignored; unreadable applications are reported as `SKIPPED (reason)`. Read the catalog before claiming anything about an application's state — never assert an app is finished or publishable without the catalog agreeing.

## Recording a publish decision

`factory_publish` takes an `appPath` and an optional `target` (default `catalog-only`; one of `catalog-only`, `cloudflare`, `hostinger`). It refuses to record a decision for anything but a complete application with a clean checkout, refuses a headless application on `cloudflare`, and commits everything it writes.

- `catalog-only` — the app stays in the catalog with a committed `PUBLISH_RECORD.json` and nothing else.
- `cloudflare` / `hostinger` — additionally writes a `PUBLISH_MANIFEST.md` with ready-to-run commands for the detected surface (`wrangler pages deploy` for a web app on Cloudflare, a VPS upload plus `dsh web` for Hostinger, the node-service recipe for headless apps) and a second commit.

## Rules

- The harness never stores cloud credentials: for hosting targets the manifest is the deliverable, and a human or a CI job with the secrets must run it. Say so explicitly when reporting a manifest-ready decision.
- Decide with the human. The catalog always records the app; hosting is a decision, not a default.
- Publishing after completion is safe by design: the completion check searches history for the final milestone commit instead of trusting HEAD, so publish commits never un-complete an application.
- Rehearse before spawning ([dsh-factory-rehearsal](../dsh-factory-rehearsal/SKILL.md)), run the mutation loop to completion ([dsh-factory-mutation-loop](../dsh-factory-mutation-loop/SKILL.md)), then close with the catalog.
