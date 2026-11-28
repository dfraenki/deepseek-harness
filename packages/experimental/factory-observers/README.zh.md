---
description: "面向模型的 coach_propose、coach_observe、coach_pause 与 coach_resume 工具：三个教练观察者与变异智能体之间的确定性指令通道，供配置受监督变异运行的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory-observers

[English](README.md) | 中文

## Summary

本包是智能体软件工厂的教练层：三个只读的教练观察者（过程教练、意图教练与技能大师）通过确定性的文件系统通道来引导一个正在变异的克隆，而它们自己不执行任何操作。教练用 `coach_propose` 提交一条引用证据的指令；同一主题上的最新提案会以单调递增的序号取代旧的提案，受治理的指令区段会在每次提示组装时按字符预算重新组合，因此建议只在轮次边界到达变异智能体，绝不会出现在尝试进行中。技能大师是唯一有权停止循环的观察者：`coach_pause` 写入 `.coaches/PAUSE` 标志，轮次驱动器会在下一轮之前遵照它停止循环并保留里程碑状态；`coach_resume` 则清除该标志。所有机制都是纯文件操作；本包中不含任何模型判断。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

将本包注册为变异克隆内的插件后，它会贡献 `coach_propose`、`coach_observe`、`coach_pause` 与 `coach_resume` 工具，以及两个系统提示区段：描述三个教练及其边界的静态策略区段，和每次提示组装时从通道重新组合的动态指令区段。该插件接受两个配置键：`repositoryPath`，即教练观察的克隆（默认为进程工作目录，拒绝空值）；`maxSectionChars`，受治理区段的字符预算（默认 2048，必须为正的安全整数）。

`coach_propose` 接受 `coach`（`process`、`intent`、`skills` 之一）、`topic`（不超过 40 个字符的小写 kebab slug）、`evidence`（指令所依据的可观察事实）与 `directive`（边界范围内的建议）；返回保存后的提案及其分配的序号。`coach_observe` 不接受参数，报告暂停状态及其原因、受治理的指令数量、因预算被丢弃的数量，以及按优先级排序的指令行。`coach_pause` 与 `coach_resume` 要求 `skills` 身份；其他教练会被以明确的错误信息拒绝。暂停需要非空的原因，它会存储在标志文件中。

## Understand the implementation

通道位于克隆的 `.coaches/` 目录下：每个教练与主题在 `.coaches/proposals/<coach>/<topic>.json` 下有一个 JSON 文件，内容为 `seq`、`evidence` 与 `directive`。保存时会校验提案（教练身份、kebab 主题、非空的证据与指令），从同一文件读取上一个序号并写入新序号，因此取代顺序是持久且可观察的；已存在的损坏文件会将序号重置为 1。读取通道绝不会使循环失败：未知的教练目录、非 JSON 文件、损坏的 JSON、形状错误的字段、不可读的文件以及未通过校验的主题都会被跳过。`composeDirectives` 按教练优先级（process、intent、skills）再按主题排序，把每条指令渲染为一行引用证据的文本，并在超出大小预算时整行丢弃而不是截断半行；丢弃数量会被报告，因此没有任何内容会无声消失。动态区段通过同步、失败即软处理的通道读取使用同一组合逻辑，与 skill-filesystem 提供者的精神一致，因为提示组装是同步的。暂停标志是 `.coaches/PAUSE`，内容为原因；工厂的轮次驱动器会在每一轮之前检查它。

## Model Experience

模型会在策略区段中看到三个教练的描述，在每次组装时看到作用于自己的受治理指令，以及四个工具：提交指令、查看通道，以及——仅限技能大师——暂停或恢复循环。每条指令都必须引用可观察的证据，校验会以机械化方式强制执行；畸形参数会在任何文件系统操作之前被以明确的错误信息拒绝。渲染会说明指令何时生效（下一个轮次边界）、当前治理了什么，以及暂停对里程碑状态的影响。

## Known Limitations and Deferred Work

教练目前是一个协议，而不是正在运行的子智能体：本包不会启动它们，因此今天是由人类、以教练角色行事的变异智能体自身或外部进程通过工具提交提案。将三个教练挂载为基于 harness 的 `SubagentProvider` 接缝的真实子智能体是下一步。受治理区段仅按约定在轮次边界生效（轮次驱动器在轮次之间暂停）；本包无法打断正在进行的尝试。指令是建议性的：通道无法强制变异智能体服从，只能让建议及其证据在每次组装时可见。
