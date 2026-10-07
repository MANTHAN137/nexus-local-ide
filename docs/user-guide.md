# Nexus — local project agents for macOS

Nexus is an Electron/React editor for working with local GGUF models through llama.cpp. Version 0.4.1 adds a responsive, resizable workbench, complete project file tools, sequential agent roles, memory admission checks, automatic unloading, activity reporting, and sandboxed local MCP servers.

## Start

Open `release/mac-arm64/Nexus.app` or **Launch Nexus.command** after building the package. For development:

```sh
npm ci
npm start
```

1. **Open project** (⌘O) selects the folder agents may modify. Authorization is session-only.
2. Add GGUF files in **Model library**, then select a model. Files stay at their original locations.
3. In **Settings → Agent assignments**, enable Builder, Reviewer and/or Tester and assign a model to each. Unassigned roles use the selected model. Roles execute in that order, with one model loaded at a time.
4. Optionally configure and enable MCP in Settings. The icon beside the composer always shows MCP ON/OFF.
5. Send a task in **Agent** mode. Actions, file operations, checks and role status appear in the assistant and **Activity** panel. Stop cancels generation, checks and MCP processes; saved files remain.

Chat answers questions; Edit proposes a reviewed change to the active file. Agent mode performs the actual file operations. The selected model reloads automatically after an idle unload.

## Workbench

Drag the separators to resize Explorer, the editor/main area, chat, and the bottom Terminal/Logs/Activity area. Focus a separator and use the arrow keys, Home or End for keyboard resizing. Pane proportions persist locally. Narrow windows use an Explorer drawer and switch between the main view and chat using the assistant toggle.

The terminal runs project checks (`node`, supported `npm` scripts, and Python). It is a command/output surface rather than a general interactive PTY. It supports quoted arguments; shell operators, network access and package installation are unavailable. Use the Logs tab for llama.cpp output.

## Project access

The selected project grants create, read, edit, rename, move and delete access, including project configuration and dotfiles. Agents have `list_files`, `stat_path`, `read_file`, `write_file`, `append_file`, `replace_in_file`, `create_directory`, `move_file`, `rename_file`, `delete_file`, `run_check`, and optional `mcp_call` tools.

File operations use a trusted, bounded filesystem broker running in the macOS project sandbox with Electron’s embedded Node runtime; no external Node installation is required. The OS boundary also blocks path-swap races during file operations. Model-generated absolute paths inside the selected folder are normalized to relative paths before execution. Paths outside the project, traversal, symlinks and hard-linked file operations are rejected. Existing files must be read or inspected before modification; content hashes reject stale writes, moves and deletes. Moves refuse existing destinations. Directories can be moved, and deleted once empty. Binary/large files can be inspected, moved and deleted; agent text edits are limited to 512 KB. The editor supports text files up to 2 MB.

Executable project checks and MCP servers require macOS `sandbox-exec`. They have write access only to the project and private temporary storage, and read access to their runtime dependencies. Network and application-control access are denied. There is no unrestricted command fallback. Install Node/Python and any dependencies separately if your checks need them. Choose a specific project folder, not your home, Desktop, or a system directory.

The explorer and initial agent inventory are bounded to avoid traversing dependency trees. The agent can inspect deeper paths explicitly. Agent tasks have an 80-action/30-minute budget, checks time out after two minutes, and repeated identical actions stop the task. A reported passing check means the command actually exited successfully, not that all possible behavior was tested. Agent follow-ups include bounded prior conversation text, so “continue” and “according to the above” retain earlier requirements. Large files can be written in smaller append operations. Action generation streams progress counts without exposing hidden reasoning; stalled generation stops after 45 seconds without new content, initial prompt evaluation has a three-minute limit, and one action has a five-minute maximum. Transport/compute failures stop immediately instead of being retried as malformed JSON. Errors remain visible in the conversation. The host validates action bounds even if the runtime does not enforce its grammar. Complete valid JSON at the token limit is retained. Stable task prefixes permit prompt reuse, repeated failed checks require a real repair, and identical rewrites do not count as progress. Coding quality depends on the selected model.

## Apple silicon memory and energy

Settings also displays the macOS thermal state. Serious or critical thermal pressure stops the current task and unloads the model; starting another task is blocked until the system cools. Cool & quiet reduces CPU threads and batches, but does not cap Metal GPU power.

The defaults target this Mac's Apple M5 and 24 GB unified memory. Active tasks prevent automatic app suspension; the display can sleep, and the assertion is released when work ends:


