# Local Runtime Provisioning Implementation Plan

> **For Hermes:** Execute this plan task-by-task with a separate commit and push after each verified cohesive task. Do not start Sequence 2 until Sequence 1 passes its acceptance gate.

**Goal:** Reliably provision and start one exact locally downloaded GGUF model through an app-managed, pinned `llama-server` runtime, then report a truthful `ready` state after the server has loaded that model.

**Architecture:** SupraCode will continue using an external `llama-server` child process rather than embedding native inference in Electron. The main process owns an app-managed runtime cache, a compile-time runtime manifest, exact model-path resolution, lifecycle control, and health validation. The renderer receives only typed runtime state and requests start/stop by catalog model ID; it never supplies paths, binary locations, or arbitrary server arguments.

**Tech stack:** Electron main/preload/renderer, TypeScript, `llama.cpp` `llama-server`, Node HTTPS/streams/crypto/filesystem APIs, the existing Hugging Face GGUF cache, Node `node:test`.

---

## Status and scope

This document is a planning artifact only. It does not authorize source implementation by itself.

### In scope — Sequence 1 only

- Obtain and securely install one supported `llama-server` distribution.
- Resolve one catalog model to its exact local GGUF path.
- Start that model with a conservative known-good launch profile.
- Report startup, readiness, stop, unsupported, and failure states honestly.
- Prove readiness using an actual `llama-server` health endpoint.
- Add a narrow UI control/status surface for starting and stopping the selected model.

### Explicitly out of scope

- Sending a prompt or rendering a completion.
- Streaming tokens or a conversation timeline.
- Tool calls, file access, terminal execution, or agent approval.
- General model routing, long-context tuning, multi-model parallelism, or background warm pools.
- Bundling model weights in the installer.

Those are retained for later sequences below.

## Current evidence and constraints

- `src/main/llamaRuntime.ts` can locate and launch an already-installed `llama-server`, but no compatible binary exists in this checkout, the source tree has no `vendor/llama.cpp/`, and `llama-server` is absent from `PATH`.
- The app currently recognizes repository-level GGUF presence but does not resolve a selected catalog ID to one exact artifact path.
- `src/renderer/src/modelCatalog.ts` now has `gguf_file` metadata. The initial proof should use the small Qwen 4B Q4_K_M catalog candidate only after its exact artifact, size, and license are validated in the runtime/model manifest.
- The current workstation has an RTX 3090 (24 GiB) and RTX 4090 (about 23 GiB), but GPU selection must be feature-probed at runtime. Do not infer the usable CUDA device from environment-variable ordinal assumptions.
- The default onboarding context choice is 72K. Sequence 1 must not use this directly: the initial known-good profile should start at 8K context, one slot, and conservative batching. Context scaling belongs after a successful load and completion baseline.
- Official llama.cpp supports a loopback HTTP server, `/health`, and OpenAI-compatible `/v1/chat/completions`; only `/health` is part of Sequence 1.

## Decision record

### Chosen runtime model: app-managed pinned `llama-server` distribution

SupraCode should use `llama-server` as a supervised child process and install a platform/backend-specific runtime into an app-managed cache. The app should not rely on a user having an executable on `PATH` and should not execute binaries found next to models.

Initial supported proof target:

- Platform: Linux x64.
- Backend: a pinned, official Ubuntu x64 Vulkan `llama.cpp` distribution, subject to a manual compatibility check on the target machine.
- Model: one exact small Q4 GGUF catalog artifact.
- Server binding: loopback only.
- Context: 8K.
- Parallel requests: one.

This delivers a testable path on the active workstation without pretending that CUDA, Windows, macOS, or arbitrary Linux distributions are already supported. Runtime manifests for other platforms can be designed in the same shape now, but unsupported combinations must fail explicitly.

### Why not the alternatives for the first proof

| Option | Decision | Reason |
|---|---|---|
| `llama-server` child process | **Choose** | Matches existing code, isolates native crashes from Electron, has a stable local HTTP boundary, and avoids Electron-native ABI rebuilds. |
| User-installed `llama-server` only | Developer override only | Fast for developers but unacceptable as the consumer default and impossible to support reliably. |
| Bundle every runtime in each installer | Defer | Makes installers much larger and couples runtime/back-end upgrades to full app releases. May be revisited for offline distribution. |
| `node-llama-cpp` binding | Do not adopt now | Electron/native-module ABI, GPU build, and cross-platform packaging complexity would distract from proving the product loop. |
| Ollama as the primary runtime | Do not adopt now | Adds an external daemon, separate model registry, and lifecycle/control ambiguity. It can become an optional provider later. |

