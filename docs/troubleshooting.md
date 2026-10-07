# Troubleshooting

## The agent did not create files

Use the desktop app, choose **Open project**, and select **Agent** mode. Browser preview cannot write to native projects. Chat answers questions; Edit proposes a change to the current file. Check that Builder is enabled and has a valid model assignment. Inspect Activity for the actual action, tool error or stop reason.

Project authorization is session-only. Reopen the intended folder after a restart. Existing files must be read before modification, and a stale content version is rejected. Symlinks, outside paths and overwriting move destinations are not allowed.

A task may stop for malformed model output, repeated actions, failed checks without repairs, stalled generation, memory pressure, heat or its task budget. Stop retains already saved files. A stopped task is not proof that its requested output was completed.

## A model reports insufficient memory

Look at both the estimated model requirement and the available-memory budget in Settings. The requirement includes all weights, cache/state, working buffers and margin. A short prompt reduces cache needs, but not weight size.

Maximum context is a ceiling: loads start at 4K and grow when the real conversation requires it. Protect other apps reserves current headroom; Model focused may permit a monitored load under its physical ceiling when macOS reports normal pressure. It is not a promise that all background processes will fit.

On Apple silicon the CPU and GPU share RAM. Activity Monitor's Memory Used and Nexus's reclaimable-headroom estimate measure different things. Look at memory pressure and the selected policy instead of treating cached or compressible pages as empty RAM.

If a warning persists or a hard limit is reached, the app unloads the model. Let the system recover, use a smaller model, shorten the conversation, or try CPU compatibility. CPU compatibility remains slower and still requires access to all model weights.

## Tokens arrive slowly

Model focused in 0.4.1 can leave layers on the CPU based on estimated headroom. Every generated token waits for that CPU work. Cool & quiet limits CPU processing to two threads and smaller prompt batches; it can substantially slow a partially offloaded model.

Check the loaded policy and GPU-layer notice, then the server's `prompt eval` and `eval` timing lines. Prompt evaluation, cold model loading and token decoding are different measurements. Compare the same model file, prompt, context, output length, server build and background load. The repository does not claim a verified full-GPU speed fix or guaranteed 9–10 tokens/second. See [performance notes](performance.md).

## The laptop becomes hot

Local generation can keep the GPU busy even for a small-looking request. Long outputs and repeated agent actions extend the time spent computing. Cool & quiet reduces CPU work and priority; it does not cap Metal GPU power. Settings reports macOS thermal state, rather than a measured temperature.

Stop a task you no longer need and shorten idle-unload delay. Serious or critical thermal state triggers cancellation and unloading. Keep the Mac ventilated and follow the computer manufacturer's temperature guidance.

## Runtime fails to load

Choose a valid installed `llama-server` in Settings. Read the first error in Logs. Check GGUF validity, complete split shards and flag compatibility with the tested runtime build. A renderer rebuild does not update an already packaged app; package again after source changes.

## MCP tools are unavailable

Check MCP ON beside the composer, the global switch in Settings, and each server's enabled flag. Use an absolute installed executable path and a JSON array of arguments. `${PROJECT_ROOT}` is substituted at task connection time.

The server must work through local stdio under a sandbox without network. Remote servers, authentication flows and package installation are unsupported. Discovery and call failures appear as task errors; tools cannot expand the project boundary.

## Tests fail in a sandbox

Run `npm test` from a normal macOS terminal. An outer sandbox may reject nested `sandbox-exec` before a test begins. Native sandbox assertions require macOS and are not equivalent to running only JavaScript tests on Linux.

## Report a reproducible bug

Include Nexus version, macOS/architecture, Node/runtime versions, model architecture and quantization, selected resource settings, a small reproducible prompt and the relevant redacted error. Use a temporary project. Omit secrets, personal paths and full conversations.
