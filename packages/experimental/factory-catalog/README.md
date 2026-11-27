---
description: "The model-facing factory_catalog and factory_publish tools: the Artifork catalog of spawned applications derived from their own files and git history, plus committed publish decisions with ready-to-run hosting manifests, for users and maintainers of the software factory."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory-catalog

English | [中文](README.zh.md)

## Summary

This package is the catalog and publish-decision layer of the agentic software factory: after each completed development, the factory mother records the application in the Artifork catalog and decides whether to publish it to a hosting provider or keep it catalog-only. `factory_catalog` derives every spawned application's status, milestone progress, last green commit, and committed publish decision from the application's own files and git history — the catalog keeps no state of its own — while `factory_publish` verifies an application is complete, records the decision as a committed `PUBLISH_RECORD.json`, and, for hosting targets, writes a ready-to-run `PUBLISH_MANIFEST.md` that a human or CI job with the cloud credentials must execute. All mechanics are file, directory, and git operations; no model judgment lives in this package.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Register the package as a plugin in the factory mother and it contributes the two catalog tools plus one static policy section describing when to consult the catalog and how to record a decision. The plugin accepts two config keys: `repositoryPath`, the factory checkout the catalog serves (default the process working directory, empty refused), and `appsDir`, the directory whose subdirectories are spawned applications (default `apps`, relative to `repositoryPath`). The plugin is inert inside a mutation clone: a clone never catalogs or publishes itself, matching the role-gated registration of the factory package.

`factory_catalog` takes no arguments and reports every readable application under the apps directory; directories without a spawn record are silently ignored, and unreadable applications are reported as skipped with the reason. `factory_publish` requires an `appPath` and takes an optional `target` (default `catalog-only`; one of `catalog-only`, `cloudflare`, `hostinger`). Publishing refuses anything but a complete application with a clean checkout, refuses a headless application on the `cloudflare` target, and commits every file it writes.

## Understand the implementation

The catalog is derived state. For each spawned application it reads the goal's final milestone and derives the status in a fixed order: a coach pause flag wins (`paused`), then a dirty git tree means the loop is mid-attempt (`in-progress`), and only a clean tree whose history contains the final milestone's `Mutation:` commit counts as `complete` — publish commits after the final milestone keep the application complete because the check searches history instead of trusting HEAD. The milestone numbers come from the clone's committed loop state, and the deployable surface is detected from the application layout: an `apps/web` directory means `web`, anything else means `headless`. Publishing writes the record with the commit it was verified at, then, for hosting targets, a manifest with per-target command blocks (`wrangler pages deploy` for Cloudflare Pages, a VPS upload plus `dsh web` for Hostinger, and the node-service recipe for headless applications) and a note that the harness never stores cloud credentials; each write is its own commit with the deterministic factory identity.

## Model Experience

The model sees the catalog policy in its system prompt: consult `factory_catalog` after an application completes its mutation goal, decide with the human whether to publish to a hosting provider, record the decision with `factory_publish`, and never claim an application is publishable without the catalog reporting it complete. Both tools render outcomes in plain text: a catalog listing per application (`name: status, milestone M2/2, green at <commit>, publish manifest-ready (cloudflare)`, or `SKIPPED (reason)`), an explicit empty state, and publish confirmations that name the record path and, when present, the manifest path with the reminder that a human or CI job with the cloud credentials must run it.

## Known Limitations and Deferred Work

Publishing v1 records the decision and produces a ready-to-run manifest; executing a real deployment is deferred because the harness never stores cloud credentials — a human or a CI job with the secrets must run the manifest commands. The surface detection is a layout heuristic (`apps/web` versus headless), not a build check. The catalog reports applications at rest: a mutation run mid-attempt shows as `in-progress` with its loop state's last green commit, not a live feed.