### Trust boundary

- The shipped manifest is the authority for a runtime asset: release identifier, HTTPS URL, archive type, SHA-256, expected extracted executable path, backend, platform, architecture, and companion libraries.
- The model catalog/manifest is the authority for a model: repository, revision, exact GGUF filename, expected size, SHA-256 when available, required projector, supported context ceiling, and compatibility status.
- Renderer requests reference catalog IDs only. Main resolves all paths and rejects unknown identifiers.
- Runtime archives and model weights live in different roots. Never execute a file from the model cache.
- No binary archive or model weight belongs in Git. The repository stores metadata and verification tests only.

## Target lifecycle

1. Renderer asks main for runtime availability for a selected catalog model.
2. Main resolves the catalog ID, exact cached GGUF file, platform/backend manifest entry, and installed runtime receipt.
3. If the runtime is absent, main installs the pinned archive into:
   `app.getPath('userData')/runtimes/llama.cpp/<release>/<platform>-<arch>-<backend>/`.
4. The installer writes to a unique temporary directory, calculates SHA-256 while reading, validates the archive layout, writes a receipt, then atomically promotes the directory.
5. Main launches only the manifest-declared executable, binds it to loopback, captures stderr, and applies a bounded startup timeout.
6. Main reports `starting`; after `/health` succeeds, reports `ready` with runtime version, backend, model catalog ID, exact model path, context size, and effective launch profile.
7. Main owns stop/restart and always tears the child process down on app quit.
8. Renderer can show status and invoke start/stop, but cannot call the local server directly.

## State model

Replace the current overloaded status with separate runtime and model readiness concepts:

- Runtime artifact: `not-installed | installing | verifying | installed | unsupported | failed`.
- Model artifact: `not-downloaded | downloading | verifying | ready | unsupported | failed`.
- Process: `unavailable | stopped | starting | ready | stopping | error`.

Every failure must include a user-safe summary and an internal diagnostic code. Preserve the final bounded stderr tail in main-process diagnostics, never render arbitrary command output as trusted UI.

## Implementation tasks

### Task 1: Freeze the Sequence 1 contract and add failing tests

**Objective:** Establish exact data contracts and prevent the current path/string trust model from spreading.

**Files:**
- Create: `src/shared/runtimeManifest.ts`
- Modify: `src/shared/llama.ts`
- Create: `tests/runtimeManifest.test.ts`
- Modify: `tsconfig.settings-test.json`
- Modify: `package.json`

**Steps:**
1. Define `RuntimePlatform`, `RuntimeArchitecture`, `RuntimeBackend`, `RuntimeArtifact`, `RuntimeInstallState`, `ModelArtifactState`, and a catalog-ID-only `StartModelRequest`.
2. Add a manifest with exactly one initially supported Linux x64 Vulkan artifact. Populate its release URL and SHA-256 only after independently validating a selected upstream release asset; do not leave placeholder hashes in executable code.
3. Add tests that reject unknown platform/backend pairs, invalid HTTPS URLs, missing hashes, relative executable paths, traversal paths, and duplicate runtime identities.
4. Extend the test command so all runtime-manifest tests run locally and in CI.
5. Run lint and tests.
6. Commit and push:
   `test(runtime): define pinned runtime manifest contract`.

**Acceptance:** A runtime cannot be selected unless an immutable manifest entry validates.

### Task 2: Add model artifact resolution, not repository-level detection

**Objective:** Resolve an allowed catalog model ID to exactly one verified local GGUF path.

**Files:**
- Create: `src/main/modelResolver.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/runtimeManifest.ts` or create `src/shared/modelManifest.ts`
- Create: `tests/modelResolver.test.ts`

**Steps:**
1. Centralize model metadata in a shared manifest, or derive a validated manifest from the catalog without importing renderer components into main.
2. Resolve only the configured `gguf_file` below the expected repository/revision cache root.
3. Reject missing files, directories, `.part` files, projector files presented as weights, paths outside the cache root, wrong sizes, and a GGUF whose header is invalid.
4. Return a main-owned `ResolvedModel` object containing catalog ID, immutable path, size, optional projector path, and safe context ceiling.
5. Add table-driven tests using temporary directories and fake GGUF headers; do not use a real model in unit tests.
6. Run lint and all tests.
7. Commit and push:
   `feat(models): resolve exact local GGUF artifacts`.

**Acceptance:** The renderer never supplies an absolute model path, and “a repo contains some GGUF” is no longer treated as runnable.

### Task 3: Implement secure runtime installation into app data

**Objective:** Install the one pinned runtime asset safely and atomically.

