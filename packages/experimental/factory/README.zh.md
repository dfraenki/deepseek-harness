---
description: "面向模型的 spawn_and_mutate 工具：将当前检出复制为一个朝变更目标自我变异的隔离克隆，供配置自我复制的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory

[English](README.md) | 中文

## Summary

`spawn_and_mutate` 将正在运行的检出复制到一个全新的隔离目录，并向该克隆交付一份变更目标。母检出是只读的：它必须是一个干净的 git 工作树，且其中任何内容都不会被写入。克隆拥有自己的 git 历史（`origin` 远端会被移除）、自己的 `.mutation-home` 状态目录（已从 git 中排除）以及一个保留的本地端口，因此被派生的克隆永远不会与其母体冲突。仅当人类明确要求派生、复制或改造工厂本身时才会注册该工具；在克隆内部工作的自主循环是另一个部署能力，派生并不会启动它。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

将该包注册为插件后，它会贡献 `spawn_and_mutate` 工具以及一个声明"仅限显式请求"策略的系统提示部分。该插件接受一个配置键：`repositoryPath`，即要复制的母检出；默认为进程工作目录，空值会被拒绝。

调用该工具需要一个非空的 `goalMarkdown` 文档（写入克隆中 `MUTATION_GOAL.md` 的内容）、一个必须不存在的 `targetPath` 目录，以及可选的 `referencePaths` 数组——其中的文件会被原样复制到克隆的 `references/` 目录。该工具返回克隆路径、所切出的母提交、保留的端口、克隆相对的主目录以及目标文件的 SHA-256。

## Understand the implementation

派生是一系列严格且大声失败的步骤：证明母检出是干净的，证明目标不存在，执行 `git clone --no-hardlinks`，切断远端，保留一个空闲的本地端口，创建 `.mutation-home` 目录，写入去除首尾空白并以换行结尾的目标，复制参考文件，对目标做哈希，写入 `MUTATION_SPAWN.json`，将 `.mutation-home/` 从克隆的 git 状态中排除，最后以确定的 `Artifork Factory` 身份将所有内容提交为 `Spawn mutation baseline` 提交。每个 git 失败都会附带命令和工作目录信息进行包装，便于自主调用者在没有 shell 的情况下诊断。派生记录固定了 `version`、`sourceCommit`、`createdAt`、`goalSha256`、`homePath` 与 `port`，使克隆始终能报告它的来源与隔离方式。

## Model Experience

模型看到一个唯一的 `spawn_and_mutate` 工具，其描述与系统提示部分都将其限制为人类明确要求派生、复制或改造工厂的场景。参数为 `goalMarkdown`（必填字符串）、`targetPath`（必填字符串）与 `referencePaths`（可选字符串数组）；格式错误的参数会在任何文件系统操作之前以具体消息被拒绝。结果渲染为一个文本块，概述克隆路径、来源提交、端口、主目录与目标哈希；结构化输出 schema 为程序化消费者暴露相同的五个字段。

## Known Limitations and Deferred Work

派生不会启动任何变异循环：克隆只是一个备好的、带目标的隔离检出，驱动它（轮次、构建/测试门、git 回滚）是由未来的工厂 bundle 挂载的工作。目标文档的语义由工厂技能定义，而非在此强制执行。端口保留存在固有的探测与使用之间的窗口；重试由克隆的启动器负责。
