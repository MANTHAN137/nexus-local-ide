# Project permissions and security

## Intended boundary

Selecting a dedicated project folder grants Agent mode read, create, edit, rename, move and delete access inside that folder. Saved agent changes are real changes. Selecting an entire home folder, Desktop or system directory is deliberately discouraged or rejected by the workspace checks. Project authorization must be established again after a restart.

Edit mode shows a reviewed single-file proposal. Existing file operations use metadata or content versions to reject external-change conflicts. Moves do not overwrite destination files. Symlink escapes, traversal and hard-linked file operations are rejected. Empty directories can be deleted; recursive directory deletion is not an agent tool.

## Native workers and commands

The macOS file broker runs with a project sandbox. Project checks and MCP servers also use `sandbox-exec`: writes are confined to the project and private scratch storage, reads include required runtimes, and network/application-control access is denied. There is no unrestricted fallback shell.

The terminal accepts a supported command set and quoted arguments. It rejects shell operators, network operations and package installation. Install trusted dependencies yourself before asking Nexus to run project checks. MCP servers must be installed separately and may need dependencies compatible with this restricted environment.

## Models and tools

GGUF weights remain at their chosen locations. Removing a registry entry does not delete the model. The local inference server binds to `127.0.0.1` and uses a generated token, with its web UI disabled. The renderer uses a limited preload bridge rather than general Node access. Tool descriptions, model actions and tool responses are treated as untrusted data.

The global MCP switch and per-server enabled flags govern discovery and invocation. Only installed local stdio servers are supported. Remote HTTP/SSE, OAuth and network-dependent tools are not supported. Server process groups are owned by the current task and shut down after roles complete or stop.

## Limits

Resource estimates cannot account for every runtime allocation. Monitored macOS-managed loads have bounded warning recovery and critical/headroom/swap stops; the main process also observes macOS thermal pressure. These checks reduce risk but cannot guarantee that a process never fails or a model never exhausts memory.

A model can produce incorrect code, descriptions or answers. Passing checks describe actual command results, not comprehensive correctness. Use version control and review changes before deployment. An Agent task can modify any permitted file in the selected project, including configuration and dotfiles.

This is an early application, not a security certification. Browser screenshots demonstrate layout only. Models, commands and local MCP servers should be selected from sources you trust.

## Reporting a problem

For non-sensitive bugs, open a GitHub issue with the affected version and a minimal reproduction. Do not post credentials, private project files, personal chats, full model registries or unredacted logs.

If the repository's private vulnerability reporting option is enabled, use it for sensitive security reports. Otherwise contact the maintainer privately before publishing exploit details. The project does not define a separate security support SLA.
