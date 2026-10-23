---
name: dsh-bridge
description: Delegates a structured task to the local DSH (DeepSeek Harness) agent through the dsh_task / dsh-task interface, with a fixed input-output contract, sandbox-enforced read-only default, and optional session continuation. Use when the user asks to involve DSH, or when DSH's own tools and persistent session should do the work. Prefer this over driving the DSH window with computer use — screenshots cost thousands of tokens per step. Not for reading live state out of the DSH GUI.
---

# dsh-bridge

DSH is reachable as a programmatic interface. DSH does its own tool calls, retries, and long reads
in its own session; only the final structured report comes back into this conversation.

Two channels, one implementation:

1. **MCP tool `dsh_task`** (preferred — check the tool list first).
2. **CLI via bash**:

   ```bash
   {{DSH_RUN_CMD}} -g "任务目标" [选项]
   ```

   `{{DSH_RUN}}` 是安装时的桥接目录（`{{BRIDGE_ROOT}}`）下的入口，由安装器替换为本机真实路径；
   安装器会为命令路径添加安全引用，请完整保留。等价写法：`node {{DSH_TASK_CMD}} ...`（参数完全相同），
   或在桥接目录内直接 `./dsh-run ...`。

## 输入契约

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `goal` | 是 | 要交付的结果，陈述成产出物，不是话题 |
| `cwd` | 建议 | 绝对工作目录；`edit` 的写入边界，也是会话绑定目录 |
| `files` | 否 | 相关文件/目录；CLI 用重复的 `-f`，**不按逗号切分** |
| `mode` | 否 | `analyze`（默认，只读）/ `edit`（可写 cwd）；其他值直接报错 |
| `context` | 否 | DSH 无法推断的背景：已有结论、已做的决定 |
| `constraints` | 否 | 硬限制：不许动什么、语言、风格、工具限制 |
| `acceptance` | 否 | 验收标准；DSH 会先自检再回答 |
| `session` | 否 | 会话标签；省略 = 全新一次性会话 |
| `timeout_s` | 否 | 默认 600，允许 5–1800 |

CLI 对应：`-g / -C / -f / -m / --context / -c / -a / -s / -t`。

## 输出契约

```
任务状态：成功 / 部分完成 / 失败
结果摘要：一到三句话
交付内容：文件路径 / 实际改动 / 分析结论
发现问题：每条含 位置 / 触发条件 / 严重程度 / 修复建议
验证情况：已验证 / 未验证（及原因）
未解决事项：风险、局限、需要你决策的点
建议动作：一到三条可执行动作
```

桥接会做三项可机器判定的检查，并把结果放在 `_meta`（CLI `--json` 同样可见）：

- `execution`: `completed | failed | timeout | cancelled | execution_unknown`
- `result`: `success | partial | failed | unknown`（来自报告的「任务状态」）
- `warnings`: 缺段落、问题缺位置、验证缺证据、输出被截断
- `contractOk`: 结构是否完整

**按这些字段决定下一步，不要只看文本长度**：`execution_unknown` 表示 DSH 状态不明，
不能当成完成，也不能在同一会话继续提交。

## 权限规则（分清三层，均已实测）

| 层次 | `analyze` | `edit` |
| --- | --- | --- |
| 业务写入范围（任务约束） | 无 | `cwd` 内 |
| 沙箱实际可写 | 无（只读） | `cwd` + 系统临时目录（`/tmp`、`$TMPDIR`） |
| 网络 | 可出网 | 可出网 |

- `analyze`：工作目录内也不能创建/修改/删除；符号链接、绝对路径、子进程同样被 `EPERM` 拒绝。
- `edit`：**“只能写 cwd”是任务约束，不是沙箱事实**。沙箱额外授权了系统临时目录，
  因此任务必需的临时文件（哈希、编译、测试缓存）是允许的；任务结束应清理并如实报告。
- 不属于本次任务的临时文件不要删；不要写其他项目或全局配置。
- **严格隔离**（要求所有写入只发生在指定目录）：当前没有 cwd-only 的强制模式，
  只能明确报告限制，不要承诺“已经隔离”。
- **网络不在文件沙箱内**：`analyze` 也能发起外网请求。需要「无外部副作用」时要单独评估。
- 只有用户明确要求改动时才用 `edit`；独立子任务优先 `analyze`，先拿到「改哪里、怎么改」。

## 会话策略

- 省略 `session`：每次全新会话。任务彼此独立时用这个，上下文隔离最干净。
- 传 `session`：同一标签 = 同一会话，后续调用带完整历史，跨桥接重启可冷恢复。
- ID 由「模式 + 可读前缀 + 标签哈希」组成；`proj_a` 与 `proj-a` 不会撞车。
- 一个标签绑定一个 `cwd`（按真实路径比较）；换目录会报错，请换标签。
- 会话变脏（超时取消未确认、连接中断、host 退出）后**拒绝新任务**。恢复方式：换标签，
  或确认 DSH 侧已空闲后重试。不要在脏会话上直接重发 `edit` 任务。
- 新阶段/新话题换标签，既省上下文也避免继承过期结论。

## 成本纪律

- 一次调用 = 一份报告。相关问题合并成一次 `goal`，不要连开多次。
- 要受限输出（表格、清单、≤N 行、路径），而不是完整日志。
- 大产物：`analyze` 写不了文件（沙箱拒绝），只能回传受限文本；需要落盘时用 `edit`
  在 `cwd` 内写报告文件，并让报告只给路径 + 摘要。
- 输出超限会被截断并带 `…[中间省略 N 字符]…` 标记，此时 `contractOk=false`，不要当作完整报告。

## 失败处理

- `timeout`：已尝试 `session.cancel`；`warnings` 会说明是否确认中止。确认中止后可继续用同一会话。
- `execution_unknown`：取消未确认或连接断开，会话已置脏；不要重发修改类任务。
- `result=failed`：报告本身有效，但 DSH 判定任务失败；按报告里的「未解决事项」处理。
- `cwd` 不存在、会话目录冲突：不要静默换路径或换标签，先说明冲突。
- 契约缺段：文本前会有 `⚠︎` 警示；按缺什么判断可信度。
- 除非用户明确要求 GUI 操作，否则**不要退回 computer use**。

## 在多 Agent 流程中的位置

本 Skill 只负责「怎么调用 DSH」，不负责「什么时候该调」。
编排规则（任务分类、设计确认、验收、升级）在 `multi-agent-development` Skill 里：
DSH 在该流程中承担 `development_executor` 角色，默认由主控委派、由主控验收。

## 边界

- DSH 看不到本会话上下文，也不会追问；每轮 `goal` 必须自包含。
- 会话续接复用「对话历史」，不复用你的工作记忆；续接时先确认相关文件是否已被外部修改。
- DSH 有自己的模型预算和工具集（bash、文件、搜索、技能），不要假设它只能读。