**Files:**
- Create: `src/main/runtimeInstaller.ts`
- Create: `src/main/runtimePaths.ts`
- Modify: `package.json` and lockfile only if an archive library is required
- Create: `tests/runtimeInstaller.test.ts`

**Steps:**
1. Define the app-data runtime root and temporary-install root; never use the source `vendor/` directory or the Hugging Face model cache for executables.
2. Download only the manifest URL over HTTPS, stream to a temporary artifact, and calculate SHA-256 during download.
3. Reject an incorrect hash, unexpected size, redirect to a different scheme/host if policy forbids it, malformed archive, missing manifest executable, symlink escape, or unexpected executable permissions.
4. Extract into a unique temporary directory, validate all resolved paths remain beneath it, write an installation receipt, and atomically rename into the final runtime directory.
5. On cancellation/failure, remove only the temporary installation. Never remove an already-valid runtime.
6. Add tests for hash mismatch, path traversal, interrupted download cleanup, idempotent install, and receipt validation using local fixtures/fake downloads.
7. Run lint and all tests.
8. Commit and push:
   `feat(runtime): install pinned llama-server artifacts`.

**Acceptance:** The app can bootstrap the one supported runtime without a user-installed executable, and no unverified binary becomes executable.

### Task 4: Harden the runtime supervisor around a known-safe launch profile

**Objective:** Turn `LlamaRuntime` into a process supervisor for a resolved model and installed runtime.

**Files:**
- Modify: `src/main/llamaRuntime.ts`
- Modify: `src/shared/llama.ts`
- Modify: `tests/llama.test.ts`
- Create: `tests/llamaRuntime.test.ts`

**Steps:**
1. Replace raw `start(modelPath, contextTokens)` with a main-owned resolved model and runtime artifact input.
2. Use the Sequence 1 profile: 8K context, one server slot, bounded batch/microbatch, loopback binding, and no unplanned model-server features.
3. Preserve a developer-only absolute `SUPRACODE_LLAMA_SERVER` override behind explicit development-mode checks. It must still pass executable validation and never become the default release path.
4. Replace environment-variable backend guesses with explicit manifest selection plus a runtime feature probe. If the selected Vulkan runtime cannot initialize on the host, report `unsupported` or `error`; do not silently claim CUDA.
5. Allocate/protect the loopback server endpoint and add a generated in-memory server credential if the pinned server release supports it. Keep that credential in main only.
6. Capture stdout/stderr, report a bounded diagnostic, detect unexpected exit, and make stop idempotent.
7. Test launch argument generation, status transitions, unexpected exit, health timeout, unavailable binary, and shutdown with an injected fake server process. Keep a real-server test opt-in and outside ordinary unit tests.
8. Run lint and all tests.
9. Commit and push:
   `feat(runtime): supervise verified llama-server launches`.

**Acceptance:** A startup result says exactly whether the intended model is actually loaded and reachable at `/health`.

### Task 5: Expose only catalog-ID runtime control through IPC

