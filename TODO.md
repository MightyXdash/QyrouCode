# SupraCode TODO

Audit-derived backlog for turning the current onboarding/model-download shell into a responsive, safe local coding platform. This is intentionally ordered by dependencies and user value rather than by implementation convenience.

## P0 — Make the product real

- [ ] Replace the blank post-onboarding main view with an explicit workspace shell.
  - Project picker or recent-project empty state.
  - Installed/active-model status and model switcher.
  - Conversation timeline, composer, stream state, Stop, retry, and useful errors.
  - Honest no-model state with paths to download a recommended model, connect a local server, or open model settings.
- [ ] Define a typed agent event protocol shared by renderer, preload, and main.
  - Request accepted, queued, model loading, context progress, token delta, tool proposal, approval required, tool running, tool output, diff ready, completed, failed, cancelled.
  - Propagate cancellation through UI, IPC, runtime, and tools.
- [ ] Implement one supported local inference adapter behind a `ModelRuntimeManager`.
  - Model discovery/loading/unloading, hardware compatibility, context budgeting, streaming, cancellation, and runtime errors.
  - Run inference and expensive indexing outside the renderer and keep Electron main as a coordinator/security boundary.
- [ ] Add read-only project tools first: list files, read files, text search, and Git status.
  - Render each action in a live timeline with target, rationale, progress, elapsed time, and outcome.

## P0 — Security and release baseline

- [ ] Upgrade Electron from the vulnerable 34.x line after compatibility testing.
- [ ] Explicitly enable hardened Electron web preferences: sandbox, context isolation, disabled Node integration, restrictive navigation and permission policies.
- [ ] Make privileged IPC capability-based and validate every request in the main process.
  - Do not allow renderer-supplied arbitrary Hugging Face repositories, paths, or tool arguments.
  - Keep future approval enforcement in main/services, never only in renderer UI.
- [ ] Define a trusted model manifest: repo, revision, exact file, size, SHA-256, capability metadata, and supported runtime configuration.
- [ ] Contain and validate all model artifact paths below the managed cache directory.
- [ ] Unify the package name, build app ID, and runtime User Model ID before user data, updates, or release infrastructure become established.

## P1 — Reduce time to first useful interaction

- [ ] Make one compatible user-selected model sufficient to enter the workspace.
- [ ] Move router, title, and summarizer downloads to a managed background queue with clear feature labels.
- [ ] Add hardware/RAM/VRAM/free-disk preflight, estimated download size/time, and one recommended default model.
- [ ] Replace the forced serial onboarding queue with bounded, configurable concurrency after measuring disk/network behavior.
- [ ] Add pause, resume, cancel, skip-failed, retry-all, reconnect, and launch-while-downloading flows.
- [ ] Verify downloads with HTTP status checks, timeouts, retries/backoff, resumable partials, size checks, hashes, and format validation.
- [ ] Persist model readiness states: not-downloaded, downloading, paused, verifying, ready, unsupported, and failed.
- [ ] Coalesce download progress before IPC/React updates; do not render once per network chunk.

## P1 — Make AI interactions feel snappy

- [ ] Echo user messages immediately and show a meaningful progress state within one interaction frame.
- [ ] Stream output in coalesced UI batches; do not wait for full completions or rerender an entire history per token.
- [ ] Keep the active model warm when resources permit; background warm-up must never block workspace paint.
- [ ] Put context building, retrieval, Git inspection, and high-volume parsing in workers or child processes.
- [ ] Add compact action cards for planned/running/completed tools with risk, target, elapsed time, cancel, and outcome.
- [ ] Add stop, regenerate, and interruption-safe task queue behavior.
- [ ] Virtualize long conversation, terminal, and tool-output histories.
- [ ] Instrument p50/p95 app-ready, workspace-ready, model load, queue wait, submit-to-first-token, tokens/sec, tool start/result, renderer frame time, and end-to-end task completion.

## P1 — Make saved preferences truthful

- [ ] Wire theme, context-window choice, model tiers, automatic routing, reasoning effort, response style, and custom instructions to runtime/UI behavior.
- [ ] Until each preference has a contract and observable effect, remove it from onboarding or label it as unavailable.
- [ ] Provide a normal settings surface and a safe way to revisit onboarding/model choices.
- [ ] Separate non-sensitive local preferences from future secrets; store credentials/tokens in the OS keychain rather than Electron Store JSON.

## P2 — Build the coding workspace safely

- [ ] Add workspace authority: project trust, scoped filesystem access, recent projects, and a clear working-directory boundary.
- [ ] Add file tree, editor, search/indexing, diff preview/apply, and change review.
- [ ] Add terminal sessions with scoped working directories, captured output, cancellation, and explicit approval gates.
- [ ] Add Git status/diff/commit-aware workflows and language-service integration.
- [ ] Establish a tool registry, risk classifier, permission broker, audit trail, and rollback/review affordances.

## P2 — Break up the onboarding monolith and improve accessibility

- [ ] Split onboarding, model management, workspace shell, chat/timeline, settings, and terminal into route/component boundaries.
- [ ] Replace clickable role/model `div`s with keyboard-native controls and clear screen-reader state.
- [ ] Apply light/dark/system theme settings; avoid global text-selection restrictions in coding surfaces.
- [ ] Add responsive layouts beyond reduced-motion support.
- [ ] Remove or replace decorative workspace imagery that promises features unavailable after handoff.

## P2 — Quality and shipping

- [ ] Restore reproducible local verification: `npm ci`, lint, settings tests, build, and package smoke checks.
- [ ] Add unit tests for settings, IPC validation, model manifest/path validation, downloader state transitions, and runtime adapters.
- [ ] Add renderer integration tests for streaming, cancellation, errors, and approval interactions.
- [ ] Add Electron end-to-end smoke tests covering first-run, returning-user, model-unavailable, download failure, and workspace launch paths.
- [ ] Add CI gates for lint, test, build, package smoke, dependency audit, and artifact metadata checks.
- [ ] Configure release metadata, Linux maintainer identity, signing/notarization, publishing/update strategy, and cross-platform validation.

## Current constraints to preserve

- Do not treat a downloaded GGUF as a usable model until the exact artifact is verified and a runtime confirms compatibility.
- Keep renderer APIs narrow; do not expose generic filesystem, process, or shell primitives through preload.
- Optimize measured time-to-first-use, time-to-first-token, tool latency, and task completion—not onboarding animation alone.
- Do not claim local-model, routing, approval, or agent capabilities until they are connected to executable behavior.
