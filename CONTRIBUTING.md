# Contributing

Use Node.js 22.12 or newer on macOS for native development. Install pinned dependencies with `npm ci`, start the desktop app with `npm start`, and use `npm run dev` for the UI-only browser preview.

Before submitting a change:

1. Reproduce the issue in a small temporary project.
2. Keep renderer APIs narrow and validate model-generated actions in the host.
3. Preserve project confinement, conflict checks, cancellation and owned-process cleanup.
4. Add meaningful regression coverage for behavioral changes.
5. Run `npm test` and `npm run build` on macOS. Run a model benchmark only when relevant, explicitly recording its model/runtime/settings and limitations.
6. Update documentation for changed user-visible behavior.

Open a focused pull request describing the problem, resulting behavior and validation. Avoid committing models, built apps, dependencies, local registries, private projects, runtime logs or credentials. `.gitignore` excludes local diagnostics and generated output.

For UI changes, include a screenshot with example data and identify whether it comes from the native app or browser preview. Model performance claims should distinguish loading, prompt evaluation and token decoding.

## Test layout

- `core.test.mjs`: model registry, workspace paths and editor conflicts.
- `agent.test.mjs`, `action-stream.test.mjs`: action validation, stream budgets and repair loops.
- `resources.test.mjs`: file operations, role sequencing, leases and cancellation.
- `memory.test.mjs`, `memory-guard.test.mjs`: GGUF estimates, context plans and pressure recovery.
- `runtime.test.mjs`, `thermal.test.mjs`: load lifecycle, settings reuse, cleanup and thermal state.
- `mcp.test.mjs`: configuration and real local stdio handshake/discovery/invocation.

Sensitive reports should follow [the security guide](docs/security.md). A project license has not been selected; discuss licensing before contributing code intended for reuse.
