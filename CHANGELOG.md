# 变更记录

**简体中文** | [English](CHANGELOG.en.md)

## v2.2.4 — 中英双语公开版（2026-10-23）

- 补齐中英文总览、安装使用、角色、技能流程、架构和打包说明，并加入语言导航。
- 关键源码增加成对英文解释备注，运行逻辑、提示词、报告字段、权限及会话语义保持不变；用语法树和shell非注释内容复核。
- 保留DSH与Codex专用定位、MIT署名“残梦”，以及DeepSeek V4.1 Flash主导/GPT 6.1 sol辅助开发署名。
- 说明文档双语与原中文运行协议的边界；历史真实DSH记录与本轮离线检查分开标注。
- 公开树和发行资产排除本机凭据、运行数据和原始私有审阅材料。

## v2.2.3 — 可移植性与安装修复（2026-10-23）

主题：把这个插件从「能在一台开发机上跑」修成「换机器、换目录、可升级、可安全卸载」。
执行协议、数据模型、DSH 专用分工一律未动（`lib/runner.mjs`、`lib/host.mjs`、`lib/protocol.mjs`、
`lib/session-lane.mjs`、`lib/registry.mjs`、`lib/trace.mjs`、`lib/workflow.mjs`、`patches/` 均未修改）。

发布准备补充：用户确认采用MIT许可证、署名“残梦”；已加入完整LICENSE，并同步包信息与README。模型开发署名保留。

### 修复的缺陷

- `dsh-run` 里写死 `/usr/local/bin/node` 与开发者原始目录：现按**自身位置**定位同目录的 `dsh-task.mjs`，
  node 走 `DSH_NODE` → `PATH`；整个目录可复制到含空格/中文的任意路径运行。
- `lib/config.mjs` 三个默认值固定个人路径：改为
  DSH 入口自动发现（`DSH_BIN` / `DSH_CLI_ROOT` / `PATH` / 全局 `node_modules`）、
  DSH home 与 host 根目录落到 `~/.dsh-codex-bridge/`、默认 cwd 落到用户目录；发现不到时给出配置指引。
- 生成的 MCP 配置没有持久化非秘密 DSH 路径，GUI 启动的 Codex 继承不到 shell 环境：
  现在写入 `[mcp_servers.dsh.env]`（白名单 + TOML 转义，永不导出 `process.env`、永不写 API key）。
- `apply-config.mjs --check` 未注册/过期也返回 0：现在未注册、路径过期、node/DSH 不存在都返回 1。
- `install-codex.mjs` 的 `VERSION=2.2.0` 与单一版本标记匹配：版本统一取 `package.json`；
  规则块改用稳定标识 `<!-- dsh-multi-agent:begin -->`，完整 v2.2.0/v2.2.2 历史块升级后只保留一块；
  不成对标记会安全拒绝写入，保留用户文字。
- 没有卸载：`install-codex.mjs --uninstall` 与 `apply-config.mjs --uninstall` 通过安装记录
  （`<Codex home>/.dsh-codex-bridge-install.json`，只存路径/哈希/备份引用）区分归属，
  删除本插件内容或恢复安装前的原内容；用户后改内容保留并报冲突；重复卸载安全。
- 技能里 `scripts/task-doc.mjs` 相对业务项目的路径无效：源 Skill 的命令使用 `{{DSH_RUN_CMD}}` / `{{TASK_DOC_CMD}}`
  占位符，安装时替换为安全引用的本机真实路径；文档里的 `node dsh-run` 写法一并改正。
- 配置更新采用有词法状态的扫描和字段补丁，保留尾注释、quoted keys、多行字符串、用户额外选项及 env；
  无法安全拆分的目标表示在写入前拒绝。补充路径别名、引号转义、备份缺失、记录缺失和冲突恢复的保护。

### 修改文件

