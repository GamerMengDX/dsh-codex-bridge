# 使用说明：Codex Desktop 中的多 Agent 开发流程

**简体中文** | [English](USAGE.en.md) · [技能流程](SKILLS.md)

> 下文用 `<bridge>` 代指桥接目录（clone/解压到哪就是哪，路径可含空格与中文）。
> 想省事就先 `cd <bridge>`；不 cd 也能用，只要把命令里的 `<bridge>` 换成绝对路径。

## 1. 安装（一次）

```bash
cd <bridge>
node install-codex.mjs            # 安装角色、技能、全局规则；自动备份
node install-codex.mjs --check    # 之后随时检查是否最新（未安装/需更新时退出码 1）
node install-codex.mjs --dry-run  # 只看要改什么，不落盘
```

安装内容：

- `<Codex home>/agents/architecture_designer.toml` —— 设计角色（模型来自 `codex/roles.json`）
- `<Codex home>/config.toml` 的 `[agents."architecture_designer"]` 段
- `<Codex home>/skills/multi-agent-development/SKILL.md`
- `<Codex home>/skills/dsh-bridge/SKILL.md`（里面的桥接入口已替换为本机真实路径）
- `<Codex home>/AGENTS.md` 的规则块（标记内；跨版本升级是替换，不会重复追加）
- `<Codex home>/.dsh-codex-bridge-install.json` 安装记录（路径 + 内容哈希，不含秘密）

`<Codex home>` 默认是 `$CODEX_HOME` 或 `~/.codex`，可用 `--codex-home` 指定。
Codex 可执行文件默认从 `PATH` 发现，也可用 `--codex-bin` 或 `CODEX_BIN` 指定。

不会改动：默认模型、登录方式、其他 MCP server、其他 agent 角色、computer-use 开关、凭据。

可选：把 DSH 注册成 Codex 的一等 MCP 工具。GUI 启动的 Codex 不继承 shell 环境，
所以非秘密的 DSH 路径覆盖会被持久化进 `[mcp_servers.dsh.env]`：

```bash
node apply-config.mjs          # 写入 ~/.codex/config.toml（自动备份）
node apply-config.mjs --check  # 未注册 / 过期 / 路径无效时退出码 1
```

安装后**重启 Codex Desktop**（或新开一个会话），让配置与 Skill 生效。

## 2. 验证

```bash
cd <bridge>
node install-codex.mjs --check     # 期望退出码 0

# Codex 不在 PATH 时显式指定（macOS 应用内置 CLI 的常见位置）
CODEX="$(command -v codex || echo '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')"
"$CODEX" doctor | grep -i "agent role"   # 不应出现 architecture_designer
```

不想开终端也可以：重启 Codex Desktop 后直接问它
「列出你当前加载的 skills，以及有没有 architecture_designer 这个子 Agent」。

## 3. 怎么用

直接对 Codex 说需求即可，协作流程由 Skill 自动接管：

- **简单任务**（改文案、样式、小 bug）：主控直接做，不调设计 Agent。
- **设计内功能**：主控读 `docs/architecture/PROJECT_DESIGN.md` → 委派 DSH → 验收。
- **需要设计**：主控调用 `architecture_designer` → 你确认设计 → DSH 实现 → 验收。
- **高风险**：设计 Agent 先出方案与风险评估 → 你确认 → 分步实施。

你只需要在两类节点介入：**设计确认**和**高风险授权**。其余由主控编排。

## 4. 项目侧准备

业务项目**不需要**复制桥接的 `scripts/` 或 `lib/`：任务单工具就在桥接目录里，
在项目目录里执行即可：

```bash
cd <你的项目>
export BRIDGE="<bridge>"          # 换成桥接目录的绝对路径
mkdir -p docs/architecture/TASKS
cp "$BRIDGE/docs/templates/architecture/PROJECT_DESIGN.md" docs/architecture/
cp "$BRIDGE/docs/templates/architecture/DECISIONS.md" docs/architecture/
cp "$BRIDGE/docs/templates/architecture/REVIEW-TEMPLATE.md" docs/architecture/
node "$BRIDGE/scripts/task-doc.mjs" new --id T-001 --class C --goal "首个功能目标"
```

任务单状态由流程推进：

