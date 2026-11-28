---
description: "Enable the Artifork software factory from the Plugins page: isolated self-replicating clones with the autonomous mutation loop, coaching observers, live preview, and the catalog with publish decisions."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-factory-bundle

English | [中文](README.zh.md)

## Summary

The composition of the Artifork software factory: one bundle that mounts the four factory packages as ordinary Host rows, so the factory tools join the global tool layer every preset receives. `spawn_and_mutate` clones this checkout into an isolated directory that mutates itself into a target application through the autonomous mutation loop with git checkpoints and three-strike rollback; the coaching observers watch the loop and may pause it; the live preview serves the clone's own app on its reserved port for the human and the agent; and the catalog records every completed application with its publish decision. Inside a mutation clone the same rows load the clone side: role gating in each package reads the checkout's spawn record and mounts the loop, preview, and coaching tools the clone needs to work on itself.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Open Plugins and enable Artifork software factory in the Official group; shipped profiles leave it disabled. The switch loads the four factory rows for live Agents immediately, and removing the selection retires them. A spawned clone does not need the switch: the factory's spawn prepares the clone's own web profile with this bundle already selected, so a clone boots with its mutation loop, preview, and coaching tools from the first start. The factory tools are model-facing; a session's agent calls `spawn_and_mutate` only when the human explicitly asks to spawn, replicate, or transform the factory itself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The bundle patch inserts one Host row per factory package. Each package registers its tools into the global tool layer, so every preset — standard, ptc, cordis, minimal — receives them without preset edits; switching the bundle registers or removes the tools for live Agents. Role gating is per checkout, not per row: each package's `apply` reads the spawn record and mounts the mother's or the clone's tool set, so one bundle carries both sides. The spawn-side profile preparation writes the clone's profile manifest (`dsh.profile.bundles` = the shipped web template plus this bundle) before the clone's first boot, so `initProfile`'s never-touch rule preserves the selection.

</details>

-----

<a id="model-experience"></a>
## Model Experience

The model sees the factory policy sections in its system prompt (spawn policy, rehearsal policy, catalog policy, coaching directives) and the factory tools in its catalog, subject to the checkout's role. The human sees the same factory from the Plugins page switch, the `/factory/catalog` overview, and the clone's live preview link.

#### KV Cache effect

The factory sections add fixed prompt bytes per session while the bundle is enabled; the clone side adds the loop and coaching sections on top.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The factory packages are experimental; the bundle follows the shipped-optional-bundle policy and stays out of the default product composition.
- A spawned clone needs its dependencies installed (`pnpm install` inside the clone) before its own `dsh web` can boot; the spawn records the reserved port but does not install.
