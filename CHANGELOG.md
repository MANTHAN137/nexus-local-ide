# Changelog

## 0.4.1 — current source snapshot

- Resizable, keyboard-accessible workbench panels and narrow-window handling.
- Project-scoped create/edit/rename/move/delete operations with external-change conflicts and native sandbox checks.
- Sequential Builder, Reviewer and Tester roles, visible activity and bounded action loops.
- On-demand context growth starting at 4K, corrected hybrid GGUF estimates, cancellation-safe model loading and idle unloading.
- Protect other apps and monitored Model focused memory policies, manual unload, CPU compatibility and energy profiles.
- Warning recovery, headroom/swap safeguards and macOS thermal stops.
- Global MCP toggle, composer ON/OFF status and installed local stdio server configuration.
- Stable agent prompt prefixes and repair-aware retry logic.

### Repository preparation

- Added setup, architecture, security, troubleshooting, performance and contribution documentation.
- Added real browser-preview screenshots using example data.
- Added macOS test/build CI and exclusions for models, app bundles, machine diagnostics and unrelated projects.

### Known limitations

- Model focused may choose partial GPU execution, which can be slow. A revised full-GPU placement policy remains pending verification.
- Conversation content and project authorization are session-only.
- The terminal is a bounded check runner, and MCP supports sandboxed local stdio only.
- Signing/notarization, model downloads, remote MCP and cloud inference are not included.
