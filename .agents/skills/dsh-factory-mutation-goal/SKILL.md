---
name: dsh-factory-mutation-goal
description: Author a MUTATION_GOAL.md that turns a natural-language transformation brief plus visual references (screenshots, mockups, competitor apps) into an executable, verifiable mutation contract for a spawned Artifork clone. Use when preparing a self-replication run of the agentic software factory.
---

# Authoring a mutation goal

This skill is the authoring standard for `MUTATION_GOAL.md` — the immutable objective a spawned clone works toward. It complements the factory architecture note [`.agents/notes/proposed/architecture/2026-11-27-agentic-software-factory.md`](../../notes/proposed/architecture/2026-11-27-agentic-software-factory.md); spawn mechanics live in [dsh-factory-spawn](../dsh-factory-spawn/SKILL.md) and the run protocol in [dsh-factory-mutation-loop](../dsh-factory-mutation-loop/SKILL.md).

## The contract a goal must satisfy

The goal file is read by fresh agents with no prior conversation, so it must be self-contained, and it is parsed by the loop's verifier, so its acceptance criteria must be executable. A goal that fails either test produces a run that stalls or drifts.

Write `MUTATION_GOAL.md` at the clone root with these sections, in order:

1. **Identity** — target application name, tagline, brand direction (voice, tone, visual direction), and the locales the application ships in. This section drives the clone's self-rebrand and must name the mark concept, not embed binary assets.
2. **Domain** — one paragraph stating what the application is, for whom, and what "intuitive" concretely means for its users (the three interactions that must feel effortless).
3. **Experience narrative** — the walkthrough a first-time user performs, end to end, written as observable UI behavior ("open the app → a browser of kits appears → dragging a sample onto the sequencer creates a track"). Every later feature and milestone traces back to a step here.
4. **Features** — the complete feature list. Each entry names its future plugin (singular responsibility, plugin-sized), its user-visible surface, and its agent-facing tool if the feature should be automatable. A feature that cannot be named as one plugin is two features.
5. **Milestones** — an ordered list where each milestone is small enough to implement and verify in one to a few rounds, compiles on its own, and leaves the application bootable. Order by dependency: engine capabilities before surfaces that consume them.
6. **Acceptance criteria** — every criterion is a check the verifier can actually run: a command plus its expected outcome (build, typecheck, targeted test pattern, headless boot smoke with an expected console-free launch, or a UI assertion script). "Works well" is not an acceptance criterion; "the sequencer renders 16 steps and toggling step 3 changes the pattern state" is.
7. **References** — pointers into `references/` with what each reference contributes (layout, interaction pattern, visual tokens, feature completeness bar).

## Ingesting references

Reference material lives in `references/` inside the clone: images verbatim, app analyses as Markdown. Ingestion happens in the run's early rounds, before milestone 1 starts:

- **Images (screenshots, mockups, moodboards).** The clone's agent analyzes each image with vision and writes `references/analysis/<name>.md` capturing: layout structure (regions, navigation, primary surfaces), the interaction patterns worth copying, visual tokens (palette, density, corner/radius language, typography weight), and a verdict on which parts apply to the goal's domain. Never let an image silently inform implementation — every design decision in a later round must be traceable to an analysis file or an explicit goal-file statement.
- **Competitor or reference applications named by the user.** Reduce each to its feature inventory and its UX differentiators in `references/analysis/<app>.md`, and mark which inventory entries the goal adopts, adapts, or rejects. A rejected differentiator is as valuable as an adopted one — it bounds scope.
- **Incomplete references.** If the user's brief is underdetermined (no visual direction, ambiguous scope), the goal authoring stage must resolve it with the user before spawn, not leave the clone to guess. The goal file is immutable once the run starts; ambiguity inside it multiplies across rounds.

## Common failure modes

- **Milestones as epics.** "Build the sequencer" spans many rounds and never reaches green. Split until each milestone has one verifiable acceptance check and an estimated one-round scope.
- **Acceptance criteria without commands.** If the verifier cannot run it, it is a wish, not a criterion — either name the command or move the statement into the experience narrative.
- **References analyzed during implementation.** Analysis that happens mid-milestone smuggles unreviewed scope into the run; all ingestion belongs to the goal stage or explicitly planned analysis rounds.
- **Identity as an afterthought.** The clone rebrands itself in milestone 1, not last; every later screenshot, test, and locale string then lands in the target identity instead of needing a mechanical rewrite pass.