```bash
node "$BRIDGE/scripts/task-doc.mjs" set-state --file docs/architecture/TASKS/T-001.md --state designing
node "$BRIDGE/scripts/task-doc.mjs" check --file docs/architecture/TASKS/T-001.md
```

非法跳转会被拒绝（状态机在 `lib/workflow.mjs`）。

任务单可写 `permission: standard | strict`：默认 `standard`（允许任务必需的系统临时文件）；
只有你明确要求「所有写入只在该目录」时才用 `strict`，且此时必须先确认沙箱能否强制。

## 5. 示例任务（跑通全链路）

> 我在做一个「命令行书签管理器」，Node.js + 本地 JSON 存储。
> 请按多 Agent 流程来做：先让设计 Agent 给出架构与接口契约（含数据模型、错误语义、验收标准），
> 我确认后再让 DSH 实现，最后你自己验收并给我结果。
> 要求：只读分析阶段不要改文件；实现阶段允许改 `src/` 和 `tests/`，不要动 `docs/`。

预期观察：

1. 主控判定为 C 类，创建任务单与设计基线。
2. 调用 `agent_type="architecture_designer"`，返回设计包。
3. 主控向你确认设计（这是你需要回复的地方）。
4. 主控用 `dsh_task(mode="edit", session="bookmark-cli")` 委派实现。
5. 主控自己跑测试、看 diff、对照设计验收。
6. 通过 → `passed` → `delivered`；失败 → 交回 DSH（最多两轮）→ 仍失败则升级设计 Agent。

## 6. 升级 / 迁移 / 卸载

```bash
cd <bridge>
# 升级：同一组命令，可反复执行（幂等；跨版本规则块会被替换）
node install-codex.mjs && node apply-config.mjs

# 迁移：整个目录复制到新位置后，从新目录重新执行上面两条命令
# 已安装的 Skill、规则块、MCP 配置里的路径会跟着更新

# 卸载：只移除本插件写的内容；你后来改过的会保留并报冲突
node apply-config.mjs --uninstall
node install-codex.mjs --uninstall
```

卸载行为：

- 本插件安装的文件：删除；安装前就存在的同名文件：恢复原内容。
- 安装后被**你自己改过**的文件或段：保留，输出「冲突」，退出码 1。
- 不删除：`auth.json`、默认模型/provider、其他 MCP server、其他 agent 角色、
  `AGENTS.md` 里标记外的用户文字、DSH 会话与凭据。
- 重复卸载安全（没有本插件内容时返回 0）。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| 主控没有调用设计 Agent | 明确说「这是 C 类，请先用设计 Agent」；或检查 Skill 是否被加载 |
| `unknown agent_type` | 重跑 `node install-codex.mjs`，再用 `codex doctor` 检查 |
| DSH 调用失败 | `"<bridge>/dsh-run" -g "只回复 OK"`（或 `node <bridge>/dsh-task.mjs ...`）先验证 Bridge 本身 |
| 报「找不到 DSH 入口」 | 设 `DSH_BIN=/绝对路径/@deepseek-ai/dsh/lib/bin.js` 或 `DSH_CLI_ROOT=<DSH 安装根目录>`；见 README「DSH 与 Node 的发现顺序」 |
| 想回看 DSH 这次到底收到了什么 | `node "<bridge>/scripts/trace.mjs" list` 拿到 taskId 与 sessionId；轨迹在 `$DSH_HOST_ROOT/trace/` |
| 工具表里没有 `dsh_task` | 当前 Codex 配置未注册 dsh MCP；Skill 会自动走 CLI。需要 MCP 时执行 `node apply-config.mjs` 并重启 Codex |
| `apply-config.mjs --check` 退出码 1 | 看输出里的原因：未注册 / 路径过期 / node 或 DSH 找不到，按提示重跑对应命令 |
| 设计 Agent 想直接改代码 | 平台没有角色级只读；主控应在验收时拦截，并在设计任务里写明「只输出设计包」 |
| 任务卡在同一错误 | 两轮无进展就要求升级设计 Agent 或停下让你决策 |

## 8. 相关文档

- 角色与模型升级：[ROLES.md](ROLES.md)
- 设计基线模板：[templates/architecture/](templates/architecture/)
- Bridge 自身说明：[../README.md](../README.md)
- 变更记录：[../CHANGELOG.md](../CHANGELOG.md)