| 文件 | 改动 |
| --- | --- |
| `dsh-run` | 按 `$0` 定位副本；node 走 `DSH_NODE`/`PATH`；缺 node 时给出可操作错误（POSIX sh） |
| `lib/config.mjs` | 可移植默认值（`~/.dsh-codex-bridge/{dsh-home,host}`、用户目录默认 cwd）；DSH/Node 发现与缺失提示；凭据查找更通用 |
| `lib/agents-block.mjs`（新增） | 规则块标记解析/替换/清理，处理多块与不成对标记，只动接缝空行 |
| `lib/install-manifest.mjs`（新增） | 安装记录读写、备份（600）、归属判定与释放、空目录清理 |
| `lib/toml-sections.mjs`（新增） | 有状态扫描、键路径解码与源码区间，供配置字段补丁使用 |
| `apply-config.mjs` | env 持久化、`--check` 真实退出码、`--uninstall`、`--dry-run`、`--codex-home`、computer-use 状态可恢复 |
| `install-codex.mjs` | 版本取 package.json、稳定规则块、Codex 发现（`--codex-bin`/`PATH`）、`--uninstall`、安装记录、冲突报告 |
| `server.mjs` | 仅版本显示改为读 `package.json` |
| `package.json` | 版本 2.2.3；测试脚本纳入安装/路径回刷测试 |
| `skill/SKILL.md`、`codex/skills/multi-agent-development/SKILL.md`、`codex/AGENTS.md.part` | 开发者路径改为占位符；任务单工具指向桥接目录；补充迁移后更新说明 |
| `config-snippet.toml` | 改为通用模板（占位符 + env 子表 + 转义提示），无个人路径 |
| `README.md`、`docs/USAGE.md`、`docs/ROLES.md`、`PACKAGE-NOTES.md` | 安装/升级/迁移/卸载/发现顺序/验证范围更新；保留 DSH 专用定位与开发署名 |
| `tests/install.test.mjs` | 更新备份命名断言；新增跨版本规则块、不成对标记、迁移重装、卸载恢复/冲突/重复卸载回归 |
| `tests/apply-config.test.mjs`（新增） | MCP 注册、env 持久化、TOML 转义、`--check` 退出码、卸载恢复/冲突、`--no-computer-use` |
| `tests/portable.test.mjs`（新增） | 复制到含空格/中文目录后 `dsh-run` 执行副本；DSH/Node 发现与缺失诊断；MCP 路径随迁移更新；文档/源码路径体检 |
| `tests/helpers/fixtures.mjs`（新增） | 临时目录、桥接副本、假 Codex home、离线 DSH fixture、干净环境运行器 |

### 测试

- 主控独立运行 `npm test`：151/151 通过；另有13项独立验收全部通过，并由独立 `tomllib` 校验配置。
- 原有协议、会话、追踪等测试保留，安装回归按修复后的安全契约更新，并新增扫描与卸载保护测试。
- 回归全部离线：临时假 Codex home + 离线 DSH fixture + 复制到含空格/中文的临时目录；
  不访问真实 `~/.codex`/`~/.dsh`，不读真实 key，不调用真实模型。
- 未验证：Windows 上的 `dsh-run`（POSIX sh）与 DSH 沙箱/执行器行为；真实 `codex doctor` 校验路径
  （需要本机 Codex，测试里以 `--no-doctor` 跳过）。


## v2.2.2 — 权限与验收规范调整（2026-10-20）

上一轮把「任何目录外写入」都判为失败，包括 DSH 为哈希比对在 `/tmp` 创建并在任务内删除的临时文件。
用户重新评估后确认：标准开发任务应当允许任务必需的临时文件，真正要守的是「不越权改其他项目/配置/持久数据」。

### 规则变化

- **两种模式**：标准开发（默认，允许任务必需的系统临时文件）与严格隔离（按需，只有用户明确要求时才用）。
- 标准模式禁止项不变：其他项目、全局配置与凭据、与任务无关的持久文件、未授权的 push/部署/破坏性迁移；
  也不得删除不属于本次任务的临时文件。
- 临时文件要求：安全创建（唯一命名/避免跟随符号链接）、任务结束清理、清理失败必须如实报告。
- **验收不得仅因合理临时文件判失败**；判断依据是业务改动范围、测试证据与实际副作用。
- **严格隔离**：当前 `workspace-write` = `cwd` + 系统临时目录，不等于 cwd-only；Bridge 没有更强档位，
  必须报告限制而不是承诺已隔离。

### 修改文件

