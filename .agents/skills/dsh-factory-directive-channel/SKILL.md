---
name: dsh-factory-directive-channel
description: The coach channel and governor rules, how factory coach findings become one size-capped evidence-backed directive section applied only at round boundaries.
---

# Factory directive channel

Coaches write, a deterministic governor merges, the loop consumes. Three roles, one channel, no exceptions.

## Layout

Coaches write proposal files inside the clone's coach channel directory (`.coaches/` by convention). One proposal per finding, each containing: the coach name, the target topic (a short stable slug such as `verification-gates` or `piano-roll-ux`), the cited evidence (commands, exit codes, log lines, or user messages), the proposed directive text, and the creation time. A `PAUSE` flag file in the same directory is reserved for the skill master.

## Governor rules

The governor is deterministic code, not a model. It runs at round boundaries and before a round starts (which is where the pause flag is honored):

1. Merge proposals by topic; a newer proposal on the same topic supersedes the older one entirely. Topics never accumulate.
2. Keep only directives relevant to the current phase (from the mutation goal's milestone order); evict the rest, oldest first, under a hard size cap of roughly two kilobytes.
3. Reject any proposal whose evidence section is empty: a directive without cited evidence does not pass.
4. Compose the winning directives into the dynamic system-prompt directive section that the next fresh round agent receives. All accepted and rejected proposals remain visible in the trajectory; model-visible implies logged.
5. When a run ends, hand the validated directive history to the skill distillation step so durable lessons become factory skills rather than dying with the clone.

## Failure rules

- If the channel is unwritable or the section cannot be updated, the loop continues without new directives and the failure is logged; a coach outage never stops a healthy loop.
- The governor never invents directives, never reorders milestones, and never edits the goal file.
