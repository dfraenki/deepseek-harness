---
description: "面向模型的 factory_catalog 与 factory_publish 工具：从应用自身文件与 git 历史推导的 Artifork 已生成应用目录，以及附带可直接执行托管清单的已提交发布决策，供软件工厂的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory-catalog

[English](README.md) | 中文

## Summary（摘要）

本包是智能体软件工厂的目录与发布决策层：每次开发完成后，工厂母体都会把该应用记入 Artifork 目录，并决定是发布到托管服务商还是仅保留在目录中。`factory_catalog` 从应用自身的文件与 git 历史推导每个已生成应用的状态、里程碑进度、最后绿色提交以及已提交的发布决策——目录本身不保存任何状态；`factory_publish` 先验证应用确已完成，再把决策写入已提交的 `PUBLISH_RECORD.json`，并且在选择托管目标时生成可直接执行的 `PUBLISH_MANIFEST.md`，由持有云凭证的人类或 CI 任务执行。所有机制均为文件、目录与 git 操作；本包不含任何模型判断。

## Table of Contents（目录）

- [Use this package（使用本包）](#use-this-package)
- [Understand the implementation（理解实现）](#understand-the-implementation)
- [Model Experience（模型体验）](#model-experience)
- [Known Limitations and Deferred Work（已知限制与延后工作）](#known-limitations-and-deferred-work)

## Use this package（使用本包）

把本包作为插件注册到工厂母体，它会贡献两个目录工具加一个静态策略节，说明何时查阅目录以及如何记录决策。插件接受两个配置项：`repositoryPath`（目录所服务的工厂检出，默认为进程工作目录，拒绝空值）和 `appsDir`（子目录即已生成应用的目录，默认 `apps`，相对 `repositoryPath`）。插件在变异克隆内部不生效：克隆永远不会对自身编目或发布，与 factory 包的角色门控注册保持一致。

`factory_catalog` 不接收参数，报告应用目录下每个可读的应用；没有生成记录的目录会被静默忽略，无法读取的应用会连同原因一起报告为已跳过。`factory_publish` 需要一个 `appPath`，可选一个 `target`（默认 `catalog-only`；取值为 `catalog-only`、`cloudflare`、`hostinger` 之一）。发布拒绝任何非完成状态或检出不干净的应用，拒绝在 `cloudflare` 目标上发布无界面应用，并提交它写入的每一个文件。

## Understand the implementation（理解实现）

目录是派生状态。对每个已生成的应用，它读取目标的最后一个里程碑，并按固定顺序推导状态：教练暂停标志优先（`paused`），脏的 git 树意味着循环正处于尝试之中（`in-progress`），只有包含最后一个里程碑 `Mutation:` 提交的干净树才算 `complete`——因为该检查搜索的是历史而不是信任 HEAD，所以最后一个里程碑之后的发布提交不会破坏完成状态。里程碑编号来自克隆已提交的循环状态，可部署面由应用布局检测：存在 `apps/web` 目录即 `web`，否则为 `headless`。发布先写入带有验证提交的记录，托管目标再写入包含各目标命令块（Cloudflare Pages 用 `wrangler pages deploy`，Hostinger 用 VPS 上传加 `dsh web`，无界面应用用 node 服务配方）以及"本 harness 绝不存储云凭证"说明的清单；每次写入都是一次使用确定性工厂身份的独立提交。

## Model Experience（模型体验）

模型会在系统提示中看到目录策略：应用完成其变异目标后查阅 `factory_catalog`，与人类共同决定是否发布到托管服务商，用 `factory_publish` 记录决策，并且在目录报告完成之前绝不声称应用可发布。两个工具都以纯文本渲染结果：按应用逐行列出的目录（`name: status, milestone M2/2, green at <commit>, publish manifest-ready (cloudflare)`，或 `SKIPPED (reason)`）、明确的空状态，以及指明记录路径并在存在时附带清单路径与"持有云凭证的人类或 CI 任务必须执行"提醒的发布确认。

## Known Limitations and Deferred Work（已知限制与延后工作）

发布 v1 记录决策并产出可直接执行的清单；执行真实部署被延后，因为本 harness 绝不存储云凭证——持有密钥的人类或 CI 任务必须运行清单命令。界面检测是布局启发式（`apps/web` 与无界面之分），不是构建检查。目录报告的是静止状态的应用：尝试进行中的变异运行显示为 `in-progress` 及其循环状态的最后绿色提交，而不是实时数据流。