| 文件 | 改动 |
| --- | --- |
| `codex/skills/multi-agent-development/SKILL.md` | 新增 §3.1 权限与临时文件（标准/严格）；删除「临时文件只能写 cwd」的一刀切规则；验收增加副作用与严格隔离检查；验收记录指向模板 |
| `skill/SKILL.md` | 权限节改为三层表（任务约束 / 沙箱实际可写 / 网络），明确 `edit` 的系统临时目录授权 |
| `codex/AGENTS.md.part` | 增加两条：标准 edit 允许必要临时文件；严格隔离需先确认沙箱能力 |
| `docs/architecture/TASKS/TEMPLATE.md` | front matter 增加 `permission: standard`；新增「权限与边界」段 |
| `docs/architecture/REVIEW-TEMPLATE.md`（新增） | 三态结论、副作用与写入边界、审计范围 |
| `lib/workflow.mjs` | `renderTaskDoc` 支持 `permission`；校验 `standard/strict`；模板加权限段 |
| `README.md` | 权限模型改为三层表 + 两种任务模式 + 三个易误判点 |
| `docs/USAGE.md` | 引入验收模板与 permission 说明 |
| `docs/history/REVIEW-2026-10-20-wechat-todo.md`（新增） | 上一轮 REVIEW 的存档副本（含追加说明），防止临时目录被清理后丢失证据 |
| `package.json` | 版本 2.2.2；测试脚本纳入 docs-consistency |

### 历史记录

- 原 `/private/tmp/wechat-todo-loop.UiQ2LM/review/REVIEW.md` **未改写**，仅在末尾追加「后续说明」：
  原始 `failed` 保留，明确该行为属约束违约、非沙箱逃逸，新规范下不再阻断后续普通开发任务。
- 同时把带追加说明的完整副本存入 `docs/history/`，避免临时目录被系统清理后证据丢失。

### 测试

- 新增 7 个测试（文档一致性 6 + 任务单 permission 1），总计 **78 通过**。
- `install-codex.mjs --check` 退出 0；`codex doctor` 解析 ok、无本系统角色告警；
  默认模型 `gpt-6.1-sol` 未变；MCP 表数量未变（6）。


## v2.2.1 — 会话可见性与调用追踪（2026-10-20）

来自第二轮实机测试的反馈：DSH 报告可疑时，无法回答「这条指令是哪个会话、什么时候跑的」；
同时 `execution/result` 放在 MCP `_meta` 里，模型看不到。

### 修复

- **状态进正文**：`execution` / `result` / `warnings` 在不理想时压成一行
  `[dsh: execution=... result=... warnings=N]` 放进工具返回正文；正常完成不附加（不花额外 token）。
  `_meta` 保留，供客户端使用。
- **taskId + 轨迹**：每次调用生成 8 位 `taskId`；写 `.dsh-host/trace/<taskId>.json`
  （goal 截断 + 哈希、cwd、mode、sessionId、execution、result、warnings、耗时），保留最近 200 条。
- **one-shot 会话反查**：运行前后对比 `$DSH_HOME/sessions` 目录增量，识别本次 DSH 会话 id；
  仅当恰好新增一个时认领，避免并发误认。
- **来源标记**：prompt 首行带 `（Codex 任务 <taskId>）`，会话内容可追溯。
- **查看工具**：`node scripts/trace.mjs list|show`。

### 测试

- 新增 9 个单元测试（trace 7 + prompt 标记 2），总计 **68 通过**。
- 实机验证：一次真实调用返回 `taskId=5bf5c155`、`sessionId=session-9eda6478-…`，
  `trace list` 可查；超时路径验证状态行进入正文。

### 边界

- 会话仍不会出现在 DSH Desktop GUI（home 不同）；共享桌面 home 有双进程写同一状态的风险，未采用。


## v2.2.0 — 多 Agent 协作系统（2026-10-20）

在 v2.1.0 稳定桥接之上增加一层**角色协作**，不改 Bridge 协议与权限机制。

### 新增

