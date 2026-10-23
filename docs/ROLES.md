# 角色与模型映射

**简体中文** | [English](ROLES.en.md) · [技能流程](SKILLS.md)

> 原则：**角色固定、模型可替换**。设计模型在角色映射，主控与执行者各自使用Codex和DSH原生配置。

## 1. 当前映射

| 角色标识 | 职责 | 当前模型 | 配置位置 |
| --- | --- | --- | --- |
| `project_coordinator` | 用户沟通、编排、验收 | 用户当前Codex模型 | Codex当前会话与提供方设置 |
| `architecture_designer` | 架构设计、接口契约、疑难诊断 | `gpt-6-astra`（`reasoning_effort=high`） | `codex/roles.json` → 渲染到 `~/.codex/agents/architecture_designer.toml` |
| `development_executor` | 开发、自测、修复 | 由 DSH 自身设置决定 | DSH 的 `settings.yaml`，不在 Codex 侧 |
| `quality_reviewer` | 独立验收 | 跟随主控（同一会话内完成） | 不需要单独配置 |

评审角色目前不单独建模型实例：它复用主控的会话与上下文，成本最低。若将来要独立评审模型，
新增一个 `[agents."quality_reviewer"]` + 对应 TOML 即可，Skill 第 4 步只需改成调用该 `agent_type`。

## 2. 已核实的 Codex 能力（验证时版本 0.163.0-alpha.10.2，以本机实际版本为准）

| 能力 | 结论 | 依据 |
| --- | --- | --- |
| 自定义 Agent 角色 | 支持 | `config.toml` 的 `[agents."<name>"]`（`description` / `config_file` / `nickname_candidates`） |
| 角色级模型 | 支持 | 角色 TOML 内的 `model`、`model_reasoning_effort` |
| 子 Agent 选择角色 | 支持 | `spawn_agent` 的 `agent_type` 参数；未知角色报 `unknown agent_type` |
| 子 Agent 临时换模型 | 支持 | `spawn_agent` 的 `model` 参数（平台建议默认继承，不随意覆盖） |
| 只读权限 | 未提供角色级沙箱 | 子 Agent 继承会话沙箱；设计角色的只读靠指令约束 + 验收检查，不是进程级隔离 |
| 模型可用性 | 取决于账号、提供方和配置 | 安装器只能提供本机存在性警告，不能授予模型访问 |
| 角色加载校验 | 支持 | `codex doctor` 输出 `Ignoring malformed agent role definition` |

昵称格式及角色工具字段以实际Codex版本为准；配置文件存在不代表账号一定可使用所选模型。设计角色“只读”是指令约束，不是独立的进程沙箱。

## 3. 升级模型（三分钟流程）

1. 编辑 `codex/roles.json`：

   ```json
   "architecture_designer": { "model": "gpt-7-xxx", "reasoning_effort": "high" }
   ```

2. 重新安装：

   ```bash
   node install-codex.mjs
   ```

3. 验证（Codex 不在 `PATH` 时用 `--codex-bin` / `CODEX_BIN` 显式指定）：

   ```bash
   node install-codex.mjs --check      # 退出码 0 表示角色 / 技能 / 规则块均为最新
   CODEX="$(command -v codex)"
   [ -n "$CODEX" ] && "$CODEX" doctor | grep -i "agent role"
   ```

   没有针对 `architecture_designer` 的 malformed 警告即为加载成功。

4. 冒烟：新建 Codex 会话，说「用设计 Agent 做一个只读的架构评审」，确认子 Agent 能起来并返回设计包。

**不需要改**：`multi-agent-development` Skill、`dsh-bridge`、任务协议、验收规则、设计基线。

## 4. 其他角色的模型替换

| 想替换 | 改哪里 | 注意 |
| --- | --- | --- |
| 主控模型 | `~/.codex/config.toml` 的 `model` | 这是用户全局默认，会影响所有会话；不属于本系统自动修改范围 |
| 设计模型 | `codex/roles.json` + 重装 | 只影响设计角色 |
| 执行模型 | DSH 的 `settings.yaml`（`agent-default-model`） | Bridge 不感知模型名 |
| 评审模型 | 新增 `[agents."quality_reviewer"]` + 改 Skill 第 4 步 | 当前默认复用主控，无需配置 |

## 5. 成本边界

- Codex用量取决于用户的认证方式、账号、提供方和模型；不能对所有使用者承诺某种订阅必定包含设计调用或绝无API计费。
- DSH用量遵循其本机提供方配置。简短回传能减少部分主控上下文，但DSH历史重放与修复仍会产生用量。
- 本插件尚无统一的总成本、速度或成功率基准；需要统计Codex与DSH两侧实际记录再比较。

## 6. 失败时的可理解错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `unknown agent_type 'architecture_designer'` | 角色未安装或被忽略 | 重跑安装；`codex doctor` 看 malformed 警告（Codex 不在 PATH 时先设置 `CODEX_BIN`） |
| 设计子 Agent 起不来 / 模型不可用 | 模型不在当前账号可用范围 | 换 `roles.json` 里的模型并重装 |
| 子 Agent 能起但没按设计角色说话 | 角色 TOML 未生效 | 检查 `config_file` 路径与 `model` 字段 |
| 设计子 Agent 想改代码 | 平台没有角色级只读沙箱 | 由 Skill 约束 + 主控验收拦截；见「已知限制」 |
