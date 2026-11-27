---
description: "The model-facing spawn_and_mutate and mutation_checkpoint tools: replicate this checkout into an isolated clone that mutates itself toward a mutation goal, for users and maintainers configuring self-replication."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory

English | [中文](README.zh.md)

## Summary

`spawn_and_mutate` replicates the running checkout into a fresh isolated directory and hands that clone a mutation goal. The mother checkout is only read: it must be a clean git work tree, and nothing inside it is written. The clone receives its own git history (the `origin` remote is removed), its own `.mutation-home` state directory excluded from git, and a reserved localhost port, so a spawned clone never collides with its mother. `mutation_checkpoint` is the clone-side verification autopilot: it runs the executable acceptance criteria of the current milestone against the clone, commits and advances on green, counts strikes on red, and rolls the clone back to its last green commit on the third consecutive failure. `mutation_run` is the rounds driver: it calls the checkpoint back to back until the goal reports complete, a coach pause flag (`.coaches/PAUSE`) appears, or the round budget runs out. The tools register only when the human explicitly asks to spawn, replicate, or transform the factory itself.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Register the package as a plugin and it contributes the `spawn_and_mutate`, `mutation_checkpoint`, and `mutation_run` tools plus system-prompt sections stating the explicit-ask policy and the checkpoint discipline: never claim a milestone is green without a checkpoint report, and never commit mutation work outside the checkpoint. The plugin accepts one config key: `repositoryPath`, the checkout the tools operate on; it defaults to the process working directory, and an empty value is refused. In a mother checkout it is the source to replicate; inside a clone it is the clone itself.

Calling `spawn_and_mutate` requires a non-empty `goalMarkdown` document (the content written to `MUTATION_GOAL.md` in the clone), a `targetPath` directory that must not exist, and an optional `referencePaths` array of files copied verbatim into the clone's `references/` directory. It returns the clone path, the mother commit it was cut from, the reserved port, the clone-relative home directory, and the SHA-256 of the goal file. `mutation_checkpoint` takes no arguments and runs against the configured checkout; it returns the milestone, its title, the outcome (`committed`, `failed`, `rolled-back`, or `complete`), the attempt count, the last green commit, the per-gate results, and a detail line. `mutation_run` takes an optional positive-integer `maxRounds` (default 64) and returns how many checkpoints ran, why the run stopped (`complete`, `paused`, or `max-rounds`), and the last checkpoint's decision.

## Understand the implementation

Spawning is a strict sequence of fail-loud steps: prove the mother is a clean checkout, prove the target does not exist, `git clone --no-hardlinks`, cut the remote, reserve a free localhost port, create the `.mutation-home` directory, write the trimmed goal with a trailing newline, copy references, hash the goal, write `MUTATION_SPAWN.json`, exclude `.mutation-home/` from the clone's git status, and commit everything as the `Spawn mutation baseline` commit with the deterministic `Artifork Factory` identity. Every git failure is wrapped with the command and working directory so autonomous callers can diagnose without a shell. The spawn record pins `version`, `sourceCommit`, `createdAt`, `goalSha256`, `homePath`, and `port` so a clone can always report where it came from and how it is isolated.

The checkpoint parses the goal file into milestones and executable acceptance criteria (each criterion is a shell command plus an expectation), loads the loop state from `.mutation-home/loop-state.json`, and runs the current milestone's gates in order; the first red gate ends the attempt. On green it commits as `Mutation: M<n> <title>` and advances to the next milestone (or reports `complete` when the last milestone is green). On red it counts the strike; on the third consecutive failure it runs `git reset --hard` to the last green commit, appends the failed approach with gate evidence to `mutation-log.md`, and clears the strike count so the next round must take a different approach. The checkpoint hardens the loop against its known failure modes: the goal is frozen (the spawn record pins the goal's SHA-256 and a mutated goal is refused), each gate has a wall-clock kill so a watch-mode command becomes a red gate with exit code 124 instead of hanging the loop, every gate's full output is logged under `.mutation-home/gates/`, a green-but-empty work tree counts as a failed strike instead of a silent commit, and the rollback also removes untracked debris (`git clean -fd`) so a dead approach cannot leak into the next one. Loop state, gate logs, and the failure log live inside `.mutation-home/` and stay excluded from git.

## Model Experience

The model sees `spawn_and_mutate` restricted to explicit human requests to spawn, replicate, or transform the factory, and `mutation_checkpoint` as the only sanctioned way to verify and commit milestone work. Arguments of `spawn_and_mutate` are `goalMarkdown` (required string), `targetPath` (required string), and `referencePaths` (optional array of strings); malformed arguments are rejected with specific messages before any filesystem work. Both tools render their result as one text block; the structured output schemas expose the spawn record and checkpoint report fields for programmatic consumers.

## Known Limitations and Deferred Work

The rounds driver sequences checkpoints but does not supervise quality: the coaching layer (observers, directives, and the pause flag) is a separate plugin whose sensors are the gate logs and failure log this package already writes. The goal document's authoring format is defined by the factory skills rather than enforced beyond the structural parse. Port reservation has an inherent probe-to-use window; the clone's launcher owns the retry.