| 文件 | 作用 |
| --- | --- |
| `codex/roles.json` | 角色 → 模型映射的唯一来源，升级模型只改这里 |
| `codex/agents/architecture_designer.toml.tmpl` | 设计角色模板（模型占位符由安装器渲染） |
| `codex/skills/multi-agent-development/SKILL.md` | 协作主流程：分类 → 设计 → 实施 → 验收 → 升级 |
| `codex/AGENTS.md.part` | 精简全局规则（不含模型名） |
| `install-codex.mjs` | 幂等安装器：备份、合并 `[agents]` 段、装 Skill、写规则块、`--check` |
| `lib/workflow.mjs` | 状态机、任务分类、升级预算、任务单校验（可单测） |
| `scripts/task-doc.mjs` | 任务交接单 `new` / `check` / `set-state`，非法跳转报错 |
| `docs/ROLES.md` / `docs/USAGE.md` | 模型升级说明、使用说明 |
| `docs/architecture/*` | PROJECT_DESIGN / DECISIONS / TASKS 模板 |

### 平台核实（Codex 0.163.0-alpha.10.2）

- 支持 `[agents."<name>"]`（`description` / `config_file` / `nickname_candidates`）。
- 角色 TOML 支持 `model` 与 `model_reasoning_effort`。
- `spawn_agent` 支持 `agent_type` 选择角色；未知角色报 `unknown agent_type`。
- `nickname_candidates` 仅允许 ASCII；本机 `ID导演.toml`、`花絮导演.toml` 因中文昵称被忽略（未改动）。

### 测试

- 新增 18 个单元测试（workflow 10 + installer 8），总计 **57 个单元测试全部通过**。
- 安装后校验：`install-codex.mjs --check` 退出 0；`codex doctor` 对 `architecture_designer` 无告警；
  默认模型仍为 `gpt-6.1-sol`，MCP server 数量不变。
- 未执行：真实调用设计子 Agent（会消耗 Plus 额度），见 README「已知限制」。

### 未改动的部分

Bridge 核心（`lib/host.mjs`、`lib/runner.mjs`、`lib/protocol.mjs`、`patches/*`）未修改；
`dsh-bridge` Skill 只加了一节「在多 Agent 流程中的位置」。

---

## v2.1.0 — 可靠性加固

日期：2026-10-20
范围：并发安全、任务生命周期、权限边界、接口一致性
性质：内部可信度加固，保留 MCP + CLI 双通道与可选持久会话

---

## 1. 摘要

这一轮不是加功能，而是把桥接从「能跑」修到「可靠」：同一个会话不会再有第二个任务覆盖第一个任务的等待者；超时不会假装任务已停止；会话 ID 不再因字符替换而碰撞；权限边界从「文档声明」变成「实测矩阵」。

规模：新增 4 个模块、6 个测试文件；核心执行路径重写（`lib/host.mjs`、`lib/runner.mjs`）。
测试：39 个单元测试 + 7 个真实 DSH 集成测试，全部通过。

---

## 2. 问题与修复

### 2.1 P0：Session 并发结果关联

**原问题**：`Host.prompt()` 用 `this.waiters.set(sessionId, …)` 保存等待者。同一会话在前一个任务未结束时再次提交，新等待者会覆盖旧的，造成结果归属错误、Promise 悬挂或超时误报。

**修复**：

- 新增 `lib/session-lane.mjs`：每个 `sessionId` 一条串行 promise 链（`SessionLane`），任务严格排队；前一个失败不阻断后一个。
- 等待者按会话唯一，且串行保证了任意时刻每个会话只有一个是活跃的。
- 结果关联改用 DSH 事件里的自增 turn 号：建会话时用 `session.history` 播种最大 turn，之后 `expected = max + 1`；`turn/end` 必须匹配，否则忽略并记录日志。历史不可用时降级为「prompt 之后第一个 turn/end」并留痕。
- 所有收尾走 `settle()` 幂等守卫：重复的 `turn/end`、多次错误、host 退出都不会二次完成同一个 Promise。
- 不同会话各自一条车道，事件按 `sessionId` 分发，互不阻塞、不串话。
- 首次并发调用 `ensureHost()` 会合流（`hostStarting`），避免两个 Host 实例抢同一个端口。

**验证**：两个任务同时提交同一 session，6.7s 内串行完成且各自拿到自己的结果；跨会话任务并行完成。

