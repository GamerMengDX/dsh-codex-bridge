# dsh-codex-bridge

**简体中文** | [English](README.en.md)

专门为 **DeepSeek Harness（DSH）与 Codex 协作开发**的桥接插件。

把本地 DSH 交给 Codex 的**可编程接口**：Codex 用一次结构化调用把任务交给 DSH，
只拿回一份可复核的结构化报告；不需要「截屏 → 找坐标 → 点击」的 computer use。

```
Codex ──dsh_task(MCP) / dsh-run(CLI)──┬─ 一次性：headless，跑完即退
                                      └─ 续接：常驻 dsh web + 固定 sessionId
                                              │
                                              └── DSH 文件策略：只读 / 工作区及系统临时位置
```

## 多 Agent 协作系统（v2.2.4）

Bridge 之上还有一层「角色协作」：主控（Codex）→ 设计（Codex 子 Agent）→ 执行（DSH）→ 主控验收。
角色名固定。设计角色模型在 `codex/roles.json`，主控沿用Codex配置，执行者沿用DSH配置；切换设计模型无需改任务协议。

```bash
node install-codex.mjs          # 安装角色 / Skill / 全局规则（自动备份）
node install-codex.mjs --check  # 校验是否最新
```

- 使用说明：[docs/USAGE.md](docs/USAGE.md)
- 角色与模型升级：[docs/ROLES.md](docs/ROLES.md)
- 两个技能与流程解释：[docs/SKILLS.md](docs/SKILLS.md)
- 架构与边界：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 英文说明：[Overview](README.en.md) · [Usage](docs/USAGE.en.md) · [Roles](docs/ROLES.en.md) · [Skills](docs/SKILLS.en.md)
- 设计基线模板：[docs/templates/architecture/](docs/templates/architecture/)
- 任务单工具：`node scripts/task-doc.mjs`

## 三条设计不变式

1. **自包含输入**：DSH 看不到 Codex 的对话，每轮都传全 goal / 权限 / 约束 / 验收标准。
2. **只回最终报告**：DSH 的搜索、试错、长输出都留在它自己的会话里。
3. **MCP 优先，CLI 等价**：两条通道共用同一个 `normalizeInput`、`runTask`、契约检查。

文档和关键代码注释已补齐中英文说明。现有操作型Skill指令、任务单标题、CLI消息和报告检查字段仍以中文为主；本版没有新增运行时语言开关。

## 历史实测记录（macOS，DSH 0.1.x）

下表为此前环境中的记录，不等于本次重新跑过真实DSH集成。当前MCP入口统一排队；后端会话车道的并发能力不能直接当作MCP入口并发。

| 能力 | 验证方式 | 结果 |
| --- | --- | --- |
| analyze 只读（headless / session） | 工作目录内写、`/tmp` 写、绝对路径、符号链接、子进程 `node -e` | 全部 `EPERM`，文件未创建 |
| edit 受控写入（headless / session） | 写 cwd、写非临时目录、经符号链接写、子进程写 | 授权工作区内成功；系统临时位置另有写入许可；所测非临时外部位置被拒绝 |
| 工作区绑定 | session 的 cwd ≠ HOST_ROOT 时写 HOST_ROOT | 被拒绝 → 绑定的是 session cwd |
| 同会话并发 | 两个任务同时提交同一 session | 串行完成，各自拿到自己的结果 |
| 跨会话并发 | analyze session 与另一 session 同时跑 | 互不阻塞、不串话 |
| 超时取消 | `sleep 60` + `timeout_s=15` | 15.1s 返回 `timeout`，cancel 确认，后续同会话 2.5s 成功 |
| 冷恢复 | 杀掉 host 重启后追问 | 仍能取回上一轮记住的数字 |
| 契约检查 | 缺段 / 问题缺位置 / 验证无证据 / 截断 | 分别给出 warning，且不伪造正文 |

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | MCP stdio server，暴露 `dsh_task` |
| `dsh-task.mjs` | CLI 入口（`dsh-run` 转发到它） |
| `lib/config.mjs` | 路径与端口默认值、DSH / Node 发现、凭据解析 |
| `lib/agents-block.mjs` | `AGENTS.md` 规则块的跨版本标记解析与替换 |
| `lib/install-manifest.mjs` | 安装记录（路径 + 哈希 + 备份引用）与卸载释放逻辑 |
| `lib/toml-sections.mjs` | 只维护本插件拥有的 TOML 表（转义、替换、删除） |
| `lib/protocol.mjs` | 输入规范化、prompt 渲染、契约检查 |
| `lib/registry.mjs` | 会话 ID（含哈希）、绑定校验、原子写入 |
| `lib/session-lane.mjs` | 同一会话的串行车道与置脏/拒绝逻辑 |
| `lib/host.mjs` | 续接后端：host 生命周期、turn 关联、取消、状态机 |
| `lib/runner.mjs` | 两条后端统一入口、流式输出上限、进程组清理 |
| `patches/read-only.yml` | 所有权限预设名 → read-only 沙箱 |
| `patches/workspace-write.yml` | 所有权限预设名 → workspace-write（工作区与系统临时位置） |
| `skill/SKILL.md` | 给 Codex 的 skill：字段、契约、状态、失败处理 |
| `tests/` | 单元测试 + 需显式开启的集成测试 |

