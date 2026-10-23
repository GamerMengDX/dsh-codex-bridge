# dsh-codex-bridge 2.2.4 distribution

[简体中文](PACKAGE-NOTES.md) | **English**

The source distribution contains the bridge, installers, operational Skills, role/configuration templates, offline tests, reusable project-document templates, and public Chinese/English documentation. It includes the [MIT License](LICENSE), copyright **残梦**.

It excludes credentials, runtime homes, session stores, traces, installation receipts, backups, local machine snapshots, raw private review logs, and unpublished internal task records. Those files are not required to install or test the bridge.

## Verify and use

Check the source archive against `SHA256SUMS.txt`, extract it, and run:

```sh
cd dsh-codex-bridge
npm test
node install-codex.mjs --dry-run
node install-codex.mjs
node install-codex.mjs --check
node apply-config.mjs
node apply-config.mjs --check
```

Prepare Node 22+, DSH, and an existing Codex configuration. If discovery fails, explicitly set an absolute `DSH_BIN` or `DSH_CLI_ROOT` before registration. No key is bundled; the installer does not automatically write your runtime provider key into configuration.

The default runtime root is `~/.dsh-codex-bridge`. Keep an existing model/session store by configuring `DSH_BRIDGE_HOME` and `DSH_HOST_ROOT` before migration. Reinstall from a moved source directory to refresh managed command paths.

Use `node apply-config.mjs --uninstall` and `node install-codex.mjs --uninstall` to remove managed installation content. Preserve records and backups when resolving conflicts.

## Verification scope

The offline suite uses temporary Codex homes and DSH fixtures. The bilingual release additionally checks documentation links and executable equivalence after comment edits. Real DSH integration is a separate, opt-in test that consumes model access and performs test writes. Windows DSH execution and sandbox behavior are not established by the macOS offline checks.

Documentation and key comments are bilingual; runtime Skill prompts, some messages, and machine-checked Chinese report/document headings remain unchanged. See [README](README.en.md), [Usage](docs/USAGE.en.md), [Roles](docs/ROLES.en.md), and [Skills](docs/SKILLS.en.md).

Development attribution: **DeepSeek V4.1 Flash (lead)**, **GPT 6.1 sol (assistance)**. This independent DSH/Codex integration is not an official or endorsed release from either vendor.
