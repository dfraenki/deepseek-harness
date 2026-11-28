---
description: "面向模型的 preview_start、preview_status、preview_stop 和 preview_probe 工具：变更克隆应用的唯一共享实时实例，由用户观察、由代理探测，供受监督变异运行的用户和维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-factory-preview

[English](README.md) | 中文

## Summary

本包是智能体软件工厂的共享实时预览层：在变更克隆内部，它把克隆自己的 Web 应用启动到 spawn 时记录的端口上，使工厂 UI 中的用户与变异代理观察并测试的完全是同一个运行实例。`preview_start` 是幂等的——没有实例在服务时就启动应用，否则复用存活进程——而 `preview_status`、`preview_stop` 和 `preview_probe` 则报告、停止并 HTTP 探测这唯一的一个源头。无法启动或无法应答的预览是一道红色关卡：每次失败都携带服务器日志尾部和具体的诊断，而不是静默回退。所有机制都是进程与文件操作；本包不含任何模型判断。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

把本包作为插件注册到变更克隆内，它会贡献四个预览工具加一个描述共享实例规则的静态策略小节。插件接受四个配置键：`repositoryPath`，受管理预览所在的克隆（默认进程工作目录，拒绝空值）；`command` 与 `args`，可选的启动器覆盖（默认使用克隆自己的 `node_modules/.bin/dsh web --port`）；`startTimeoutMs`，以毫秒计的启动预算（默认 120000，必须是正的安全整数）。

四个工具都拒绝在 spawn 出的变更克隆之外运行：仓库路径下没有 `MUTATION_SPAWN.json` 时会以特定消息失败。`preview_start` 与 `preview_status` 不接受参数；`preview_probe` 接受可选的 `path`（默认 `/`）并报告 HTTP 状态、内容类型和正文摘录；`preview_stop` 先礼貌后强制地停止已记录的进程并保留里程碑状态——`preview_start` 会在同一个保留端口上重新启动。

## Understand the implementation

状态存放在克隆内的 `.mutation-home/preview/` 下：`state.json` 记录 `running`、`pid`、`port`、`startedAt` 和 `command`，`server.log` 累积应用的 stdout 与 stderr 以及生命周期日志行。做任何事之前，先读取 spawn 记录中的保留端口，并把进程已消失的陈旧状态结算为已停止。启动时以 `DSH_HOME` 指向克隆变更主目录的方式 spawn 克隆的应用；进程 id 缺失或启动失败——中止、spawn 错误、提前退出、或预算时间内无应答——都会放弃本次启动：杀死子进程、记录原因与日志尾部、把状态写为已停止，并抛出诊断性错误。探测向 `http://127.0.0.1:<port>` 发出一次真实请求，超时很短且尊重中止信号。日志写入是故障软化的，坏掉的日志绝不会让一次启动崩溃。

## Model Experience

模型会在系统提示中看到共享实例策略：唯一的预览实例、与用户观看相同的源头、探测即验证证据、测试必须自我清理，以及拒绝把预览指向工厂母体的源头。工具以纯文本呈现结果：在共享 URL 上启动或已在服务、带日志尾部的服务中/未运行、保留里程碑状态的停止，以及形如 `GET <url> → <status> (<type>); body starts: ...` 的探测应答——无应答的报告会把模型引回 `preview_start`。

## Known Limitations and Deferred Work

验证是 HTTP 探测而非浏览器：控制台错误、渲染与交互尚未被观察；基于浏览器的探测与供用户侧边栏使用的工厂侧客户端插件是后续工作。启动器默认使用克隆自己的 `dsh` 二进制，因此需要额外依赖的克隆必须在首次启动前安装好它们——诊断信息会明确说明这一点。状态是单实例的：每个克隆一个预览进程，这是设计使然。