## 安装

目录可以放在任何位置（含空格与中文），复制到新机器后重新跑一次安装即可；所有入口都按**自身位置**定位，
不依赖开发者机器路径。

```bash
# 1) 安装角色、两个 Skill 与规则块（会维护对应的 Codex 配置）
node install-codex.mjs                       # 角色 + 两个 Skill + 全局规则块（自动备份）
node install-codex.mjs --check               # 只读检查；未安装/需要更新时退出码 1
node install-codex.mjs --dry-run             # 预览将改动的文件

# 2) 可选：注册为 Codex 的一等 MCP 工具
node apply-config.mjs                        # 写入 [mcp_servers.dsh]（含非秘密 DSH 路径覆盖）
node apply-config.mjs --check                # 未注册 / 过期 / 路径无效时退出码 1
```

Codex 可执行文件默认从 `PATH` 发现；不在 `PATH` 时用 `--codex-bin <path>` 或 `CODEX_BIN` 显式指定。

开始前准备 Node.js 22+、可用的 DSH，以及已启动过一次的 Codex 配置。若自动发现不到 DSH，先在本次安装终端设置
`DSH_BIN` 指向 DSH 包内的 `lib/bin.js`，再运行安装命令。MCP 安装器会把所需非秘密路径写入自身的配置段，
无需依赖桌面启动时继承终端环境；API key 不会被安装器写入配置。

`apply-config.mjs` 只维护 `[mcp_servers.dsh]` 及其子表 `[mcp_servers.dsh.env]`，不改模型、登录方式、
其他 MCP server 与其他表；**默认不关闭 computer-use**，只有显式 `--no-computer-use` 才会动那两个插件。

### 升级、迁移与卸载

```bash
# 升级（同一个命令；跨版本规则块会被替换而不是追加）
node install-codex.mjs && node apply-config.mjs

# 迁移：把整个目录复制到新位置后，从新目录重新跑一次上面两条命令
# （已安装 Skill / 规则块 / MCP 配置里的路径会跟着更新）

# 卸载：只移除本插件安装的内容，保留你自己的配置
node apply-config.mjs --uninstall            # 移除 MCP 注册段
node install-codex.mjs --uninstall           # 移除角色 / Skill / 规则块
```

卸载依赖 `<Codex home>/.dsh-codex-bridge-install.json` 安装记录（只记录路径与内容哈希，不含任何秘密）：
本插件写的内容被删除或恢复成安装前的样子；**安装后被你自己改过的文件会保留并在输出里报「冲突」**
（退出码 1）。重复卸载是安全的。

安装记录缺失、原内容备份缺失或被改动时，卸载会保留无法确认的内容并报告冲突。不要为强行卸载而删除记录或备份。
迁移已有桥接时，如果要继续使用原模型设置与会话，请先用 `DSH_BRIDGE_HOME` / `DSH_HOST_ROOT` 指向原来的运行目录再注册。
本版不会自动搬迁或删除旧的 DSH 运行数据。

### DSH 与 Node 的发现顺序

1. 显式环境变量：`DSH_BIN`（`.../@deepseek-ai/dsh/lib/bin.js`）或 `DSH_CLI_ROOT`（DSH 安装根目录）。
2. `PATH` 上的 `dsh`（解析符号链接到包内 `lib/bin.js`）。
3. node 全局 `node_modules`（由当前 node 前缀、`~/.local`、`~/.npm-global`、`/usr/local`、`/opt/homebrew` 等推导）。

都找不到时不会去猜、也不会为了探测而调用模型：直接报错并列出上面三种配置方式。Node 同理：
`DSH_NODE` > 当前进程的 node > `PATH` 上的 node。

## 用法

```bash
# 一次性只读分析
./dsh-run -C /path/to/project -f src/a.ts -f src/b.ts \
  -g "找出这两个文件里所有未处理的异常路径" -a "每条给出 路径:行号"

# 续接：同一项目连续多轮
./dsh-run -s proj-x -C /path/to/project -g "先梳理这个模块的入口和调用链"
./dsh-run -s proj-x -C /path/to/project -g "基于刚才的梳理，指出最该拆的两个函数"

# 受控写入（用户明确授权时）
./dsh-run -s proj-x -m edit -C /path/to/project -g "重构 X 并跑测试" -a "测试全绿"

# 机器可读结果
./dsh-run -g "..." --json
```

