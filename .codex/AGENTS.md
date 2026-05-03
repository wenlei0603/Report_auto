# LSEG Codex Profile

This file narrows ECC to the current project.

## Project Runtime

- Primary stack: TypeScript + Playwright
- Browser model: attach to a browser the user already logged into manually
- Immediate target: browser control core, state detection, query filling, download verification, and archival ownership
- Python scripts are reference inputs for migration, not the target runtime

## Imported Common Skills

Skills are loaded from `.agents/skills/`. The current baseline is intentionally small and engineering-focused:

- `tdd-workflow`
- `e2e-testing`
- `coding-standards`
- `backend-patterns`
- `verification-loop`
- `security-review`
- `documentation-lookup`
- `mcp-server-patterns`
- `eval-harness`
- `strategic-compact`
- `systematic-debugging`
- `verification-before-completion`

Add project-specific `lseg-*` skills incrementally as the rewrite stabilizes.

## Default MCP Set

The project-local `.codex/config.toml` keeps the default MCP set to:

- `playwright`
- `context7`
- `sequential-thinking`
- `github`
- `evalview`

Do not add more default MCPs unless a task is blocked by missing capability.

## Default Agents

The current project agent set is:

- `explorer` - read-only codebase and evidence gathering
- `reviewer` - correctness, regression, and missing-test review
- `browser_debugger` - browser/frame/network/download investigation
- `test_author` - failing tests first, then test harness expansion

## Operating Rules

- Prefer live browser evidence over inferred UI behavior.
- Model query/results/document-info/BatchSavePrint/auth as explicit states, not ad hoc conditionals.
- Treat a task as incomplete until the artifact state is known.
- Keep browser-control code separate from task orchestration, persistence, and archival layers.
