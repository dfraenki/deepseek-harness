---
description: "面向模型的 spawn_and_mutate 与 mutation_checkpoint 工具：将当前检出复制为一个朝变更目标自我变异的隔离克隆，供配置自我复制的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory

[English](README.md) | 中文

## Summary

`spawn_and_mutate` 将正在运行的检出复制到一个全新的隔离目录，并向该克隆交付一份变更目标。母检出是只读的：它必须是一个干净的 git 工作树，且其中任何内容都不会被写入。克隆拥有自己的 git 历史（`origin` 远端会被移除）、自己的 `.mutation-home` 状态目录（已从 git 中排除）以及一个保留的本地端口，因此被派生的克隆永远不会与其母体冲突。`mutation_checkpoint` 是克隆侧的验证自动驾驶仪：它对克隆运行当前里程碑的可执行验收标准，绿灯时提交并推进到下一里程碑，红灯时记录失败次数，并在连续第三次失败时将克隆回滚到最后一个绿灯提交。`mutation_run` 是轮次驱动器：它连续调用 checkpoint，直到目标报告 complete、出现教练暂停旗（`.coaches/PAUSE`）或轮次预算耗尽。排练层（`rehearsal_attempt`、`rehearsal_distill`、`rehearsal_report`）让模型在派生之前先在某个能力上尝试候选方法，把每次尝试及其真实的门证据保存在 `.rehearsal-home/` 下，将绿灯尝试蒸馏为技能候选，并且——通过 `requireRehearsalCoverage`——在目标的每个里程碑都有绿灯排练之前拒绝派生。注册遵循检出的角色：母检出（无派生记录）获得派生与排练面，而克隆（配置路径下存在 `MUTATION_SPAWN.json`）只获得 checkpoint 与轮次循环，无法派生克隆。仅当人类明确要求派生、复制或改造工厂本身时才会注册这些工具。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

将该包注册为插件后，它会贡献 `spawn_and_mutate`、`mutation_checkpoint` 与 `mutation_run` 工具，以及声明"仅限显式请求"策略与 checkpoint 纪律的系统提示部分：没有 checkpoint 报告就绝不能宣称里程碑绿灯，也绝不能在 checkpoint 之外提交变异工作。该插件接受一个配置键：`repositoryPath`，即工具操作的检出；默认为进程工作目录，空值会被拒绝。在母检出中它是要复制的源；在克隆内部它就是克隆本身。

调用 `spawn_and_mutate` 需要一个非空的 `goalMarkdown` 文档（写入克隆中 `MUTATION_GOAL.md` 的内容）、一个必须不存在的 `targetPath` 目录，以及可选的 `referencePaths` 数组——其中的文件会被原样复制到克隆的 `references/` 目录。传入 `requireRehearsalCoverage: true` 会先检查目标的每个里程碑是否都有绿灯排练尝试，否则拒绝派生并点名未覆盖的里程碑。每次派生都会把母检出已蒸馏的排练技能候选复制到克隆的 `.agents/skills/` 目录。它返回克隆路径、所切出的母提交、保留的端口、克隆相对的主目录、目标文件的 SHA-256，以及它带过去的技能清单。

`rehearsal_attempt` 接受一个 `topic`（不超过 40 个字符的 kebab 短横线小写标识）、一个 `approach` 标签、一个 `hypothesis`、可选的 `milestone`，以及必填的 `gates` shell 命令数组；它按顺序运行各门，在第一次失败处停止，并连同各门证据记录该次尝试。`rehearsal_distill` 接受 `topic`、技能 `name`、`description` 与 Markdown `body`；它要求该主题存在绿灯尝试，写入技能候选，并取代同一主题早先的候选。`rehearsal_report` 不接受参数，返回各主题的覆盖情况：尝试次数、结论、卡住标记与已蒸馏的技能。`mutation_checkpoint` 不接受参数，针对所配置的检出运行；它返回里程碑、其标题、结果（`committed`、`failed`、`rolled-back` 或 `complete`）、尝试次数、最后的绿灯提交、各门的结果以及一行详情。`mutation_run` 接受可选的正整数 `maxRounds`（默认 64），并返回运行了多少个 checkpoint、停止原因（`complete`、`paused` 或 `max-rounds`）以及最后一次 checkpoint 的决策。

## Understand the implementation