`-f/--files` 每个参数一个路径，可重复；**不按逗号切分**（路径里可以合法含逗号）。
MCP 侧字段：`goal / cwd / files / mode / context / constraints / acceptance / session / timeout_s`。

## 输出契约

七段式报告（状态 / 摘要 / 交付内容 / 发现问题 / 验证情况 / 未解决事项 / 建议动作）。
桥接返回 `_meta`（CLI `--json` 同字段）：

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `execution` | `completed` / `failed` / `timeout` / `cancelled` / `execution_unknown` | 任务是否真的结束 |
| `result` | `success` / `partial` / `failed` / `unknown` | DSH 报告的「任务状态」 |
| `contractOk` | bool | 七段是否齐全且未被截断 |
| `warnings` | string[] | 缺段、问题缺位置、验证缺证据、截断 |
| `truncated` | bool | 输出是否被桥接截断 |

`execution_unknown` 表示取消未确认或连接中断：会话置脏，后续提交被拒绝，
需要换 session 标签或确认 DSH 空闲后重试。

## 权限模型（三层，实测）

任务约束与沙箱能力是两件事，分开看：

| 层次 | `analyze` | `edit` |
| --- | --- | --- |
| 业务写入范围（任务约定） | 无 | `cwd` 内 |
| 沙箱实际可写 | 无（只读） | `cwd` + 系统临时目录（`/tmp`、`$TMPDIR`） |
| 网络 | 可出网 | 可出网 |

这是DSH任务工具的文件策略。桥接自身仍会创建运行home、注册表和轨迹；`analyze`不表示整个调用在所有位置绝不落盘。实际沙箱能力依赖DSH版本和平台。

**两种任务模式：**

- **标准开发模式（默认）**：允许在授权项目内改代码，允许任务必需的系统临时文件
  （哈希、编译、测试缓存）；禁止改其他项目、全局配置与凭据，禁止删除不属于本次任务的临时文件，
  禁止未经授权的 push / 部署 / 破坏性迁移。临时文件应安全创建、任务结束清理，清理失败要如实报告。
- **严格隔离模式（按需）**：用户要求「所有写入只发生在指定目录」时，**不能只靠 prompt**。
  当前 `workspace-write` 不等于 cwd-only，Bridge 也没有更严格的强制档位；
  这种情况必须明确报告限制，暂停写入或请用户调整授权，而不是假装已隔离。

容易误判的三点：

- **`/tmp` 在 workspace-write 下可写**（平台临时区授权）。拿它验证「越界」会得到假阳性。
- **临时文件是允许的**：不要仅因合理的哈希/测试临时文件把普通开发任务判为失败；
  要看的是「有没有改到不该改的东西」。
- **文件沙箱不限制网络**：`analyze` 也能 `curl` 外网成功。

权限实现细节：

- headless 用 `--patch` 传 overlay；`dsh web` 拒绝 `--patch`，所以续接模式把 overlay 写进
  各自 home 的 `profiles/web/cordis.patch.yml`。
- `settings.yaml` 里的 `permission.defaultPreset` 会在建会话时把沙箱模式钉进事件流，
  覆盖 `DSH_PERMISSION_MODE`。因此 overlay 把**所有预设名**都映射到目标模式。
- analyze / edit 各一个 host、一个 home、一个端口（43191 / 43192），互不影响。
- 端口被非本桥接进程占用时直接报错，不会误连到另一个权限的 host。

## 续接后端

- `session.create` 对已有 id 幂等；`session.prompt` 支持冷恢复（从 JSONL 重放历史）。
- 会话 ID：`bridge-<mode>-<slug>-<hash8>`，`hash8 = sha256(label)` 前 8 位；
  `proj_a` / `proj a` / `proj-a` 不会碰撞，旧的无哈希 ID 按 `label + mode` 命中后继续使用。
- 订阅两条下行：`events.mux`（轮次/消息）与 `events.host`（`session-status` 空闲信号、`agent-error`）。
- 结果关联用 turn 号：建会话时从 `session.history` 播种最大 turn，`expected = max + 1`；
  历史不可用时降级为「prompt 后第一个 turn/end」并在日志留痕。
- 超时流程：`session.cancel` → 等 `turn/end(aborted)` 或空闲信号 → 确认才报 `timeout`，
  否则 `execution_unknown` + 置脏。等待上限为 timeout + 15s。
- 注册表 `sessions.json` 原子写入（临时文件 + rename）并加锁；损坏时改名备份，不静默清空。

## 测试

```bash
npm test                    # 单元测试（不需要 DSH、不需要真实 key）
npm run test:integration    # 真实 DSH，会消耗模型额度
```