**Objective:** Replace raw renderer-controlled paths with narrow, typed runtime operations.

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/WindowControls.tsx` global API declaration or move it to a dedicated shared declaration
- Create: `tests/runtimeIpc.test.ts`

**Steps:**
1. Provide `getRuntimeReadiness(modelId)`, `startModel(modelId)`, and `stopModel()` only.
2. Validate sender identity and catalog IDs in main; reject values outside the model manifest.
3. Do not expose `startLlamaServer(modelPath, contextTokens)` to renderer code.
4. Emit status changes through an unsubscribe-safe typed listener instead of requiring the renderer to poll once at mount.
5. Test accepted/rejected IDs, unavailable runtime, unavailable model, process start, process failure, and listener cleanup.
6. Run lint and all tests.
7. Commit and push:
   `feat(ipc): expose model runtime controls safely`.

**Acceptance:** No renderer caller can select an arbitrary executable, model path, port, backend, or command-line argument.

### Task 6: Add a truthful start/stop model-status UI, not chat

**Objective:** Let a user prove the selected model has loaded before the later completion work begins.

**Files:**
- Modify: `src/renderer/src/MainApp.tsx`
- Modify: `src/renderer/src/MainApp.css`
- Create: renderer tests if a test harness is introduced; otherwise include this UI in the first Electron smoke test task

**Steps:**
1. Add a model status panel/menu state with exact states: no model, runtime installing, model unavailable, starting, ready, stopped, unsupported, and failed.
2. Offer Start only for the selected exact downloaded model and Stop only when a child process exists.
3. Show the effective backend and conservative 8K context profile; do not present user-selected 72K as active until later tuning exists.
4. Make errors actionable: runtime missing, runtime incompatible, model missing/corrupt, insufficient resources, health timeout, or unexpected exit.
5. Keep Send disabled or explicitly label it unavailable until Sequence 2. Do not create a fake send path.
6. Manually verify keyboard/focus behavior and state transitions.
7. Run lint and all tests.
8. Commit and push:
   `feat(ui): show local model runtime readiness`.

**Acceptance:** A user can see an honest Ready state after the model is loaded, rather than a generic green dot or inert composer.

### Task 7: Run the real-machine proof and package smoke

**Objective:** Prove this is a real model runtime, not only a fake-server unit-test success.

**Files:**
- Modify: `package.json` to add an opt-in smoke command
- Create: `scripts/runtime-smoke.mjs`
- Create: `tests/runtimeSmoke.test.ts` only if it can remain environment-gated and non-networked by default
- Modify: CI configuration when it exists; do not force multi-gigabyte model downloads in standard CI

**Steps:**
1. Download/install the pinned Linux x64 Vulkan runtime on the active Linux machine.
2. Download one exact manifest-approved small GGUF model through SupraCode’s model flow.
3. Start it with the Sequence 1 8K profile.
4. Verify the child PID, `ready` state, loopback `/health`, model path, backend, and bounded stderr diagnostics.
5. Record wall-clock install/start timing and GPU/CPU/RAM observations without claiming throughput yet.
6. Stop the runtime, restart it once, then quit the app and verify child cleanup.
7. Run `npm run lint`, full Node tests, production build, and the opt-in runtime smoke.
8. Commit and push only source/test/config changes; never commit the downloaded binary, model, generated `out/`, `.test-dist/`, or `dist/` artifacts.
9. Commit and push:
   `test(runtime): add opt-in local llama-server smoke`.

**Acceptance gate for Sequence 1:** On a clean app-data runtime cache, SupraCode installs one pinned runtime, resolves one exact downloaded model, starts one `llama-server` child process, receives a successful loopback health response after the model loads, exposes `ready` in the UI, and reliably stops the process. Any failure is explicit and diagnosable.

## Verification matrix

| Level | Required proof | Runs by default? |
|---|---|---|
| Unit | Manifest validation, model-path containment, hash checking, receipt validity, state transitions, argument builder | Yes |
| Process integration | Fake child server health success/timeout/exit/cancellation | Yes |
| App integration | Main/preload catalog-ID-only IPC and renderer status updates | Yes once Electron test harness exists |
| Real runtime smoke | Pinned downloaded runtime + exact GGUF + `/health` on supported host | Opt-in only |
| Package smoke | Packaged app finds its managed runtime store and reports missing/installed state | Yes after packaging is configured |

## Security and operational gates

- No runtime URL without HTTPS, pinned release metadata, and SHA-256 verification.
- No model ID or model path supplied as trusted renderer input.
- No executable loaded from the Hugging Face cache or source tree.
- Loopback-only server; no `0.0.0.0` binding.
- Keep server credential, diagnostics, and child process control in main only.
- Do not log tokens, prompts, provider credentials, or full environment variables.
- Do not commit runtime archives, DLLs, model weights, cache directories, `node_modules`, `out`, `.test-dist`, or `dist`.
- Treat GPU support as a measured runtime capability, not a `CUDA_PATH` heuristic.

## Remaining execution sequence

This order is binding unless evidence requires revisiting the architecture:

1. **Sequence 1 — Runtime provisioning and model load:** this plan. End at a truthful `ready` model state after `/health`.
2. **Sequence 2 — Direct completion proof:** main process sends one minimal OpenAI-compatible `/v1/chat/completions` request to the ready local server and receives a non-streamed response. Add an integration smoke before UI work.
3. **Sequence 3 — Typed streaming boundary:** main parses server-streamed SSE, exposes cancellable typed request/delta/completed/failed events over IPC, and owns queue/lifecycle semantics.
4. **Sequence 4 — Tiny usable conversation UI:** prompt submit, optimistic user message, assistant delta rendering, Stop, retry, and truthful errors. The send control ceases to be inert here.
5. **Sequence 5 — Read-only coding context:** workspace selection, file listing/reading/search, Git status, and visible action timeline.
6. **Sequence 6 — Safe actions:** diffs, approval policy, scoped terminal/filesystem tool execution, and audit history.
7. **Sequence 7 — Performance and product hardening:** model routing, context management, warm pools, measurement, accessibility, release packaging, and CI/E2E coverage.

Each sequence must end with a commit, push, tests appropriate to the touched layer, and a written stop/go note before work begins on the next sequence.
