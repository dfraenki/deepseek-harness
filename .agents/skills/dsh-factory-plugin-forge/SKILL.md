---
name: dsh-factory-plugin-forge
description: Create a first-class Cordis plugin package in this repository — package anatomy, tool and client faces, locale keys, tests under the coverage gate, bilingual README pair, and composition mounting. Use whenever a mutation milestone (or any feature) lands as a new plugin.
---

# Forging a plugin

Everything the mutation loop builds is a plugin, in the clone exactly as in the mother. This skill is the package anatomy and gate checklist; composition concepts live in composition concepts in the model-facing [cordis-composition-reference](../../../packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md) and [cordis-plugin-development](../../../packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md) skills, the repository rules in [AGENTS.md](../../../AGENTS.md). Study the nearest existing sibling before writing anything: a tool-only package ([tool-todo](../../../packages/todo/tool-todo/)), a client package ([ui-brand-official](../../../packages/client/ui-brand-official/)), and a two-face package in the target domain are the three shapes to copy from.

## Package anatomy

- **Location and naming**: packages live under a domain group directory (`packages/<group>/<package>/`); npm scope `@deepseek-ai/dsh-` plus the package name; ESM, TypeScript strict; `tsconfig.json` extending the group's shared config.
- **Two faces, one package** (when both are needed): the tool face registers agent-callable capabilities through composition effects; the client face registers UI into existing slots and holes. Both faces are mounted by the same package's composition entry, so a feature's agent tooling and its UI cannot drift apart.
- **Model-visible means logged**: anything the model can observe goes through the existing logging vocabulary, never bare `console` calls.
- **Locale keys**: user-visible strings live in the package's `locale/` files for every supported language; no hard-coded copy in components. Copy follows the locale-owned rule (see [dsh-client-ui-ux](../dsh-client-ui-ux/SKILL.md)).
- **Docs**: every package ships a bilingual README pair (`README.md`, `README.zh.md`, `README.i18n.yaml`) with the recorded consistency entry, re-recorded with `pnpm run verify-translation-pairing --write <pair>` after edits.

## Gates every new plugin must pass

- **Tests**: 100% coverage on the package's `src` is the repository gate — write the tests as the code lands, not after. Client specs use the existing client test setup; host specs the thread-safe one.
- **Typecheck**: the package's project builds under both the client and host aggregate configs it belongs to.
- **Lint**: `pnpm run lint` scope for the touched tree.
- **Pairing and docs gates**: README pair recorded and `doc-sync` green for the touched set.
- **Composition**: the plugin appears in the profile patch that mounts it (mutation profile in a clone, the relevant profile in the mother), switched off by default for experimental capabilities.

## In a mutation run specifically

- The clone's new packages follow the identical anatomy — the clone is a fork of this repository, so its gates are these gates; that is what makes the loop's verification real rather than theatrical.
- A milestone's plugin set is mounted by the mutation profile patch and only by it; the loop never edits shipped profiles of packages it does not own.
- Identity surfaces (mark, wordmark, titles, favicons) are part of milestone 1 per the goal skill's identity rule, reusing the primitives pattern of the Artifork rebrand (`ArtiforkMark` / `ArtiforkWordmark` in [ui-primitives](../../../packages/client/ui-primitives/README.md) as the shape to copy).