派生是一系列严格且大声失败的步骤：证明母检出是干净的，证明目标不存在，执行 `git clone --no-hardlinks`，切断远端，保留一个空闲的本地端口，创建 `.mutation-home` 目录，写入去除首尾空白并以换行结尾的目标，复制参考文件，对目标做哈希，写入 `MUTATION_SPAWN.json`，将 `.mutation-home/` 从克隆的 git 状态中排除，最后以确定的 `Artifork Factory` 身份将所有内容提交为 `Spawn mutation baseline` 提交。每个 git 失败都会附带命令和工作目录信息进行包装，便于自主调用者在没有 shell 的情况下诊断。派生记录固定了 `version`、`sourceCommit`、`createdAt`、`goalSha256`、`homePath` 与 `port`，使克隆始终能报告它的来源与隔离方式。

checkpoint 会将目标文件解析为里程碑与可执行验收标准（每条标准是一条 shell 命令加一个期望），从 `.mutation-home/loop-state.json` 读取循环状态，并按顺序运行当前里程碑的各个门；第一个红灯即终止本次尝试。绿灯时以 `Mutation: M<n> <title>` 为消息提交，并推进到下一个里程碑（当最后一个里程碑绿灯时报告 `complete`）。红灯时累计失败次数；连续第三次失败时，它会对最后的绿灯提交执行 `git reset --hard`，将失败方法及其门证据追加到 `mutation-log.md`，并清零失败计数，以便下一轮必须换一种方法。checkpoint 针对已知失效模式加固了循环：目标冻结（派生记录固定目标的 SHA-256，被篡改的目标会被拒绝）、每个门有墙钟杀（watch 模式命令变成退出码 124 的红灯，而不是挂起循环）、每个门的完整输出日志存在 `.mutation-home/gates/`、绿灯但工作树无变更计为失败一击而非静默提交，以及回滚时额外清除未跟踪残留（`git clean -fd`），避免死掉的方法泄漏到下一轮。循环状态、门日志与失败日志都保存在 `.mutation-home/` 内部，始终不进入 git。

排练层把状态保存在 `.rehearsal-home/`（已从 git 排除）中：`attempts/<topic>/<seq>.json` 下每次尝试一个 JSON 文件，记录主题、序号、方法、假设、可选里程碑、带退出码的各门结果、结论、蒸馏标记与时间戳。预算与卡住检查会在任何门运行之前读取既有记录，因此已知行不通的方法在烧掉新尝试之前就会被拒绝。一个主题在最后一个尝试的方法上连续三次红灯即为卡住；遇到绿灯尝试或不同方法时计数会重新开始。蒸馏要求主题的最后一次绿灯尝试，写入带 frontmatter 的 `.rehearsal-home/skills/<topic>.md`（命名技能并引用绿灯尝试的序号），并把该尝试标记为已蒸馏，以便后续蒸馏取代它。派生会读取已蒸馏的候选，按 frontmatter 名称逐个复制到克隆的技能目录，并跳过不可读或无名称的文件而不是让派生失败。

## Model Experience

模型看到被限制为人类明确要求派生、复制或改造工厂的 `spawn_and_mutate`，以及被视为验证与提交里程碑工作的唯一合规方式的 `mutation_checkpoint`。排练策略部分告诉它：先排练再派生、把排练实验放进临时目录、只蒸馏绿灯尝试、把卡住的主题当作换方法或升级到教练频道的信号，并在人类期望经过排练的派生时传入 `requireRehearsalCoverage`。`spawn_and_mutate` 的参数为 `goalMarkdown`（必填字符串）、`targetPath`（必填字符串）、`referencePaths`（可选字符串数组）与 `requireRehearsalCoverage`（可选布尔值）；格式错误的参数会在任何文件系统操作之前以具体消息被拒绝。所有工具都将结果渲染为一个文本块；结构化输出 schema 为程序化消费者暴露派生记录、checkpoint 报告与排练覆盖情况的字段。

## Known Limitations and Deferred Work

轮次驱动器只负责排序 checkpoint，不负责监督质量：教练层（观察者、指令与暂停旗）是另一个插件，其传感器正是本包已经写出的门日志与失败日志。目标文档的编写格式由工厂技能定义，除结构化解析外不在此强制执行。端口保留存在固有的探测与使用之间的窗口；重试由克隆的启动器负责。
