---
name: multi-agent-development
description: Orchestrates the four-role development workflow (coordinator → architecture designer → DSH executor → review) with persistent design baselines, task handoff documents, evidence-based review, and bounded escalation. Use for multi-step feature work, new projects, or any change that needs design before implementation. Do not use for one-off edits that need no design and no delegated implementation.
---

# multi-agent-development

四个角色分工固定，模型可替换：

| 角色 | 谁来做 | 模型来源 |
| --- | --- | --- |
| `project_coordinator` | 当前会话的主控 Agent（你） | 用户默认模型，不在此 Skill 中指定 |
| `architecture_designer` | 子 Agent，`agent_type="architecture_designer"` | `~/.codex/agents/architecture_designer.toml` 的 `model` |
| `development_executor` | 本地 DSH，通过 `dsh_task` | DSH 自己的设置 |
| `quality_reviewer` | 默认由你在当前会话执行 | 跟随主控 |

**不要在本 Skill 里写死模型名。** 需要换模型时只改 `roles.json` 并重装角色配置，
本文件与 `dsh-bridge` 都不需要改。

---

## 0. 先分类，再决定流程

| 类 | 判定信号 | 流程 |
| --- | --- | --- |
| A 简单 | 文案、样式、单文件小改、明确的小 bug、已有测试可直接验证 | 直接做或 `dsh_task(analyze)` 后自己改，**不调设计 Agent** |
| B 设计内 | 已有 `PROJECT_DESIGN.md` 且本次不改变接口/数据模型/模块边界 | 读设计基线 → DSH 实现 → 你验收 |
| C 需设计 | 新项目、新模块、新接口契约、数据结构变更、跨模块重构 | 设计 Agent 出方案 → 用户确认 → DSH 实现 → 你验收 |
| D 高风险 | 认证、权限、支付、数据迁移、并发一致性、关键存储/服务架构 | 设计 Agent 先做设计与风险评估 → 用户确认 → 分步实施 → 加强验收 |

判定输出写到任务文档（`class:` 字段）。拿不准时按更高一级处理，但不要为 A 类反复调用设计 Agent。

---

## 1. 设计基线：文件是唯一事实源

项目内使用：

```
docs/architecture/
├── PROJECT_DESIGN.md      # 目标、架构、数据流、接口契约、版本、状态
├── DECISIONS.md           # 架构决策记录（ADR）
└── TASKS/<task-id>.md     # 任务交接单
```

规则：

- 每次进入 B/C/D 流程前，先读 `PROJECT_DESIGN.md` 的「当前设计版本」和「状态」。
- 设计变更必须新增 `DECISIONS.md` 条目，并递增版本号；旧决策不删除，标记 `superseded by`。
- 任务单只写路径、版本号、摘要，不复制设计全文。
- 模板取自桥接目录 `"{{BRIDGE_ROOT}}/docs/templates/architecture/"`（业务项目里只放自己的基线与任务单，
  不要把桥接的 `scripts/`、`lib/` 复制进项目）；生成用：

  ```bash
  # 工具在桥接目录里，不在业务项目里；业务项目只需要 docs/architecture/ 文档
  node {{TASK_DOC_CMD}} new --id T-001 --class C --goal "一句话目标"
  node {{TASK_DOC_CMD}} set-state --file docs/architecture/TASKS/T-001.md --state implementing
  node {{TASK_DOC_CMD}} check --file docs/architecture/TASKS/T-001.md
  ```

  `{{TASK_DOC}}` 由安装器替换为本机桥接目录下的真实路径（`{{BRIDGE_ROOT}}/scripts/task-doc.mjs`）；
  在业务项目目录里执行即可，命令会把任务单写进当前项目的 `docs/architecture/TASKS/`。

  状态转换会被校验；非法跳转直接报错，不要手改状态绕过。

  **强制要求**：

  - 新任务一律用 `task-doc new` 生成，不要手写 front matter——Checker 是严格的，
    自由格式（`class:` / `state:` 这种）会被判为缺少字段。
  - 交付前必须执行 `task-doc check --file <路径>` 并通过，否则不得标记 `delivered`。

---

## 2. 调用设计 Agent（C / D 类）

