---
name: dsh-factory-rehearsal
description: Rehearse a capability before spawning — try candidate approaches with real gate evidence, distill green attempts into skills, and gate the spawn on milestone coverage. Use when deciding how a capability should be built before a mutation run.
---

# Rehearsal before mutation

Spawning starts a run that will not stop to ask. Whatever approach the clone's loop commits to, it inherits from the mother's knowledge. The rehearsal layer makes that knowledge earned instead of guessed: candidate approaches are tried against this checkout, every attempt is recorded with real gate evidence, and only validated approaches are carried into the clone — as goals, and as skills the clone's agent can read.

## The three tools

All state lives under `.rehearsal-home/` (git-excluded in any checkout that uses the layer).

- `rehearsal_attempt` — run one candidate approach on a topic. Arguments: `topic` (kebab slug, ≤40 chars), `approach` (label of the way being tried), `hypothesis` (what this attempt set out to prove), optional `milestone` (which goal milestone it serves), and `gates` (shell commands run in order; the first failure ends the attempt). Each attempt is recorded under `.rehearsal-home/attempts/<topic>/<seq>.json` with per-gate exit codes, verdict, and timestamp. Do the experiments inside a scratch directory (for example `.rehearsal-home/scratch/<topic>/`) so the mother stays clean.
- `rehearsal_distill` — turn a green attempt into a skill candidate at `.rehearsal-home/skills/<topic>.md`, with frontmatter naming the skill and citing the green attempt's sequence. A later distillation for the same topic supersedes the earlier one; only green attempts can be distilled.
- `rehearsal_report` — per-topic coverage: attempts, verdicts, stuck flags, distilled skills. Read it before proposing a spawn.

## The two guardrails

- **Budget**: a topic allows at most 6 attempts. The error names `rehearsal_distill` and the coaching channel as the escape routes — an exhausted budget means the mother does not understand the capability well enough to spend more attempts blindly.
- **Stuck rule**: after 3 consecutive red attempts on the same approach the topic is stuck. Redoing the same way a fourth time is refused before any gate runs. Change the approach, or escalate to the coaching channel ([dsh-factory-coach-skills](../dsh-factory-coach-skills/SKILL.md)) whose skill master can pause and reconfigure.

## Gating the spawn

`spawn_and_mutate` accepts `requireRehearsalCoverage: true`. When set, the spawn refuses until every milestone of the goal document has a green rehearsal attempt, naming the uncovered milestones. Use it whenever the human expects a rehearsed run; a spawn without it may still carry whatever skills were distilled.

Every spawn copies distilled candidates into the clone's `.agents/skills/` directory, one directory per frontmatter name — the clone's agent gets the mother's earned knowledge as first-class skills, and a failed candidate file never blocks the spawn.

## Rules

- Gates are real commands with real exit codes; an attempt without a green gate can never be distilled, and a red gate is evidence, not noise — the failure detail names the exact command and exit code.
- Never commit rehearsal records: they are git-excluded by design so a checkpoint never mistakes rehearsal state for milestone work.
- Rehearsal proves an approach works; it does not guarantee the clone's run. The clone still verifies every milestone with its own gates ([dsh-factory-mutation-loop](../dsh-factory-mutation-loop/SKILL.md)).
