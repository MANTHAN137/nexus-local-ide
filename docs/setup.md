# Setup and development

## Prerequisites

Nexus 0.4.1 is developed and tested on Apple silicon macOS. Project command and MCP execution relies on the macOS `sandbox-exec` binary. Browser previews work without a native inference setup, but cannot operate on your project files.

Install Node.js 22.12 or newer and npm. With nvm, use `nvm install` and `nvm use` from the repository root. Install dependencies with `npm ci` so the checked-in lockfile determines versions.

## Desktop workflow

```sh
npm ci
npm start
```

`npm start` builds the Vite renderer and starts Electron. For renderer iteration, `npm run dev` starts the browser preview; `npm run build` builds the production renderer. `npm run desktop` starts Electron using the last renderer build, so run a build first after changing renderer code.

## llama.cpp and models

Install a trusted local llama.cpp distribution separately. On Apple silicon, Nexus searches the configured location, `NEXUS_LLAMA_BINARY`, common Homebrew locations and PATH. You can also choose the executable in **Settings → Locate executable**.

The tested server is build **10964 / b29c606e2**. Its flags include Flash Attention, Q8 KV caches, context checkpoints, reasoning control, GPU fitting and explicit model-load modes. An older or incompatible runtime may reject these options; inspect the Logs panel and use a compatible runtime rather than removing safeguards.

Add a valid GGUF file through **Model library**. For split GGUFs, select the first shard and keep all remaining shards beside it. Nexus references models in place; it neither downloads nor copies model weights. Respect the model publisher's license.

Start with a smaller model to check the workflow. Keep maximum context on Auto unless the task requires a different ceiling. Auto begins at 4K and can grow to 32K when the actual request requires it.

## Project access

Open a dedicated project folder. Agent mode can write directly within that selected folder; Edit mode offers a review step for the current file. Choose a disposable example project for your first agent run. Use version control for work you need to retain.

The included `example-project/` is a small TypeScript editing example. It has no package installation or test scripts. Dependencies for your own project checks must already be installed; Nexus checks cannot install packages or access the network.

## Packaging

```sh
npm run package:mac
```

The builder packages an application directory for the current host architecture. On an Apple silicon host the result is `release/mac-arm64/Nexus.app`. Open it normally, or run `Launch Nexus.command`. The launcher expects this Apple silicon output path. A desktop alias can point to the packaged app after a local build.

The package is unsigned. Signing, notarization, installers and downloadable release binaries are outside the current repository workflow. The source repository includes the app icon, but excludes Electron binaries, app bundles, weights and personal runtime logs.

## Validation

```sh
npm test
npm run build
```

The suite uses temporary projects and mocked inference where appropriate. It covers actual filesystem sandbox boundaries and local MCP protocol exchanges. It does not require a model download or run a model benchmark.

The GitHub workflow uses a macOS runner and Node 22 to run the same suite and renderer build. Model performance must be verified separately on the intended hardware.

## Isolated desktop data

`NEXUS_DATA_DIR` selects an isolated application-data directory for desktop testing. `NEXUS_LLAMA_BINARY` selects an alternate local server. Avoid using your real model registry or MCP configuration when testing persistence changes.

## Optional hardware checks

The scripts under `tools/` are opt-in, bounded hardware checks. They require an existing local model, can consume significant CPU/GPU and RAM, and always attempt to stop the model they start. They are not part of CI.

```sh
node tools/verify-large-model.mjs /absolute/path/to/model.gguf
NEXUS_VERIFY_CPU=1 node tools/verify-large-model.mjs /absolute/path/to/model.gguf
```

The experimental speed comparison supports `NEXUS_BENCH_GPU=current|full` and `NEXUS_BENCH_POWER=cool|balanced`. Run both modes with the same model and output limit, and compare server-reported decode separately from prompt evaluation. Results are local files under the ignored `verification/` directory. Full-GPU benchmarking is not evidence that the installed application's current policy uses full offload.
