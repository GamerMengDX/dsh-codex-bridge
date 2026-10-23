# Bridge architecture and boundaries

[简体中文](ARCHITECTURE.md) | **English** · [Workflow](SKILLS.en.md)

## Invocation path

Codex submits tasks through the MCP tool in `server.mjs` or the CLI in `dsh-task.mjs`. Both use `lib/protocol.mjs` for input normalization and report checks, and `lib/runner.mjs` for execution. Without a session label, the runner starts a one-shot headless process. With a label, `lib/host.mjs` uses a persistent DSH web-host session.

The project preserves DSH's own tools and execution system. It is not an adapter framework for arbitrary harnesses. The Codex architecture role and coordinator-led verification are workflow responsibilities above the bridge.

## Modules

| Module | Responsibility |
| --- | --- |
| `protocol` | Field normalization, input type/length limits, task prompts, and report-format checks |
| `runner` | Backend selection, one-shot output capture, process-group timeouts, unified outcomes, and trace correlation |
| `host` | Host lifecycle, event/turn correlation, cancellation requests, and completion signals |
| `session-lane` | Process-local serialization per session and rejection of uncertain sessions |
| `registry` | Labels, canonical directory bindings, and registry persistence; not a complete cross-process transaction system |
| `trace` | Limited task/session metadata, excluding complete report bodies |
| `workflow` / `task-doc` | Classification/state helpers and structural checks for handoff documents |
| Installation modules | Path discovery, managed configuration fields, marked blocks, backups, and uninstall records |

## Separate kinds of state

`execution` describes the lifecycle; `result` comes from DSH's report; `contractOk` describes structural completeness; `warnings` carries formatting, evidence, and execution concerns. No single field establishes coordinator acceptance.

A cancellation request is not confirmation that execution stopped. The session backend waits for turn-ending signals. When it cannot confirm the outcome, it returns `execution_unknown` and marks the process-local session uncertain. Recovery still requires checking task and file state.

## Filesystem and network

DSH and the platform enforce the filesystem policy. Task tools are read-only in `analyze`; `edit` uses workspace-write, including workspace and system temporary locations. Business writes must remain within the authorized scope. The filesystem policy is not network isolation or proof that no external side effect occurred.

The bridge itself creates runtime directories, registry state, and traces. The architecture role's read-only intent is primarily instruction and review. Installation records, runtime homes, sessions, credentials, and private full review material are excluded from the public distribution tree.

## Installation configuration

Installers maintain their own files and configuration. The TOML scanner understands comments, quoted keys, multiline strings, and container boundaries before patching managed fields. It does not serialize the whole user configuration. Unsupported complex target representations are rejected.

Uninstall relies on records, content hashes, and restoration backups. Damaged markers, missing records, missing backups, and user edits are preserved as conflicts. Removing one component retains evidence needed to restore another component.

## Current limits

- The MCP entry point queues calls globally. Process-local lanes do not provide cross-process exclusion or parallel working-tree management.
- DSH history replay is not a transactional workflow checkpoint.
- One-shot and persistent-session output/truncation limits are not identical.
- Structural checks do not verify implementation facts; coordinator acceptance remains necessary.
- Required Chinese runtime headings remain unchanged. Bilingual explanations do not change the task protocol.

Version 2.2.4 adds documentation, explanatory comments, and release metadata. Executable equivalence is checked through JavaScript syntax trees and shell content with standalone comments excluded.
