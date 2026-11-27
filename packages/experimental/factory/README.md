---
description: "The model-facing spawn_and_mutate tool: replicate this checkout into an isolated clone that mutates itself toward a mutation goal, for users and maintainers configuring self-replication."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory

English | [中文](README.zh.md)

## Summary

`spawn_and_mutate` replicates the running checkout into a fresh isolated directory and hands that clone a mutation goal. The mother checkout is only read: it must be a clean git work tree, and nothing inside it is written. The clone receives its own git history (the `origin` remote is removed), its own `.mutation-home` state directory excluded from git, and a reserved localhost port, so a spawned clone never collides with its mother. The tool registers only when the human explicitly asks to spawn, replicate, or transform the factory itself; the autonomous loop that works inside a clone is a separate deployment capability and is not started by spawning.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Register the package as a plugin and it contributes the `spawn_and_mutate` tool plus a system-prompt section stating the explicit-ask policy. The plugin accepts one config key: `repositoryPath`, the mother checkout to replicate; it defaults to the process working directory, and an empty value is refused.

Calling the tool requires a non-empty `goalMarkdown` document (the content written to `MUTATION_GOAL.md` in the clone), a `targetPath` directory that must not exist, and an optional `referencePaths` array of files copied verbatim into the clone's `references/` directory. The tool returns the clone path, the mother commit it was cut from, the reserved port, the clone-relative home directory, and the SHA-256 of the goal file.

## Understand the implementation

Spawning is a strict sequence of fail-loud steps: prove the mother is a clean checkout, prove the target does not exist, `git clone --no-hardlinks`, cut the remote, reserve a free localhost port, create the `.mutation-home` directory, write the trimmed goal with a trailing newline, copy references, hash the goal, write `MUTATION_SPAWN.json`, exclude `.mutation-home/` from the clone's git status, and commit everything as the `Spawn mutation baseline` commit with the deterministic `Artifork Factory` identity. Every git failure is wrapped with the command and working directory so autonomous callers can diagnose without a shell. The spawn record pins `version`, `sourceCommit`, `createdAt`, `goalSha256`, `homePath`, and `port` so a clone can always report where it came from and how it is isolated.

## Model Experience

The model sees a single `spawn_and_mutate` tool whose description and system-prompt section both restrict it to explicit human requests to spawn, replicate, or transform the factory. Arguments are `goalMarkdown` (required string), `targetPath` (required string), and `referencePaths` (optional array of strings); malformed arguments are rejected with specific messages before any filesystem work. The result renders as one text block summarizing the clone path, source commit, port, home directory, and goal hash; the structured output schema exposes the same five fields for programmatic consumers.

## Known Limitations and Deferred Work

Spawning does not start any mutation loop: the clone is a prepared, isolated checkout with a goal, and driving it (rounds, build/test gates, git rollback) is future work mounted by a factory bundle. The goal document's semantics are defined by the factory skills rather than enforced here. Port reservation has an inherent probe-to-use window; the clone's launcher owns the retry.
