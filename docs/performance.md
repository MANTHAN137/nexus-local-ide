# Performance and unified-memory notes

## Current behavior

Version 0.4.1 was verified on an Apple M5 Mac with 24 GB unified memory using llama.cpp build **10964 / b29c606e2**. The tested 27B GGUF reported `qwen35` architecture and `IQ3_XXS` quantization. Its file size was about 10.18 GiB; logged weight buffers totalled about 9.85 GiB.

All weights are needed even for a tiny prompt. Context starts at 4K and grows to a configured maximum when input plus bounded output requires it. The hybrid-model estimate now separates attention KV from recurrent state and retains only one recurrent checkpoint.

## Short response verification

On 3 October 2026, the same 26-token prompt asking for 2 + 2 returned `4` with a 4K context and an eight-token output allowance:

| Mode | Whole trial, including loading and unloading | Sampled peak process RSS | Lowest reclaimable-headroom estimate |
|---|---:|---:|---:|
| Automatic, partial GPU/CPU | 30.3 seconds | 10.93 GiB | 4.02 GiB |
| CPU compatibility | 43.8 seconds | 10.34 GiB | 8.49 GiB |

These were separate trials under different background-memory conditions. They are **not** a controlled decode-speed benchmark. Both finished without timeout, reported normal pressure at the end, and unloaded their owned model process. The installed app also returned `4` and answered a follow-up with Chrome left open.

This proves short-response feasibility for that model and machine snapshot. It does not prove a complete project build, long conversation capacity, sustained thermal performance, or 9–10 tokens/second. RSS does not represent every Metal allocation. Raw local reports are excluded from the public repository because they contain personal runtime paths and machine state.

## Why partial GPU execution can be slow

Apple silicon uses one physical memory pool for CPU and GPU. Moving layers to CPU does not eliminate their weights or create additional physical RAM. Placement affects which processor computes the layers and how memory is kept resident.

Model focused currently chooses a partial GPU hint from estimated current headroom even after the model passes its physical-memory ceiling. This conservatism can leave CPU layers in every token's execution path. Cool & quiet allows only two low-priority CPU threads, magnifying that bottleneck.

The known direct-run scripts use full GPU offload and runtime defaults. They also use a different server build and default model filename, so the user's reported 9–10 tokens/second is not yet an apples-to-apples comparison. A supervised full-GPU comparison and a revised placement policy were proposed, but not verified or shipped in 0.4.1.

The opt-in `tools/benchmark-model-speed.mjs` is available for controlled measurements. Use the same exact file, cold prompt, context and output limit, and record server decode separately from load/prefill time. Avoid concurrent model processes. A script's experimental full-GPU override does not alter the application policy.

## Residency and safety

In the tested llama.cpp build, selected tensors in a mapped model can span a large file interval. Metal residency can then include much more than the expected per-layer weights. The partial-GPU path therefore uses separate CPU/GPU buffers; CPU compatibility uses file-backed weights without Metal offload. Buffering alone is not a measured steady-state speed optimization.

Protect other apps uses estimated available headroom after an OS reserve. Model focused permits a monitored attempt within a bounded physical ceiling, without labelling other apps' active pages as free. Warning pressure has up to 30 seconds to recover, with five stable normal seconds to clear. Critical pressure, low headroom, excess swap growth or stale telemetry can stop work earlier.

The main process stops work for serious/critical macOS thermal pressure. Cool & quiet changes CPU settings; it does not cap GPU power. Faster full-GPU work could finish sooner while still producing heat, which must be measured rather than promised.

## Primary references

- [llama.cpp model placement and loading, tested commit](https://github.com/ggml-org/llama.cpp/blob/b29c606e2/src/llama-model.cpp)
- [Metal residency, tested commit](https://github.com/ggml-org/llama.cpp/blob/b29c606e2/ggml/src/ggml-metal/ggml-metal-device.m)
- [Apple Activity Monitor memory pressure](https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac)
- [Apple Mac operating temperature guidance](https://support.apple.com/102336)
