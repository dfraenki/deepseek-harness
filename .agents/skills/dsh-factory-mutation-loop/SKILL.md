---
name: dsh-factory-mutation-loop
description: Run the autonomous mutation loop inside a spawned clone — milestone rounds, real build/typecheck/test/boot verification on the live preview instance, automatic commits, and the three-strike git reset rule. Use when executing or reviewing a self-replication run.
---

# Running the mutation loop

The loop transforms a spawned clone until every acceptance criterion in `MUTATION_GOAL.md` passes, without per-step human confirmation. It mounts on the existing fresh-agent machinery ([tool-ralph](../../../packages/experimental/tool-ralph/README.md): immutable objective, fresh agent per round, bounded structured handoff, workspace as the only cross-round memory); this skill defines the loop's verification and git rules. Spawn mechanics: [dsh-factory-spawn](../dsh-factory-spawn/SKILL.md); goal authoring: [dsh-factory-mutation-goal](../dsh-factory-mutation-goal/SKILL.md); the shared preview instance: [dsh-factory-live-preview](../dsh-factory-live-preview/SKILL.md).

## Round protocol

Each round is one fresh agent whose visible context is exactly: the immutable goal file, its round number and budget, the previous bounded handoff, and the workspace. The round:

1. **Reads state**: the handoff (current milestone, verification status, prior failed approach if any) plus `references/analysis/` when the milestone is design-relevant.
2. **Implements the current milestone** as plugins, following [dsh-factory-plugin-forge](../dsh-factory-plugin-forge/SKILL.md). A round never spans milestones; a milestone that does not fit one round is split in the goal file, not improvised.
3. **Runs the gates itself** (next section) and reports the exact commands and exit codes in its handoff — a handoff claiming success without a recorded gate run is invalid and the round repeats.
4. **Returns a bounded report**: status (`continue` / `complete` / `blocked`), what landed, gate evidence, next step.

## Verification gates (all must pass for a milestone to be green)

Run them in order; the first red gate ends the attempt:

- **Build**: the clone's library build (`pnpm run build:lib` scope or the milestone's narrower build target).
- **Typecheck**: full client typecheck plus the touched host projects (`tsc -b <project>`).
- **Tests**: the touched packages' test suites, plus any acceptance-criteria test patterns named in the goal file.
- **Preview boot smoke**: the clone's web app on its preview instance (per [dsh-factory-live-preview](../dsh-factory-live-preview/SKILL.md)) boots and the console stays free of errors. A milestone that changes UI must additionally exercise its surface: the agent drives the same preview instance through its browser-use session and the acceptance criterion's UI assertion passes. The user may be watching this exact instance while it is being verified — a green milestone is one that survived being used, not one whose author claimed it works.
- **Goal criteria**: every acceptance criterion the goal file marks for this milestone runs and passes.

## Ground rules from the first real run

A live smoke run of the loop surfaced rules the gates alone do not teach:

- **The clone is ESM**: the harness package declares `"type": "module"`, so milestone code must use `import`/`export`, never `require` — a CommonJS gate file fails with `require is not defined in ES module scope`.
- **Gate files must be tracked**: the repo-wide `.gitignore` excludes `lib/`, `dist/`, and build outputs; an acceptance gate that lives under an ignored path passes while leaving the work tree empty, and the checkpoint then refuses to commit ("green but no changes"). Put milestone code and its gates under tracked paths (for example `engine/`, `cli/`, or a new package directory).
- **Gates are plain commands on PATH**: they run in the clone root with the clone's own environment; prefer a single `node <file>.test.js` per criterion so the gate log names exactly one failure.
- **The mother never hosts milestone code**: it is only read; everything a milestone produces lands inside the clone and is committed only by the checkpoint.

## Git autopilot

- **Commit on green**: when a milestone's gates pass, the loop commits automatically with a message naming the milestone. Never mix a green milestone with unverified work in one commit.
- **Three-strike rollback**: after 3 consecutive failed gate attempts on the same milestone, run `git reset --hard` to the last green commit, record the failed approach and its failure evidence in the workspace (`mutation-log.md`, referenced by the handoff), and let the next round take a different approach. The third failure's evidence must state what was tried and why it cannot be iterated further — not just the error text.
- **Baseline protection**: the clone's initial commit (spawn baseline) is never rewritten; rollback always targets a green commit.
- **Stop conditions**: the run ends `complete` when every acceptance criterion in the goal file has passed on its recorded gate run; `blocked` when a milestone fails three approaches and the goal cannot be re-scoped without the user; `budget-limited` when the round budget is exhausted. A blocked or budget-limited run leaves the clone on its last green commit with the log explaining what remains.

## Observability and control

- Every round, gate result, commit, and rollback is model-visible (logged) — a run that cannot be audited from its logs did not happen.
- The mother factory observes progress through the clone's goal-tool state and its git log; it never edits inside a running clone.
- The user watches the transformation live on the preview instance and can interrupt with feedback; user feedback mid-run amends the goal only through an explicit goal-revision (the loop pauses, the goal file is updated and re-confirmed, the run resumes) — never as silent scope drift.
- A run may be stopped at any round boundary; restart resumes from the last handoff and green commit, never from scratch.
