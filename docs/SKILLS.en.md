# The two Skills and development workflow

[简体中文](SKILLS.md) | **English** · [Usage](USAGE.en.md) · [Roles](ROLES.en.md)

This project is a dedicated bridge between DeepSeek Harness and Codex. The Skills provide workflow and invocation guidance; the bridge code performs execution and state handling.

| Component | Question it answers |
| --- | --- |
| `multi-agent-development` | When is design needed, what should be handed off, who verifies, and when should failures escalate? |
| `dsh-bridge` | How is DSH invoked, what do the fields mean, and how should outcomes be interpreted? |
| MCP / CLI and executor | Normalize inputs, run tasks, bind directories and sessions, cancel on timeout, inspect report structure, and record trace metadata |

## Right-size the workflow

| Class | Typical trigger | Workflow |
| --- | --- | --- |
| A | Copy, style, or a clearly bounded small repair | Coordinator handles it, optionally after read-only analysis; no architecture call |
| B | An existing design with unchanged contracts, data model, and boundaries | Read design → DSH implementation → coordinator verification |
| C | A new project/module or a contract/data-structure change | Architecture role → user confirmation → DSH implementation → verification |
| D | Authentication, authorization, payments, migration, concurrency, or similar high-risk work | Design and risk assessment → user confirms risk and rollback → staged implementation and stronger verification |

The roles are coordinator, architecture designer, executor, and reviewer. The reviewer normally reuses the coordinator session. Independent verification means checking independently of DSH's implementation claims, not a separate review model or guaranteed unbiased judgment.

## Handoff files and task states

The business project keeps `PROJECT_DESIGN.md` for the current baseline, `DECISIONS.md` for decision history, and `TASKS/` for handoffs. The task tool stays in the bridge repository.

Generate a task with `task-doc.mjs new`, fill its scope and executable acceptance conditions, and use `set-state` for permitted transitions. The metadata key is `status`; `--state` is the CLI option for a requested transition.

A common path is `requirements → designing → design_review → ready_for_implementation → implementing → reviewing → passed → delivered`. Tasks within an existing design can skip the design stages. Failures enter repair or redesign states; missing prerequisites can block the task.

The checker validates metadata, allowed values, and required headings. It does not execute tests, inspect implementation quality, or prove that `delivered` is truthful. The coordinator must record actual commands, results, and review evidence.

## Give DSH a self-contained task

| Input | What to provide |
| --- | --- |
| `goal` | A concrete deliverable |
| `cwd` | The explicit project directory for this task |
| `files` | Relevant files/directories; commas in paths are preserved |
| `mode` | `analyze` by default; use `edit` only for authorized implementation |
| `context` | Approved design, previous findings, and background DSH cannot infer |
| `constraints` | Allowed/prohibited scope and other hard constraints |
| `acceptance` | Observable or executable acceptance conditions |
| `session` | A label for the same related phase; omit for independent tasks |
| `timeout_s` | The execution time budget |

DSH does not inherit the coordinator's conversation. Its own session history can be resumed, but external file changes still need checking. History reuse is neither free context nor a transactional checkpoint.

## Existing report headings

The operational report contract remains Chinese. These headings map to:

| Heading | English meaning |
| --- | --- |
| `任务状态` | Claimed task outcome: success, partial, or failure |
| `结果摘要` | Main conclusion |
| `交付内容` | Actual changes or analytical deliverables |
| `发现问题` | Findings with locations and triggering conditions |
| `验证情况` | Checks performed, supporting evidence, and unverified items |
| `未解决事项` | Risks, gaps, and decisions still needed |
| `建议动作` | Executable next steps |

The bridge also separates `execution` from the report's `result`, structural `contractOk`, and `warnings`. Read them together. A finished process or complete report format is not proof of acceptance.

The coordinator reviews the actual diff, key implementation, reproducible checks, design consistency, regressions, and observable side effects. Ordinary repairs are normally limited to two evidence-backed attempts before escalation when progress stalls. A design defect can escalate immediately. Human approvals and repair budgets remain workflow responsibilities, not an unbypassable approval service.

## Permission and failure boundaries

- DSH task tools use a read-only filesystem policy in `analyze`; the bridge itself still creates runtime state. Read-only files do not imply no network or no other side effects.
- `edit` uses workspace-write, which includes workspace and system temporary locations. Business changes must still remain within the user's authorized scope. Strict cwd-only isolation is not supplied here.
- The architecture role's read-only instruction is not its own operating-system sandbox.
- The current MCP entry globally queues requests. Process-local session lanes do not provide cross-process exclusion or a complete parallel-worktree system.
- For `execution_unknown`, establish whether the old task has stopped before recovery. A new label does not resolve an older write to the same directory.

## Language scope

Documentation and key comments have Chinese and English explanations. Operational Skill instructions, required generated headings, and report-contract labels remain unchanged to preserve the existing handoff and checker behavior. English goals and acceptance conditions can be supplied while retaining those required generated fields and headings.
