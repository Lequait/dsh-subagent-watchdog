# dsh-subagent-watchdog

子代理被上游断线打死时，替它给父代理报丧。

> When a subagent dies from an upstream disconnect, the harness fires
> `agent/error` on the **child** but never tells the **parent**. The child just
> becomes `idle`, which is indistinguishable from "finished normally" and
> "waiting for me". The parent then waits forever. This plugin closes that gap.

## 问题

DSH 的 `AgentStatus` 只有 `'idle' | 'running'`，没有 `failed`：

- `agent/status` 的 `idle` 语义是 *"no driver remains scheduled or active"*；
- `list_agents` 只展示 `running` / `inactive`；
- 父级的 `subagent-settled` notice 在断线路径上不会发出。

所以「正常跑完」「在等我回话」「上游断线死了」三者在父代理看来完全一样。唯一可靠的信号是轮询任务板（任务仍 `in_progress` 但成员 `inactive`），这在多代理编排里不可接受。

## 它做什么

1. 在 root scope 监听 `agent/error`（root 监听器能收到所有 agent 的事件）。
2. 解析子代理的父代理：先按创建归属 `ctx.agents.isOwnedBy()`，再退回 fork 谱系 `session.header.parentSession`。
3. 等 `settleDelayMs`（默认 2.5s）。
   - 子代理已经回到 `running` → 说明 harness 自己重试成功了，**不发**。
   - 子代理仍是 `idle` → 它没恢复，**发**。
4. 用 `parent.followup(message)` 投递一条可处理的通知：父代理空闲时会被唤醒，正在跑时排到当前轮之后。

它**不重试任何东西**，也不改会话历史——只负责让父代理知道「这个子代理死了，你来决定」。

## 安装

### 方式一：绝对路径（本地开发，无需 npm）

在 `~/.dsh/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: subagent-watchdog
      name: "H:/AI/dsh-subagent-watchdog/index.js"
```

loader 会把绝对路径转成 `file://` URL，不需要 profile `node_modules` 链接。注意必须是 `- insert:` 列表——profile 层的 patch 是 id-targeted 的，裸 `- id:` 会被当成「patch 已存在条目」。

依赖 `schemastery` 需要在插件目录里 `npm install` 一次。

### 方式二：从仓库安装

```bash
dsh plugin --profile <name> add git+https://github.com/Lequait/dsh-subagent-watchdog.git
```

### 方式三：从插件市场安装

把下面这个索引地址加进 Discover 的索引源，然后在市场里装：

```
https://github.com/Lequait/dsh-subagent-watchdog/raw/main/market/index.json
```

jsDelivr 镜像（国内更快）：

```
https://cdn.jsdelivr.net/gh/Lequait/dsh-subagent-watchdog@main/market/index.json
```

## 配置

全部可选，写在 patch 条目的 `config:` 下：

```yaml
- insert:
    - id: subagent-watchdog
      name: "H:/AI/dsh-subagent-watchdog/index.js"
      config:
        settleDelayMs: 2500
        cooldownMs: 60000
        dryRun: false
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `settleDelayMs` | `2500` | `agent/error` 之后等多久再判定死亡。期间恢复成 `running` 就不发 |
| `cooldownMs` | `60000` | 同一个子代理两次通知的最小间隔 |
| `maxPerChild` | `5` | 同一个子代理的通知上限（每进程） |
| `notifyOnDisposed` | `true` | 子代理带着未处理失败被 dispose 时也报 |
| `dryRun` | `false` | 只写日志不投递，首次安装建议先开 |
| `messagePrefix` | `[subagent-watchdog]` | 通知前缀 |

## 父代理收到的通知

```
[subagent-watchdog] 子代理中断

子代理: 01J8X...
层级: 1
轮次/步骤: turn 2 / step 5
错误: socket hang up code=ECONNRESET
状态: 已停止（idle），不会自行恢复

请决定如何处理：
- 重新派发同一任务（spawn 新的子代理）
- 换 provider/model 重试
- 自己接手
- 放弃并记录

（本条由 dsh-subagent-watchdog 自动投递；若你已收到该子代理的正常完成通知，请忽略。）
```

## 已知边界

- **只覆盖「错误后停住」这一种死法。** 如果上游是静默挂起（流一直不返回、也不报错），`agent/error` 不会触发，本插件也不会说话。那种情况要靠 provider 的 `streamIdleTimeoutMs`（默认 5 分钟）把它变成 `TIMEOUT`。
- **可能重复通知。** 如果 harness 某天补上了断线路径的 `subagent-settled` notice，父代理会同时收到官方通知和本插件的通知。通知正文里已写明「若已收到正常完成通知请忽略」。
- **不区分错误类型。** 工具报错、provider 断线、上下文溢出都会触发 `agent/error`。判定标准是「错误之后没有恢复」，而不是错误码。
- 依赖 `ctx.agents` 服务；`inject = ['agents']` 保证它在服务就绪后才挂载。

## 相关

- 官方讨论：<https://github.com/deepseek-ai/deepseek-harness/discussions/12200>
- 文档：`/reference/subsystems/core`（`agent/*` 事件）、`/reference/subsystems/subagent`、`/reference/subsystems/llm-streaming`

## License

MIT
