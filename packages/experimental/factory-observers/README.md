---
description: "The model-facing coach_propose, coach_observe, coach_pause, and coach_resume tools: a deterministic directive channel between three coach observers and the mutation agent, for users and maintainers configuring supervised mutation runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory-observers

English | [中文](README.zh.md)

## Summary

This package is the coaching layer of the agentic software factory: three read-only coach observers (the process coach, the intent coach, and the skill master) steer a running mutation clone through a deterministic filesystem channel instead of executing anything themselves. A coach submits an evidence-cited directive with `coach_propose`; the newest proposal on a topic supersedes older ones with a monotonic sequence, and the governed directive section is recomposed at every prompt assembly under a character budget, so advice reaches the mutation agent only at round boundaries and never mid-attempt. The skill master is the only observer allowed to stop the loop: `coach_pause` writes the `.coaches/PAUSE` flag that the rounds driver honors before the next round, with milestone state preserved, and `coach_resume` clears it. All mechanics are pure file operations; no model judgment lives in this package.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Register the package as a plugin inside a mutation clone and it contributes the `coach_propose`, `coach_observe`, `coach_pause`, and `coach_resume` tools plus two system-prompt sections: a static policy section describing the three coaches and their limits, and a dynamic directives section recomposed from the channel at every prompt assembly. The plugin accepts two config keys: `repositoryPath`, the clone the coaches observe (default the process working directory, empty refused), and `maxSectionChars`, the character budget of the governed section (default 2048, must be a positive safe integer).

`coach_propose` takes `coach` (one of `process`, `intent`, `skills`), `topic` (a lowercase kebab slug of at most 40 characters), `evidence` (observable fact the directive is based on), and `directive` (boundary-scoped advice); the saved proposal is returned with its assigned sequence. `coach_observe` takes no arguments and reports the pause state with its reason, how many directives are governed, how many were dropped by the budget, and the directive lines in priority order. `coach_pause` and `coach_resume` require the `skills` identity; the other coaches are refused with a specific message. A pause needs a non-empty reason, which is stored in the flag file.

## Understand the implementation

The channel lives under `.coaches/` in the clone: one JSON file per coach and topic under `.coaches/proposals/<coach>/<topic>.json`, holding `seq`, `evidence`, and `directive`. Saving validates the proposal (coach identity, kebab topic, non-empty evidence and directive), reads the previous sequence from the same file, and writes the new one, so supersede order is durable and observable; a malformed existing file restarts the sequence at 1. Reading the channel never fails the loop: unknown coach directories, non-JSON files, malformed JSON, wrong-shaped fields, unreadable files, and topics that fail validation are all skipped. `composeDirectives` sorts by coach priority (process, intent, skills) then topic, renders each directive as one evidence-cited line, and drops whole lines beyond the size budget instead of truncating mid-line; the drop count is reported so nothing disappears silently. The dynamic section uses the same composition through a synchronous, fail-soft channel read, in the same spirit as the skill-filesystem provider, because prompt assembly is synchronous. The pause flag is `.coaches/PAUSE` with the reason as its content; the factory's rounds driver checks it before every round.

## Model Experience

The model sees the three coaches described in the policy section, its own governed directives at the top of each assembly, and four tools: submit a directive, inspect the channel, and — skill master only — pause or resume the loop. Every directive must cite observable evidence, which the validation enforces mechanically; malformed arguments are rejected with specific messages before any filesystem work. Renders state when a directive takes effect (the next round boundary), what is currently governed, and what a pause does to milestone state.

## Known Limitations and Deferred Work

The coaches are currently a protocol, not running subagents: nothing in this package launches them, so today a human, the mutation agent itself in a coaching role, or an external process submits proposals through the tools. Mounting the three coaches as real subagents over the harness's `SubagentProvider` seam is the next step. The governed section is applied only at round boundaries by convention (the rounds driver pauses between rounds); nothing here can interrupt a running attempt. Directives are advisory: the channel cannot force the mutation agent to obey, only make the advice and its evidence visible at every assembly.