### 2.2 P0：沙箱权限边界

**核对结论**（代码 + 实测）：

- headless 用 `--patch` 注入 overlay；`dsh web` 子命令拒绝 `--patch`，续接模式把 overlay 写进各自 home 的 `profiles/web/cordis.patch.yml`。
- `settings.yaml` 的 `permission.defaultPreset` 会在建会话时把沙箱模式钉进事件流，覆盖 `DSH_PERMISSION_MODE`。因此 overlay 把**所有预设名**都映射到目标模式，无论 settings 里写的是哪个名字。
- `workspace-write` 的授权范围是 `cwd` + `/tmp` + `tmpdir()`（`dsh-sandbox-local` 源码中的 `readWrite.push('/tmp', policy.workspaceRoot)`）。
- 常驻 host 的进程 cwd 是 `HOST_ROOT`，但 `session.create` 的 `cwd` 才是该会话的 `workspaceRoot`。已用「写 `HOST_ROOT` 被拒绝、写 session cwd 成功」证明绑定关系。
- 文件沙箱**不限制网络**；`analyze` 下 `curl https://example.com` 返回 200。

**纠正一处误判**：第一轮探测把外部写入目标放在 `/tmp`，得出「edit 越界成功」的结论。实际 `/tmp` 是设计内可写区，不是逃逸。改用非临时路径后，绝对路径、符号链接、子进程三种外部写入全部 `EPERM`。该陷阱已写进 README 与集成测试注释。

### 2.3 P1：超时与取消

**原问题**：超时只删除等待者并返回错误，DSH 侧任务可能仍在跑，且返回值无法区分「已停止」和「没停下来」。

**修复**：

- 会话超时 → `session.cancel` → 等待 `turn/end(aborted)` 或 `host/session-status(false)`；确认后才返回 `timeout`，并注明「已取消」。
- 未确认 → `execution_unknown`，同时把该会话置脏；后续提交直接拒绝（`DirtySessionError`），避免在可能仍在写入的会话上叠加修改任务。
- 状态词汇统一为 `completed / failed / timeout / cancelled / execution_unknown`；报告侧另有 `result: success / partial / failed / unknown`。
- headless 超时按**进程组**清理（`spawn(detached: true)` + `process.kill(-pid)`），并区分「确认退出」与「硬超时未确认」：后者报 `execution_unknown`，不谎称已停止。
- 空结果、非零退出、契约缺段分别有独立处理分支，不再混为一谈。

**验证**：`sleep 60` + `timeout_s=15` → 15.1s 返回 `timeout`，取消确认；随后同一会话 2.5s 成功，DSH 报告上一轮工具调用被中断。

### 2.4 P1：Session 标签冲突与恢复

**原问题**：`slugLabel()` 把特殊字符统一替换成 `-`，`proj_a`、`proj a`、`proj-a` 会生成同一个 ID；注册表写入非原子；`cwd` 未做真实路径规范化。

**修复**：

- 新 ID：`bridge-<mode>-<slug>-<hash8>`，`hash8 = sha256(label)` 前 8 位；可读前缀保留（含中文）。
- 旧版无哈希 ID 不丢弃：按 `label + mode` 命中已有条目后继续使用（`idMigrated` 标记），历史可续。
- `sessions.json` 改为「加锁 + 临时文件 + rename」原子写入，文件 600、目录 700；损坏时改名备份（`.corrupt-<ts>`），不静默清空。
- `cwd` 统一 `realpathSync` 规范化；只按真实路径比较。旧条目存了未解析符号链接的路径（如 macOS `/var` → `/private/var`）时就地迁移，真正不同才拒绝。
- 绑定校验保留：一个标签只能绑定一个 cwd，换目录直接报错。
- 端口身份用 pidfile 校验：端口被非本桥接进程占用时报错，不误连其它权限的 host。

**验证**：单元测试覆盖三种易混标签、旧 ID 迁移、损坏恢复、权限位；集成测试覆盖 host 重启后冷恢复。

### 2.5 P1：接口一致性