```
spawn_agent(
  agent_type = "architecture_designer",
  task_name  = "design_t001",
  fork_turns = "none",            # 设计包必须自包含，不要继承整段对话
  prompt     = """
  用户目标：<一句话 + 验收口径>
  当前设计版本：<vX / 无基线>
  相关路径：<绝对路径列表>
  已有实现摘要：<已做了什么，关键 diff 位置>
  约束：<性能/安全/兼容/不能动的东西>
  需要你回答的决策：<具体问题，不要泛问>
  已知失败证据：<测试输出、报错、日志要点>
  """
)
```

要点：

- **不要传 `model`**：模型由角色配置决定；只有用户明确要求临时换模型时才传。
- `fork_turns="none"` + 自包含 prompt，避免把整段会话灌进子 Agent。
- 设计 Agent 返回后，把设计包写入 `PROJECT_DESIGN.md` / `DECISIONS.md`，并在任务单记录版本号。
- 如果你调用 `agent_type` 报「unknown agent type」：说明角色未安装或被 Codex 忽略
  （用 `codex doctor` 看 startup warning）。此时**不要伪造**自动路由，改为半自动：
  在会话里直接给出设计任务书，请用户在新会话用 `/agent` 或复制到设计会话执行，
  拿到设计包后继续后续步骤，并在交付报告中说明「设计 Agent 未自动调用」。

C/D 类在进入实现前必须有一次**用户确认**（A/B 不需要）：

> 设计要点 / 影响范围 / 待决问题 / 我建议的默认取舍 —— 请确认或修改。

D 类还要单独确认风险面与回滚方式。

---

## 3. 委派 DSH（implementation）

先用 `task-doc new` 建任务单（不接受手写；已有任务单直接复用）。**优先用 MCP 工具 `dsh_task`**（工具表里存在就用）；
没有该工具时用等价 CLI，语义与参数完全一致：

```bash
{{DSH_RUN_CMD}} \
  -C <项目绝对路径> -m edit -s <项目短标签> \
  -g "<交付物：改什么、达到什么可观测结果>" \
  -f <设计文档路径> -f <相关源码路径> \
  --context "<设计版本、关键决策、上轮失败原因>" \
  -c "<约束>" -a "<可执行断言>" -a "<测试命令>"
```

MCP 形式：

```
dsh_task(
  goal       = "<交付物：改什么、达到什么可观测结果>",
  cwd        = "<项目绝对路径>",
  mode       = "edit",                      # 用户已授权改动时才用 edit
  files      = ["<设计文档路径>", "<相关源码路径>"],
  context    = "<设计版本、关键决策、上一轮失败原因>",
  constraints= ["不要改 docs/architecture 之外的契约", "不新增依赖 X", ...],
  acceptance = ["<可执行断言>", "<测试命令>", ...],
  session    = "<项目短标签>"               # 同一项目连续任务复用；独立任务不要传
)
```

规则：

- 两种通道共用同一个执行器与契约，结果字段一致；不要因为没装 MCP 就跳过委派。
- `analyze` 用于方案核对、定位、审查；`edit` 只在该任务已获授权时使用。
- 一次委派尽量覆盖一组相关改动，避免把同一文件拆成多次调用。
- 不要求 DSH 回传完整工具日志；只要结论、改动位置、验证证据。
- 权限与临时文件按 §3.1 区分任务类型；不要给所有任务套用「禁止系统临时目录」的通用规则。
- 返回里的 `execution` / `result` / `warnings` 要读：`execution_unknown` 时**不得**在同一 session 继续提交。
- 续接会话前，重新确认相关文件是否已被外部修改。

### 3.1 权限与临时文件（标准 / 严格）

**标准开发模式（默认）**——用户授权 `edit` 时适用：

- 可以改：授权项目 `cwd` 内的业务代码与文档。
- 可以建：任务必需的系统临时文件（哈希、编译、测试缓存等）。
- 不得改：其他未授权项目、用户全局配置与凭据、与任务无关的持久文件。
- 不得删除：不属于本次任务的临时文件；不得未经授权 push、部署或做破坏性数据迁移。
- 临时文件用安全创建方式（唯一名字或 mkstemp 语义），避免覆盖已有文件、避免跟随符号链接。
- 任务结束应清理自己创建的文件；**清理失败要在报告里如实说明，不得隐瞒**。
- 验收看改动范围、测试证据与实际副作用；**不得仅因合理的临时文件操作判失败**。