安装 / 路径 / 卸载的回归测试全部用**临时假 Codex home** 与**离线 DSH fixture**，
不会读写你真实的 `~/.codex`、`~/.dsh` 或任何凭据。

集成测试覆盖：headless 只读/写入边界、session 的 cwd 绑定、同会话并发、超时取消、跨重启恢复。
破坏性探测只发生在 `$TMPDIR/dsh-bridge-itest-*` 与 `/Users/Shared/dsh-bridge-itest-outside-*`，
结束后清理。

## 追踪与审计

每次调用都会生成一个 `taskId`，并记录到 `$DSH_HOST_ROOT/trace/<taskId>.json`
（默认 `~/.dsh-codex-bridge/host/trace/`）：

- one-shot：运行前后对比 `$DSH_HOME/sessions` 的目录增量，反查 DSH 内部生成的 `sessionId`
  （恰好新增一个才认领，并发时宁可留空）；
- session 模式：`sessionId` 本来就是桥接生成的，直接记录。

```bash
node scripts/trace.mjs list --limit 10
node scripts/trace.mjs show 5bf5c155
```

轨迹只存元数据（goal 截断 200 字 + 哈希、cwd、mode、execution、result、warnings、耗时），
不存完整 prompt 和报告正文。

**会话可见性**：桥接用的是独立 `DSH_HOME`（默认 `~/.dsh-codex-bridge/dsh-home`、`.../host`），与桌面版 GUI 的 home 不同，
所以这些会话**不会出现在你的 DSH Desktop 会话列表里**。要看原文，用同一 `DSH_HOME` 启动任意
DSH 前端（web/tui，若已安装），或直接解压 `sessions/<slug>/<sessionId>/session.jsonl.zstd`。
prompt 首行带 `（Codex 任务 <taskId>）`，便于对照。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_BIN` | 自动发现（见上节） | DSH 入口 `.../@deepseek-ai/dsh/lib/bin.js` |
| `DSH_CLI_ROOT` | — | DSH 安装根目录（内含 `lib/bin.js` 或 `node_modules/@deepseek-ai/dsh`） |
| `DSH_NODE` | 当前进程 node → `PATH` | 生成 MCP 配置与 spawn 用的 node |
| `DSH_BRIDGE_STATE_DIR` | `~/.dsh-codex-bridge` | 桥接状态根目录（home / host / 轨迹都在下面） |
| `DSH_BRIDGE_HOME` | `$DSH_BRIDGE_STATE_DIR/dsh-home` | 一次性后端状态目录（不继承外部 `DSH_HOME`） |
| `DSH_HOST_ROOT` | `$DSH_BRIDGE_STATE_DIR/host` | 续接后端 home / 注册表 / pidfile |
| `DSH_TRACE_DIR` | `$DSH_HOST_ROOT/trace` | 轨迹目录 |
| `DSH_HOST_PORT_ANALYZE` / `_EDIT` | `43191` / `43192` | 两个 host 的端口 |
| `DSH_DEFAULT_CWD` | 用户目录 | 未给 `cwd` 时的目录（不再是原开发目录） |
| `DEEPSEEK_API_KEY` | 从 `.credentials.yaml` 读 | 文件权限需 600；**绝不写进生成配置或安装记录** |
| `DSH_TASK_TIMEOUT_S` / `DSH_MAX_OUTPUT` | `600` / `24000` | 默认超时 / 回传字符上限 |

## 已知限制

- **MCP入口全局串行**：不同session的后端车道不等于这个MCP服务会并行执行调用。
- **续接输出边界不同**：一次性后端有输出捕获限额；续接回传及模型截断标记未提供完全相同的限制。
- **文档与报告检查不是事实证明**：任务检查验证结构，报告契约检查粗验格式；仍需主控独立验收。
- **部分复杂TOML会安全拒绝**：例如inline env，不会猜测拆分后覆盖用户内容。
- **运行时没有完整英文模式**：文档和关键注释双语，操作型协议与部分消息保持原中文契约。
- **会话是历史复用，不是内存复用**：冷恢复要重放 JSONL，首轮略慢。
- **每个模式常驻一个 host**：约一个 node 进程；不用续接就不会启动。
- **`analyze` 写不了报告文件**：需要落盘的大产物只能用 `edit` 在 cwd 内写。
- **会话被外部改动时无感知**：续接前应重新确认相关文件状态。
- **契约检查是启发式**：能抓缺段/缺证据，不能证明结论为真。

---

本项目专门适配 DeepSeek Harness 与 Codex（不做通用多 Agent 框架）。
开发：DeepSeek V4.1 Flash 主导，GPT 6.1 sol 辅助。

版权署名：残梦。

## 许可证

本项目采用 [MIT License](LICENSE)。Copyright (c) 2026 残梦。