- **Context grows as needed.** The context selector is a maximum, not a preallocation. Chat/manual/agent loads begin at 4K. Exact prompt token counts plus a bounded output allowance trigger growth before generation. Auto has a 32K maximum; an explicit maximum supports larger conversations when memory permits. Growth stops the old process before reloading a larger cache, so it may add latency between responses. Model weights are necessary even for a short message.
- **Memory policy is selectable.** The default, **Protect other apps**, requires current estimated headroom after reserving memory for macOS. **Model focused** permits a monitored macOS-managed load when estimates fit the physical RAM ceiling and a fresh system sample reports normal pressure. macOS may compress background apps to cover the difference from the available-memory budget. When full Metal offload exceeds available headroom, Model focused can limit GPU layers and process the remaining weights in CPU buffers; this may be slower. All model weights are still required, and the fitting estimate does not guarantee free RAM or successful loading. Eligibility does not mean background app pages are free RAM, and work stops if pressure becomes critical or fails to recover. Both policies cap model admission at 75% of physical memory. Existing model processes exit before the next model starts. Admission reports weights, token cache, recurrent state, buffers/margin, current budget and the actual shortfall; Settings shows the loaded policy, admission mode and partial GPU offload when used. The displayed headroom is a reclaimable-memory estimate, not Activity Monitor's exact Memory Used. A 27B Q3 model can fit this 24 GB Mac under appropriate conditions; parameter count and a short prompt alone do not guarantee that it fits alongside other apps.
- **Processing mode is selectable.** Automatic uses GPU acceleration where possible. CPU compatibility uses file-backed mapped weights and avoids Metal buffer pinning, which can help larger models when Metal loading is constrained. It may be slower and still needs access to all model weights; energy-profile CPU thread limits apply. Settings shows the processing mode used by the loaded model.
- Flash Attention, Q8 KV caches, one inference slot, no RAM prompt cache, smaller batches, bounded CPU threads and disabled worker polling reduce resource demand. **Cool & quiet** further reduces threads and batch size and lowers CPU process priority. Hybrid recurrent models retain at most one checkpoint instead of the runtime default of 32. This bounds saved state without removing all prompt reuse. Changing energy profile or maximum context unloads an idle model so the next request applies the setting.
- Idle models unload after 30 seconds to 5 minutes (default 2 minutes). Active tasks hold a lease so models cannot unload between tool calls. Task histories are trimmed, logs and visible conversations are bounded, and MCP process groups and scratch directories are cleaned up after each role.
- System memory, available/reclaimable memory, OS pressure, Nexus process memory and model resident memory are sampled periodically. A temporary pressure warning has up to 30 seconds to recover, with 5 seconds of normal pressure required to clear it. Critical pressure, less than 1 GB headroom or more than 2 GB swap growth stop work early. Unrecovered warning pressure also stops work and unloads the model, preserving saved files. Current warnings appear in Settings.
- Monaco loads only when the editor is opened. Model discovery relies on filesystem events with a five-minute fallback scan.

Estimates and resident memory do not capture every Metal allocation and cannot guarantee that a runtime never exhausts memory. Pressure monitoring is a backstop. The UI labels the measurements; it does not claim temperature or energy measurements. Other inference applications are not controlled or terminated by Nexus.

## MCP

MCP uses the official TypeScript SDK with a bounded stdio transport. Add a name, an absolute installed executable path, and a JSON array of arguments. For example:

```json
["/path/to/installed/server.js", "${PROJECT_ROOT}"]
```

`${PROJECT_ROOT}` is substituted at connection time, and the MCP roots capability advertises the selected project. Servers can be added, removed, enabled and disabled individually. The global switch controls whether agents discover or invoke tools. Servers connect on demand and disconnect after each role, including cancellation or failure. Tool descriptions and results are treated as untrusted observations. Binary responses are omitted and text results are capped.

This release supports **local stdio servers** only. Remote HTTP/SSE servers, OAuth and network-dependent tools are not supported. Install servers separately; the app does not run package installers. Local MCP servers use the same project sandbox as checks and cannot grant agents broader filesystem permissions.

## Development and validation

```sh
npm test
npm run build
npm run package:mac
```

The test suite includes native macOS sandbox checks, real MCP handshake/discovery/invocation, filesystem boundaries, external-change conflicts, memory planning, agent sequencing and cancellation. Run sandbox tests from a normal macOS terminal; nested execution sandboxes may deny `sandbox-exec` before tests begin.

`NEXUS_DATA_DIR` selects isolated app data for desktop tests; `NEXUS_LLAMA_BINARY` selects an alternate runtime executable. `npm run dev` is a browser design preview and cannot access native files or models.

The local package is unsigned. Model weights and llama.cpp are not bundled. MCP server definitions, model registrations, agent assignments and resource preferences persist in the normal application-data directory; conversation content and project authorization are session-only.

## Implementation

- `electron/scoped-files.mjs`: file broker and optimistic conflict checks.
- `electron/sandbox.mjs`: command confinement and process cleanup.
- `electron/memory.mjs`, `runtime-config.mjs` and `runtime.mjs`: hybrid GGUF estimates, on-demand context growth, model-load cancellation and inference lifecycle.
- `electron/agent.mjs` and `team.mjs`: validated actions and sequential roles.
- `electron/mcp.mjs` and `mcp-transport.mjs`: configuration, discovery and owned server processes.
- `src/WorkbenchControls.jsx`: accessible resizing, resources, roles, MCP, activity and terminal controls.
- `src/CodeEditor.jsx`: lazy Monaco setup.

Technical references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [llama-server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).