**严格隔离模式（按需）**——用户明确要求「所有写入只能发生在指定目录」时：

- 不能只靠 prompt 承诺，必须先确认沙箱能否强制执行该边界。
- 当前 DSH 的 `workspace-write` = `cwd` + 系统临时目录授权，**不等于 cwd-only**；
  网络请求也不在文件沙箱内。
- 若无法强制执行：明确报告限制，暂停该写入任务或请用户调整授权范围；不要假装已经隔离。

---

## 4. 验收（你自己做，不外包给 DSH）

按任务单的验收条件逐条核，不要只看 DSH 的自述：

1. **改动范围**：`git status --short` / `git diff --stat`，确认没超出任务单允许的文件。
2. **Diff 质量**：逐段看关键改动，检查是否夹带无关重构、调试代码、写死的临时值。
3. **测试证据**：自己跑一遍验收命令（或核对 DSH 给的命令与输出是否可复现）。
4. **设计一致性**：接口、数据模型、错误语义是否与 `PROJECT_DESIGN.md` 一致。
5. **回归风险**：受影响调用方是否处理；边界条件是否覆盖。
6. **安全与副作用**：权限、输入校验、密钥、日志泄露；检查是否有目录外写入或未授权改动。
   合理的临时文件不算违规；异常残留、敏感数据、未授权的持久文件才算。
7. **严格隔离任务**：若任务声明了严格隔离，必须验证真实边界，不能只看 prompt 或自述。

结论只能是：

| 状态 | 含义 |
| --- | --- |
| `passed` | 全部验收条件满足，证据充分 |
| `failed` | 实现问题，可交回 DSH 修复 |
| `design_issue` | 设计本身有问题，需要设计 Agent |
| `blocked` | 缺信息/缺授权/外部依赖，需要用户决策 |

验收记录写进任务单，或用 `docs/architecture/REVIEW-TEMPLATE.md` 的格式：
状态、依据、发现的问题、副作用、审计范围、需要的动作。

---

## 5. 失败处理与升级

**普通修复**（`failed`）：

- 给出具体失败点：验收条件、命令、期望 vs 实际、相关文件行号。
- 交回 DSH 修，验收条件不变。
- 同一根本问题默认最多 **2 轮**有证据支持的修复。

**升级设计 Agent**（满足任一）：

- 同一问题修了 2 轮仍无实质进展；
- 失败指向设计缺陷（接口契约不自洽、数据模型撑不住需求）；
- DSH 与你的技术判断有重大分歧；
- 需要改已批准的架构契约；
- 涉及安全/权限/数据的根因不确定。

升级包必须包含：用户目标、设计版本、相关代码位置、已完成实现、关键 diff、失败证据、
已尝试的修复、你需要设计 Agent 回答的具体问题。

设计 Agent 的产出仍是「设计」，实现和验收回到原流程。升级后不要让它接管编码。

**停止条件**（停下问用户，不要硬转）：

- 连续两轮修复无进展且设计 Agent 也判定「需要用户决策」；
- 需要扩大权限、改全局配置、动生产数据；
- 用户目标本身有冲突。

---

## 6. 交付

给用户的最终报告只包含：

1. 做了什么（对应需求，不是文件清单）。
2. 设计版本与关键决策（有变更时）。
3. 验证证据：命令 + 结果摘要。
4. 未解决项与风险（如有）。
5. 任务单路径与状态。

同时确认：

- 任务单状态为 `delivered`，且 `node {{TASK_DOC_CMD}} check --file <任务单>` 通过；
- `PROJECT_DESIGN.md` 版本与实现一致。

---

## 7. 额度纪律

- 设计 Agent 只在 C/D 类调用，且一个任务一次设计调用；增量设计不要重写整篇架构。
- A/B 类不调用设计 Agent，也不要为了「更稳」额外 spawn。
- 子 Agent 用 `fork_turns="none"`，减少上下文复制。
- 验收只读必要文件与 diff，不重读整个仓库；高风险任务除外。
- 不要用多次模型调用替代一次清晰的思考。