| 问题 | 处理 |
| --- | --- |
| `--files` 用逗号切分，破坏含逗号的合法路径 | 每个 `--files` 只接受一个路径，可重复；不切分。`protocol.mjs` 的字符串数组也只按换行切 |
| 非法 `mode` 静默回退 `analyze` | 改为显式报错，避免悄悄改变调用者意图 |
| `AGENTS-snippet.md` 仍说「会话无法复用」 | 更新为「可选持久会话 + 续接前重新确认文件是否被外部修改」 |
| MCP 与 CLI 语义可能漂移 | 两者共用 `normalizeInput` + `runTask` + 契约检查；CLI 的 `--json` 与 MCP 的 `_meta` 字段一致 |
| 大产物与 analyze 只读冲突 | 明确：`analyze` 不能写报告文件；需要落盘只能用 `edit` 在 cwd 内写 |

### 2.6 P2：报告质量检查

`validateResult()` 从「查 7 个标题」升级为三件可机器判定的事：

- **结构**：七段是否齐全（行首锚定，容忍 `**任务状态**：` 这类 Markdown 修饰）。
- **状态**：解析「任务状态」为 `success / partial / failed / unknown`，失败不会被当成成功。
- **证据**：`发现问题` 非「无」却缺 `位置：`、`验证情况` 没有命令/路径/退出码等可复核线索、输出被截断，分别给出 warning；`发现问题：无` 不误报。
- 不伪造内容：缺段只加 `⚠︎` 前缀后附原文。

### 2.7 P2：流式输出与内存

- headless 的 stdout 改为 head + tail 双缓冲：内存上限 = `MAX_OUTPUT` + 4KB；超出部分保留头尾并写入 `…[中间省略 N 字符，共 M 字符]…`，不静默丢内容。
- 截断会同时置 `truncated=true`、`contractOk=false`，并加「输出被截断，报告可能不完整」warning。
- 多字节字符用 `StringDecoder` 解码，块边界不会出现乱码。

### 2.8 P2：安装与环境兼容

- `apply-config.mjs` 会探测 node、校验 `server.mjs` 与 DSH 入口是否存在，不存在则明确报错。
- 已注册但 `command/args/cwd` 过期时就地替换（先备份），不再「存在即跳过」。
- 只维护 `[mcp_servers.dsh]` 一段；不改模型、登录方式、其他 MCP server。
- **不再默认关闭 computer-use**；只有显式 `--no-computer-use` 才动。
- `--check` 纯只读，并提示配置文件权限过宽。
- 路径尽量由 `import.meta.url` 推导；机器相关的 DSH 安装路径仍是默认值，可用环境变量覆盖。

---

## 3. 关键设计（便于后续维护）

### 3.1 一个任务的完整生命周期

```
runTask
  └─ session? ── 否 ─→ headless：spawn 进程组 → 流式捕获 → 超时杀组
       └─ 是 ─→ ensureSession（ID/绑定/锁）
                 → ensureHost（按模式，去重启动）
                 → session.create（幂等）
                 → SessionLane.run（串行）
                      → session.history 播种 turn
                      → session.prompt
                      → 等 turn/end 或空闲信号
                      → 超时：cancel → 确认 / 置脏
                 → 契约检查 → execution/result/warnings
```

### 3.2 事件订阅

| 通道 | 用途 |
| --- | --- |
| `ws://…/api/events.mux` | `turn/start`、`turn/end`、`assistant/message` |
| `ws://…/api/events.host` | `host/session-status`（空闲信号）、`host/agent-error` |

`turn/end.reason.kind` 决定结果：`completed`、`max-tokens`（截断）、`aborted`（超时/取消）、`blocked`、`error`。

### 3.3 状态词汇

| 字段 | 取值 |
| --- | --- |
| `execution` | `completed` / `failed` / `timeout` / `cancelled` / `execution_unknown` |
| `result` | `success` / `partial` / `failed` / `unknown` |
| `contractOk` | 七段齐全且未被截断 |
| `warnings` | 缺段、缺位置、缺证据、截断 |

---

## 4. 权限实测矩阵

环境：macOS，DSH 0.1.x，测试目录位于 `$TMPDIR` 与非临时目录。

