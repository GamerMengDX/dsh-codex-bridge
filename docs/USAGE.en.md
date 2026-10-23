# Installation and usage

[简体中文](USAGE.md) | **English** · [Overview](../README.en.md) · [Roles](ROLES.en.md) · [Skills](SKILLS.en.md)

In the examples, `<bridge>` is the absolute path to your extracted or cloned bridge. `<project>` is the business project you want DSH to work on. Replace the placeholders before running commands.

## 1. Prepare the environment

Use Node.js 22+, an installed DSH, and a configured Codex installation. Start Codex once so its configuration file exists. Model availability and authentication depend on your own account and provider settings.

If DSH is not automatically found:

```sh
export DSH_BIN="/absolute/path/to/@deepseek-ai/dsh/lib/bin.js"
# Or point to a directory containing lib/bin.js or node_modules/@deepseek-ai/dsh:
# export DSH_CLI_ROOT="/absolute/path/to/dsh-installation"
```

To keep previous model settings or stored sessions during migration, set `DSH_BRIDGE_HOME` and `DSH_HOST_ROOT` to their existing locations before registration. The installer does not migrate or delete that data.

## 2. Install into Codex

```sh
cd "<bridge>"
node install-codex.mjs --dry-run
node install-codex.mjs
node install-codex.mjs --check
```

The installer manages these locations in the selected Codex home:

- `agents/architecture_designer.toml` and its role configuration table;
- `skills/multi-agent-development/SKILL.md` and `skills/dsh-bridge/SKILL.md`;
- the plugin's marked block in `AGENTS.md`;
- `.dsh-codex-bridge-install.json`, containing ownership and restoration information.

The default home is `$CODEX_HOME` or `~/.codex`. Use `--codex-home "/absolute/path"` for another home. Use `--codex-bin "/absolute/path/to/codex"` or `CODEX_BIN` when the Codex executable is not on `PATH`. `--no-doctor` skips the optional local Codex diagnostic, not the independent installation-content check.

Installation updates the managed role and Skills; it does not intentionally change your default model, model provider, authentication, unrelated MCP servers, or unrelated roles. Review the dry-run plan and backups when integrating with an existing setup.

## 3. Register the MCP tool

```sh
cd "<bridge>"
node apply-config.mjs --dry-run
node apply-config.mjs
node apply-config.mjs --check
```

This registers `dsh_task` under `[mcp_servers.dsh]` and persists required non-secret path overrides in its `env` table. User options such as `enabled=false` and additional environment entries are retained. A disabled server remains disabled; a successful installation does not silently enable it.

Use `--config "/absolute/path/config.toml"` or `--codex-home "/absolute/path"` to select another configuration. `--check` returns nonzero for missing or stale required setup. It does not invoke a model or prove end-to-end model access.

The installer does not automatically copy `DEEPSEEK_API_KEY` into generated configuration. Configure credentials through your intended runtime environment or supported local store. Do not commit credentials or installation backups to GitHub.

Restart Codex or open a fresh session. Ask it to list its loaded Skills and confirm that `architecture_designer` is available. If supported by your Codex version, `codex doctor` can provide additional role-loading diagnostics.

## 4. Set up a business project

Keep project decisions in the project repository. The task-document tool stays in the bridge repository; there is no need to copy the bridge's implementation into each project.

```sh
cd "<project>"
export BRIDGE="<bridge>"
mkdir -p docs/architecture/TASKS
cp "$BRIDGE/docs/templates/architecture/PROJECT_DESIGN.md" docs/architecture/
cp "$BRIDGE/docs/templates/architecture/DECISIONS.md" docs/architecture/
cp "$BRIDGE/docs/templates/architecture/REVIEW-TEMPLATE.md" docs/architecture/
node "$BRIDGE/scripts/task-doc.mjs" new \
  --id T-001 --class C --goal "Implement the first approved feature"
```

Fill in scope, allowed files, executable acceptance conditions, and the current design version. Generated headings remain Chinese because the current checker recognizes them. The [Skills guide](SKILLS.en.md) explains the section names.

Use the task tool to advance a permitted state:

