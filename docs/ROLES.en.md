# Roles and model configuration

[简体中文](ROLES.md) | **English** · [Usage](USAGE.en.md) · [Skills](SKILLS.en.md)

Role names are stable; model choices are configurable. The project is specifically a Codex-to-DSH development bridge. Switching to another execution harness would require an adapter, not just a different model name.

## Role map

| Role | Responsibility | Configuration |
| --- | --- | --- |
| `project_coordinator` | Understand the request, classify it, delegate work, verify results, and deliver | The user's current Codex model and provider |
| `architecture_designer` | Architecture, contracts, technical trade-offs, and difficult root-cause diagnosis | `codex/roles.json`, rendered into the installed role TOML |
| `development_executor` | Implementation, self-checks, and repairs | DSH's own model/provider settings |
| `quality_reviewer` | Inspect the actual diff, reproduce checks, and assess acceptance | Normally the same Codex coordinator session |

Four roles do not imply four simultaneous agents. A small edit can stay with the coordinator. A task within an existing design typically needs the coordinator and DSH. An architecture agent is added when the task warrants it.

"Independent verification" means independent of the implementer's report. The default reviewer is not a separate model, separate organization, or guarantee of unbiased judgment.

## Change the architecture model

The shipped `codex/roles.json` contains the current design-role default. Choose a model and reasoning setting available in your own Codex environment; shipped identifiers are not a promise of account access.

1. Edit the `architecture_designer` entry in `codex/roles.json`.
2. Run `node install-codex.mjs` from the bridge directory.
3. Run `node install-codex.mjs --check` and check role-loading diagnostics in your installed Codex version.
4. Start a new Codex session and ask for a read-only architecture review to confirm the role can run.

The bridge protocol does not need to change when the architecture model changes. Other roles use their native configuration: the coordinator uses Codex, the executor uses DSH, and the reviewer follows the coordinator by default. Model settings are therefore not all centralized in `roles.json`.

## Boundaries and compatibility

- Custom-role loading and tool-call schemas depend on the installed Codex version. Treat examples as guidance and use the actual tool schema offered by your environment.
- The architecture role is instructed not to implement business code. That instruction is not an independently enforced process sandbox.
- The role does not automatically gain model access because its configuration file exists.
- DSH maintains its own tools and history. It does not inherit the coordinator's conversation, so handoffs must contain the required context.
- The coordinator should request a bounded design package, not copy the entire parent conversation into every architecture call.

If the custom role cannot be loaded, report that explicitly. Do not claim automatic architecture routing succeeded when it did not. The user can provide a design package from another session and continue the same workflow.

## Cost boundaries

Codex usage follows the user's authentication, account, provider, and selected model. DSH usage follows its own configuration and billing. This plugin does not guarantee that architecture calls are included in every subscription or never incur API charges.

Returning a concise report can reduce the coordinator's visible context, but DSH still consumes its own context and model usage. Session history replay and repair attempts count toward the actual total. Compare both sides' usage before claiming a cost saving.

## Common role failures

| Symptom | Likely area to inspect |
| --- | --- |
| Unknown `architecture_designer` role | Installation, local role schema, and role-loading warnings |
| Role exists but model cannot start | Model/provider availability in the current account |
| Role behaves like a generic assistant | Whether the installed `config_file` and role instructions were loaded |
| Architecture role edits business code | Task instructions and actual diff; read-only intent is not a separate sandbox |
| Repeated implementation failures | Concrete failure evidence, design consistency, and the bounded escalation workflow |

Development attribution remains **DeepSeek V4.1 Flash (lead)** and **GPT 6.1 sol (assistance)**. Those credits describe the project's development, not hard-coded runtime model requirements. Copyright: **残梦**, under the [MIT License](../LICENSE).