| 后端 | 模式 | cwd 读 | cwd 写 | 非临时目录外写 | 符号链接穿透 | 子进程写 | `/tmp` 写 | 网络 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| headless | analyze | ✅ | ❌ EPERM | ❌ EPERM | ❌ EPERM | ❌ EPERM | ❌ EPERM | ✅ 200 |
| headless | edit | ✅ | ✅ | ❌ EPERM | ❌ EPERM | ❌ EPERM | ✅（设计内） | ✅ 200 |
| session | analyze | ✅ | ❌ EPERM | ❌ EPERM | 未单独测 | 同机制 | ❌ EPERM | ✅ |
| session | edit | ✅ | ✅ | ❌ EPERM | 未单独测 | — | ✅（设计内） | ✅ |

补充结论：

- session 的 workspace 绑定 `session.create` 的 cwd，不是 host 的进程 cwd（写 `HOST_ROOT` 被拒）。
- `edit` 的 `/tmp` 可写来自 DSH 的临时区授权，不是桥接放水。
- 网络完全不在文件沙箱内，「只读」不等于「无外部副作用」。

---

## 5. 测试

```bash
npm test                    # 39 个单元测试，不需要 DSH
npm run test:integration    # 7 个真实 DSH 集成测试，会消耗模型额度
```

| 套件 | 数量 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 单元（protocol / registry / session-lane / cli-args / capture） | 39 | 39 通过 | ~159ms |
| 集成（真实 DSH） | 7 | 7 通过 | ~52s |
| MCP 冒烟（initialize + tools/call） | 1 | 通过 | — |
| CLI 校验（非法 mode / 未知参数 / 缺 goal） | 3 | 均退出 64 | — |
| apply-config（注册 / 过期 / 更新 / Codex 解析） | 4 | 通过 | — |

集成覆盖：

1. headless analyze 只读
2. headless edit 边界
3. session edit 的 cwd 绑定（而非 HOST_ROOT）
4. session analyze 只读
5. 同会话并发提交
6. 超时取消 + 后续可用
7. 跨 host 重启恢复

**未覆盖**：多进程同时写注册表的锁竞争；`execution_unknown` 的端到端注入；Windows/Linux 路径行为。

---

## 6. 兼容性与行为变更

| 项目 | 影响 |
| --- | --- |
| `~/.codex/config.toml` | 未改动；`apply-config` 只在显式运行时写，且只维护一段 |
| DSH GUI / 全局配置 | 未改动；续接 host 独立 home、独立端口、pidfile 校验 |
| 现有 Session 数据 | 旧 ID 继续可用（按 label+mode 命中），未删除任何历史 |
| CLI 参数 | 标志全部保留 |
| `-f a,b` | **行为变更**：不再切成两个路径；多个文件请重复 `-f` |
| 非法 `mode` | **行为变更**：从静默回退改为报错（退出码 64） |
| `.dsh-host` | 权限收紧为 700/600 |

---

## 7. 已知风险

| 严重度 | 风险 | 说明 |
| --- | --- | --- |
| 高 | 网络不受沙箱约束 | `analyze` 仍可出网、发起写请求 |
| 中 | `/tmp` 在 edit 下可写 | DSH 设计如此；要「仅 cwd」需额外沙箱层 |
| 中 | 脏会话无自动恢复 | `execution_unknown` 后必须换标签 |
| 低 | 契约校验是启发式 | 能抓缺段/缺证据，不能证明结论为真 |
| 低 | 注册表多进程竞争未压测 | 已加锁 + 原子 rename，但未做 N 进程压测 |

---

## 8. 后续建议

1. 为 `analyze` 增加网络出口策略，并在集成测试中断言 `curl` 失败。
2. 脏会话自动恢复：重连后读 `session.history` 与 `session-status`，确认空闲则 `clearDirty`。
3. 多进程注册表压测（N 个 CLI 同时创建不同标签），验证无丢失更新。

---

## 9. 复现

```bash
cd /path/to/dsh-codex-bridge

# 单元测试
npm test

# 真实 DSH 集成测试（会消耗额度）
npm run test:integration

# MCP 注册状态
node apply-config.mjs --check

# 手动冒烟
./dsh-run -C /tmp -g "只回复 SMOKE-OK"
./dsh-run -s proj-x -C /tmp -g "只回复 SESSION-OK"
```
