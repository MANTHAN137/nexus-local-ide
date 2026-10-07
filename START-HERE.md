# Start Nexus 0.4.1

Open the **Nexus** desktop icon, **Launch Nexus.command**, or `release/mac-arm64/Nexus.app`.

1. Open your project folder (⌘O).
2. Add/select a local GGUF model.
3. Settings → Agent assignments: choose the roles and models you want.
4. Optionally add local MCP servers and turn MCP ON.
5. Use Agent mode to create, edit, rename, move, delete and test project files.

Drag pane separators to adjust the layout. Settings shows current memory, model weights/cache estimates, loaded models and a manual Unload button. Maximum context starts with a small cache and grows when needed. Terminal, Logs and Activity share the resizable bottom panel.

Protect other apps is the default memory policy. Model focused permits a monitored attempt for larger models within a physical RAM ceiling, using partial GPU loading when needed. macOS may compress background apps, loading can still fail, and work stops if pressure becomes critical or fails to recover. A temporary warning has up to 30 seconds to recover, with 5 seconds of normal pressure required to clear it; low headroom or growing swap can stop work earlier.

Settings → Processing mode offers Automatic (GPU) and CPU compatibility. CPU compatibility uses file-backed model weights to avoid Metal buffer pinning and may be slower. Cool & quiet lowers CPU priority, threads and prompt batches in either mode; local inference can still produce heat.

Models load one at a time and unload after inactivity. The next task reloads the selected model. Stop preserves files already saved. MCP supports installed local stdio servers inside the project sandbox; remote transports and package installation are not included.

See README.md for requirements, limits and test commands. Developers can use `npm start` for source changes and `npm run package:mac` to refresh the packaged app.
