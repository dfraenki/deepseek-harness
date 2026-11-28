---
description: "从插件页启用 Artifork 软件工厂：隔离的自复制克隆，带自主变异循环、教练观察者、实时预览，以及带发布决策的目录。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-factory-bundle

[English](README.md) | 中文

## Summary（摘要）

Artifork 软件工厂的组合：一个 bundle 把四个工厂包作为普通 Host 行挂载，使工厂工具加入每个 preset 都会收到的全局工具层。`spawn_and_mutate` 把此检出克隆到一个隔离目录，克隆通过带 git 检查点与三次未过即回滚的自主变异循环，把自身变异为目标应用；教练观察者监视循环并可以暂停它；实时预览在克隆的专用端口上提供克隆自己的应用，供人类与智能体使用；目录则记录每个已完成的应用及其发布决策。在变异克隆内部，相同的行加载克隆侧：每个包的角色门控读取检出的生成记录，挂载克隆在自身之上工作所需的循环、预览与教练工具。

## Table of Contents（目录）

- [Use this package（使用本包）](#use-this-package)
- [Understand the implementation（理解实现）](#understand-the-implementation)
- [Model Experience（模型体验）](#model-experience)
- [Known Limitations and Deferred Work（已知限制与延后工作）](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package（使用本包）

打开 Plugins，在 Official 分组中启用 Artifork software factory；随附的配置档默认不启用它。开关会立即为存活的智能体加载四条工厂行，移除选择即将其下线。生成的克隆不需要这个开关：工厂的 spawn 会预先准备克隆自己的 web 配置档并选中此 bundle，因此克隆从第一次启动就带有它的变异循环、预览与教练工具。工厂工具面向模型；会话的智能体只在人类明确要求生成、复制或改造工厂自身时才调用 `spawn_and_mutate`。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation（理解实现）

<details>
<summary>维护者详情 — 点击展开</summary>

bundle 的 patch 为每个工厂包插入一条 Host 行。每个包把它的工具注册进全局工具层，因此所有 preset——standard、ptc、cordis、minimal——无需编辑 preset 即可收到；切换 bundle 会为存活的智能体注册或移除这些工具。角色门控按检出划分，而不是按行划分：每个包的 `apply` 读取生成记录并挂载母体或克隆的工具集，因此一个 bundle 同时承载两侧。spawn 侧的配置档准备会在克隆首次启动之前写入克隆的配置档清单（`dsh.profile.bundles` = 随附 web 模板加此 bundle），`initProfile` 的从不覆盖规则会保留这一选择。

</details>

-----

<a id="model-experience"></a>
## Model Experience（模型体验）

模型会在其系统提示中看到工厂的策略节（spawn 政策、预演政策、目录政策、教练指令），并在其工具目录中看到工厂工具，具体取决于检出的角色。人类则从 Plugins 页开关、`/factory/catalog` 总览与克隆的实时预览链接看到同一座工厂。

#### KV Cache effect

bundle 启用期间，工厂各节为每个会话增加固定的提示字节数；克隆侧在此之上再增加循环与教练各节。

## Known Limitations and Deferred Work（已知限制与延后工作）

<a id="known-limitations-and-deferred-work"></a>

- 工厂包是实验性的；该 bundle 遵循随附可选 bundle 政策，保持在产品默认组合之外。
- 生成的克隆需要先安装其依赖（在克隆内执行 `pnpm install`），克隆自己的 `dsh web` 才能启动；spawn 只记录保留端口，不执行安装。
