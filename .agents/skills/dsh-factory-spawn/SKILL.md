---
name: dsh-factory-spawn
description: Spawn an isolated clone of the Artifork factory for a mutation run — clone the checkout, isolate home/port/database, compose the mutation profile, write the goal, and prove the clone boots. Use when starting a self-replication run.
---

# Spawning a mutation clone

The factory never mutates itself. This skill is the mechanical half of that invariant; the goal contract lives in [dsh-factory-mutation-goal](../dsh-factory-mutation-goal/SKILL.md) and the run protocol in [dsh-factory-mutation-loop](../dsh-factory-mutation-loop/SKILL.md). Architecture rationale: [agentic software factory note](../../notes/proposed/architecture/2026-11-27-agentic-software-factory.md).

## Preconditions (all must hold before spawning)

- The mother checkout is clean (`git status` empty) and its base commit's tests are green, so the clone starts from a known-good tree.
- A complete, user-confirmed `MUTATION_GOAL.md` content exists (authored per the goal skill). Underdetermined goals do not spawn.
- The target directory does not exist, and its path is outside the mother's tree.

## Spawn procedure

1. **Clone**: `git clone --no-hardlinks <mother-path> <target>` and `cd <target>`; the clone shares objects, not state. Then cut its history loose so the mutation run has its own line: the clone keeps its initial commit as the rollback baseline and records the mother's commit it came from in `MUTATION_SPAWN.json` (source commit, timestamp, goal hash).
2. **Isolate** every shared resource:
   - `DSH_HOME` — a fresh home directory per clone (state, sessions, credentials live here, never in the mother's home).
   - Server port — assign a free port distinct from the mother's and other clones; record it in `MUTATION_SPAWN.json`.
   - Database — the clone's configured storage backend must point at its own home; verify by listing its data directory after first boot.
3. **Write the goal**: place `MUTATION_GOAL.md` at the clone root and copy user-provided references into `references/`.
4. **Compose the mutation profile**: generate a profile patch in the `cordis.patch.yml` shape (see [ralph-bundle's example](../../../packages/experimental/ralph-bundle/cordis.patch.yml)) that mounts what the target application needs. Version 1 clones the whole monorepo and composes the *running surface* by patch; do not delete packages — pruning is deferred until spawn and loop are proven. The patch registers the factory bundle (mutation loop, verification harness) plus the goal's declared plugin set.
5. **Install and boot-proof**: `pnpm install --frozen-lockfile`, then prove the clone boots headless on its assigned port with its own home before any mutation. A clone that cannot boot its base state can never verify its first milestone.
6. **First commit**: commit goal, references, spawn record, and profile patch as the baseline commit the loop's rollback targets.

## Invariants

- The mother's tree is byte-identical before and after every spawn (`git status` in the mother after the run must be empty).
- The clone's agent never writes outside the clone root; paths recorded in `MUTATION_SPAWN.json` are the boundary the loop enforces.
- One clone, one goal, one home, one port — a second goal for the same domain spawns a new clone instead of reopening a finished or failed one.
- Credentials stay in the clone's own home; never copy the mother's credentials into a clone that will run unattended unless the goal requires model access, and then scope them to what the run needs.