```sh
node "$BRIDGE/scripts/task-doc.mjs" set-state \
  --file docs/architecture/TASKS/T-001.md --state designing
node "$BRIDGE/scripts/task-doc.mjs" check \
  --file docs/architecture/TASKS/T-001.md
```

The checker validates document structure and allowed values. It does not execute acceptance commands or prove that a task marked `delivered` was actually verified.

`permission: standard` allows task-required temporary files. Use `strict` only when the requested boundary can actually be enforced; the current bridge does not supply a cwd-only sandbox.

## 5. Use the development workflow

Give Codex a concrete request. For example:

> Build a command-line bookmark manager using Node.js and local JSON storage. First use the architecture role to propose the data model, interface, error behavior, and acceptance tests. After I confirm the design, delegate implementation to DSH. Then inspect the actual changes and run the acceptance checks independently. Implementation may change `src/` and `tests/`; project design documents are maintained by the coordinator.

Expected flow:

1. The coordinator classifies the task and creates the design baseline and handoff.
2. For a design task, the architecture role returns a design package.
3. The user confirms the design and any required risk decisions.
4. Codex delegates a self-contained task to DSH with explicit scope and acceptance conditions.
5. DSH implements and self-checks; the coordinator reviews the diff and independently validates the result.
6. Accepted work advances to `passed` and `delivered`. Implementation failures return for bounded repairs; design failures are escalated.

The role separation is enforced partly by workflow instructions. It is not a fully autonomous approval engine or a substitute for review.

## 6. Use the CLI directly

```sh
node "<bridge>/dsh-task.mjs" \
  -C "<project>" \
  -g "Review the module without changing files" \
  -a "Provide file locations and reproducible evidence" --json
```

`analyze` is the default. Use `-m edit` only for authorized changes. Omit `-s` for a fresh one-shot task; use a label such as `-s bookmark-review` for a related phase in the same directory. A report still uses the existing Chinese section contract even when the task goal is English.

On POSIX systems, `"<bridge>/dsh-run"` is the equivalent shell launcher. On Windows use the Node entry point; Windows execution and sandbox behavior are not verified here.

## 7. Upgrade, move, and uninstall

After moving or replacing the entire bridge directory, run from the new location:

```sh
node install-codex.mjs
node apply-config.mjs
node install-codex.mjs --check
node apply-config.mjs --check
```

The installed Skill command paths and MCP entry are updated to the new location. Complete historical AGENTS blocks are replaced rather than duplicated; damaged markers are rejected without guessing their boundaries.

To uninstall:

```sh
node apply-config.mjs --uninstall
node install-codex.mjs --uninstall
```

Managed content is removed or replaced with its original content using installation records and backups. User-edited content, missing records, or missing/tampered restoration backups cause a conflict and are preserved. Repeated removal is safe for content already absent. Do not erase records or backups to force deletion. DSH credentials, conversation stores, and unrelated Codex settings are not removal targets.

## 8. Troubleshooting

| Symptom | Action |
| --- | --- |
| `dsh_task` is missing | Check MCP registration, run `apply-config.mjs`, and restart Codex; the CLI remains an alternative |
| DSH entry not found | Set an absolute `DSH_BIN` or `DSH_CLI_ROOT`, then repeat registration |
| `--check` returns nonzero | Read the stated missing/stale path, disabled state, or unsupported configuration; it is not a model-quality result |
| `unknown agent_type` | Check role installation, local Codex compatibility, and the selected design model |
| Architecture role attempts edits | Treat its read-only instruction as a workflow restriction and inspect actual effects; it is not a separate sandbox |
| Uninstall reports a conflict | Preserve the record and backups, inspect the user modification, and resolve deliberately |
| Complex inline TOML is rejected | Use explicit supported tables or handle that configuration manually; no speculative rewrite is performed |
| Task becomes `execution_unknown` | Confirm the old task has stopped before another write; do not blindly resubmit into the uncertain session |
| You need trace correlation | Run `node "<bridge>/scripts/trace.mjs" list` and inspect task/session metadata locally |

See [Roles](ROLES.en.md), [Skills](SKILLS.en.md), [README](../README.en.md), and [Chinese changelog](../CHANGELOG.md).
