# dsh-codex-bridge v2.2.4 — 打包说明

**简体中文** | [English](PACKAGE-NOTES.en.md)

## 包含

- MIT许可证 `LICENSE`，版权署名：残梦（2026）
- 桥接代码：MCP server、CLI、安装/卸载器、lib（协议/会话/追踪/状态机/TOML 与标记块维护）
- 两个 Codex Skill：`multi-agent-development`、`dsh-bridge`（源文件用占位符，安装时替换为本机路径）
- 全局规则模板 `codex/AGENTS.md.part`、角色模板与 `roles.json`
- 可复用模板 `docs/templates/architecture/`、公开中英双语说明与解释备注
- 权限 overlay：`patches/read-only.yml`、`patches/workspace-write.yml`
- 安装/路径/卸载回归测试（`tests/install.test.mjs`、`tests/apply-config.test.mjs`、`tests/portable.test.mjs`）

## 不包含（有意排除）

- 桥接状态目录（默认 `~/.dsh-codex-bridge/`）：host home、会话注册表、调用轨迹，首次运行会重建
- `.DS_Store`
- 本机私有验收材料 `docs/architecture/portability-evidence/`（机器路径、配置哈希与完整日志）
- 原始内部任务/设计记录与历史私有审阅材料（公开架构说明另见 `docs/ARCHITECTURE.md`）
- `~/.codex` 下的实际安装（AGENTS.md / agents / skills / config.toml / 安装记录）
- 任何 API Key。凭据从 `DEEPSEEK_API_KEY` 或 `.credentials.yaml` 读取，绝不写入生成配置或安装记录

## 机器相关默认值（v2.2.3 起不再有开发者绝对路径）

| 项 | 默认 | 覆盖方式 |
| --- | --- | --- |
| DSH 入口 | 自动发现：`PATH` 上的 `dsh`、node 全局 `node_modules`、常见前缀 | `DSH_BIN` / `DSH_CLI_ROOT` |
| Node | 当前进程的 node → `PATH` | `DSH_NODE` |
| DSH 状态 home | `~/.dsh-codex-bridge/dsh-home` | `DSH_BRIDGE_HOME` |
| 续接状态根 | `~/.dsh-codex-bridge/host` | `DSH_HOST_ROOT`（轨迹目录再用 `DSH_TRACE_DIR`） |
| 默认 cwd | 用户目录 | `DSH_DEFAULT_CWD` |
| 端口 | `43191` / `43192` | `DSH_HOST_PORT_ANALYZE` / `DSH_HOST_PORT_EDIT` |

发现不到 DSH 时直接报错并列出配置方式（不猜测、不为了探测去调用模型）。

## 恢复与验证

```bash
unzip dsh-codex-bridge-v2.2.4.zip
cd dsh-codex-bridge
npm test                       # 单元测试，不需要 DSH 与真实 key
node install-codex.mjs --check # 只读检查（未安装/需更新时退出码 1）
node install-codex.mjs         # 安装 Skill / 角色 / 全局规则（自动备份）
node apply-config.mjs          # 可选：注册 dsh MCP（含非秘密 DSH 路径覆盖）
node apply-config.mjs --check  # 未注册 / 过期 / 路径无效时退出码 1
```

卸载：`node apply-config.mjs --uninstall` 与 `node install-codex.mjs --uninstall`；
只移除本插件写的内容，安装后被用户改过的会保留并报冲突。

## 测试范围说明

- v2.2.3安装修复曾通过151项单元/回归及13项独立验收；双语版本还会重新检查完整回归、文档链接及可执行代码一致性。
- 单元/回归测试全部离线：临时假 Codex home + 离线 DSH fixture + 复制到含空格/中文的临时目录，
  不访问真实 `~/.codex`、`~/.dsh`，不读真实 key，不调用真实模型。
- 入口 `dsh-run` 是 POSIX `sh` 脚本，面向 macOS / Linux / WSL；本轮实际在 macOS 验证。
  Windows 可直接使用 `node dsh-task.mjs ...` 入口，但本轮没有验证 Windows 下的 DSH 执行与沙箱，不承诺同等支持。
- 真实 DSH 集成测试需显式开启（`npm run test:integration`），不属于本包的安装自测范围。
