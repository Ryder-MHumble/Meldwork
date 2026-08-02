# Verification And Test Coverage

Verification evidence below spans 2026-07-29 through 2026-08-02 on macOS arm64. Repository tooling and CI support Node.js 20.19 or newer; the packaged desktop runs on Electron's bundled Node.js runtime. On 2026-08-02, the Harness / Run Ledger working tree completed the current frontend and desktop suites, both renderer builds, arm64 package validation, and strict ad-hoc signature verification. Unchanged distribution, smoke, and audit rows retain their earlier executed baseline.

## Executed Verification

| Check | Evidence | Result |
| --- | --- | --- |
| Frontend unit suite | `npm --prefix frontend test` | 165/165 tests passed on 2026-08-02 |
| Desktop unit suite | `npm --prefix desktop test` | 378/378 tests passed on 2026-08-02 |
| CI Node adapter compatibility | `npx -y node@20.19.0 --test desktop/test/cli-adapters.test.cjs` | 71/71 tests passed |
| Renderer builds | `npm --prefix frontend run build` and `npm --prefix frontend run build:desktop` | Both Vite builds passed on 2026-08-02 |
| Current desktop package validation | `npm --prefix desktop run pack -- --config.electronDist=<checksum-verified Electron 39.8.5 cache zip>` and `codesign --verify --deep --strict desktop/dist/mac-arm64/Meldwork.app` | Pack passed for the macOS arm64 app directory using the official cached Electron zip whose SHA-256 matched Electron's bundled checksum; strict verification passed with an ad-hoc signature on 2026-08-02. This is not Developer ID signing or notarization |
| Harness / Run Ledger automated regression coverage | `frontend/src/__tests__/roundrelay/App.spec.js`; `desktop/test/run-harness.test.cjs`; `desktop/test/run-ledger.test.cjs`; `desktop/test/local-workspace.test.cjs` | Included in the passing 2026-08-02 suites: live and durable trace UI contracts, streamed terminal conclusions and compact evidence handoff, bounded sanitized checkpoints, fail-closed malformed or ambiguous stores, Unicode session continuity, restart-stable run outcomes, retryable transactional mutations, full reconciliation, and stale run-ID stop rejection. Packaged runtime acceptance is recorded below |
| Electron Hermes SQLite smoke | Temporary Hermes-shaped `state.db` queried through Electron with `ELECTRON_RUN_AS_NODE=1` | Electron 39.8.5 / Node.js 22.22.1 loaded `node:sqlite`; the watermark excluded the previous turn and `tool_calls`, a post-watermark `length` result was accepted, and a later `stop` result took precedence |
| macOS distribution | `npm --prefix desktop run dist` | arm64 `.app`, DMG, and ZIP produced |
| Production dependency audit | `npm --prefix desktop audit --omit=dev` and `npm --prefix frontend audit --omit=dev` | 0 known vulnerabilities in both production dependency sets |
| ACP runtime packaging | Inspect and extract packaged `app.asar`, then dynamically import its production modules | `@agentclientprotocol/sdk` 0.23.0, `zod` 4.4.3, the ACP client, and both inbound Zod validators loaded successfully |
| Focused packaged-app smoke | Launch the packaged `.app` with a fresh temporary user-data directory and attach through local CDP | First-run carousel loaded with focus, inert background, no horizontal overflow, and an enabled `Start using` state; the redesigned group modal created a real temporary group without error; `@` loaded local Skills; a synthetic clipboard image crossed preload/IPC and rendered a 64x64 preview; normal application quit left no Meldwork process or debug listener |
| Packaged Harness group acceptance | Launch the exact `desktop/dist/mac-arm64/Meldwork.app` with isolated profile `/tmp/meldwork-harness-evidence.6ongai`, CDP port `9566`, and ChatGPT Codex `0.146.0-alpha.9.2`; inspect five-Agent group `8fb9b2db-c3ba-4fe3-8465-87dcdc809614`, run `946f6f36-e999-446b-a52e-6f713a7692b3` | Only Hermes then Codex ran; OpenClaw, Claude, and WorkBuddy were excluded. Hermes retained marker `E-R1-HERMES-01` as a sanitized partial `tool_start` for `read: docs/architecture.md`; Codex source IDs and native session input included that evidence and its conclusion contained `EVIDENCE_TOOL_SEEN`. The historical right panel showed both Agent tabs, remained open when another run finished, and group process details did not render inline |
| Packaged Harness direct acceptance | In the same exact packaged app/profile, inspect direct conversation `e85c04a5-6029-4c68-91aa-2696b759f64a` during and after a real Codex run | While running, conclusion and tool/status details streamed inline with no right panel. After completion, marker `DIRECT_LIVE_CAPTURE_OK` remained, execution details collapsed with two durable tool events, and no right panel appeared. The app then quit cleanly and both its PID and CDP listener were gone |
| Logo packaging | Compare source, Vite output, and packaged asar hashes; inspect generated `icon.icns` and packaged UI | The final 3D Relay Fold app/product PNGs match source byte-for-byte in the package, and the packaged renderer loads the 1024x1024 brand asset |
| Idle startup network | Inspect the Meldwork process tree with `lsof` after disconnecting CDP | No established TCP or UDP connection; only the explicitly enabled loopback CDP listener remained |
| Empty-store secure-storage behavior | Unit tests plus a one-second process sample | No `SecItemCopyMatching`, `SecKeychain`, `CSSM_Decrypt`, or decrypt call observed without a stored Provider |
| macOS signature | `codesign --verify --deep --strict` | Passed with ad-hoc signature; `spctl` rejection is expected until Developer ID signing/notarization exists |

The general focused packaged smoke exercises the first-run UI, group creation, Skill IPC, and clipboard attachment IPC without executing a real Agent CLI. The separate Harness acceptance above exercised real Hermes/Codex group trace relay and a real Codex direct run. Later source changes still require a fresh package smoke before release.

## Automated Coverage

| Use case / rule | Expected behavior, including deny case | Evidence | Status |
| --- | --- | --- | --- |
| Renderer workbench and onboarding | Shows the configured Agent catalog, gates the first-run carousel on Agent detection, supports focus/scroll/back dismissal, local groups/direct chats, theme, and locale | `frontend/src/__tests__/roundrelay/App.spec.js` | Passed locally |
| Conversation run UX and session management | Shows Agent logos and capabilities, multiple direct sessions, rename/delete controls, distinct running animation, per-Agent queued/running/completed state, automatic current/max round progress, active-topic expansion, exact warning dismissal, collapsed process details, background direct completion markers, unavailable-Agent history access, and truthful permission/image limits | `frontend/src/__tests__/roundrelay/App.spec.js`; `desktop/test/main-security.test.cjs` | Passed locally |
| Harness trace and Run Ledger durability | Streams allowlisted per-Agent trace and live context state, retains compact completed/partial/failed/stopped/timeout/interrupted traces, visibly renders streamed terminal conclusions, hands later Agents bounded source-addressable evidence, checkpoints sanitized run state, fails closed on malformed values, provenance conflicts, and duplicate identities, preserves Unicode conversation sessions, reconstructs durable turn outcomes after restart, keeps mutations retryable, reconciles terminal checkpoints idempotently, rejects stale run-ID stop requests, and purges ledger records with deleted conversations | `frontend/src/__tests__/roundrelay/App.spec.js`; `desktop/test/run-harness.test.cjs`; `desktop/test/run-ledger.test.cjs`; `desktop/test/local-workspace.test.cjs` | Passed locally |
| Composer Skill routing | Loads Skills only for selected targets, supports `@` selection, and sends structured target-scoped coordinates | `frontend/src/__tests__/roundrelay/App.spec.js`; `desktop/test/local-skill-catalog.test.cjs`; `desktop/test/agent-installer.test.cjs`; `desktop/test/local-workspace.test.cjs` | Passed locally |
| Knowledge-source routing | Separates ready/planned sources, probes Feishu/DingTalk/Obsidian state, requires readable access, scopes selections to target Agents, persists only the selected Vault path, and rejects stale or unauthorized hints | `frontend/src/__tests__/roundrelay/App.spec.js`; `desktop/test/local-knowledge-base.test.cjs`; `desktop/test/knowledge-base-store.test.cjs`; `desktop/test/local-workspace.test.cjs`; `desktop/test/main-security.test.cjs` | Passed locally |
| Image attachment UI | Imports picker/paste images, permits image-only messages, blocks send and concurrent paste batches during import, keeps accepted all-failed messages out of the composer, discards unsent/overflow/stale imports, and sends metadata without paths or preview data | `frontend/src/__tests__/roundrelay/App.spec.js` | Passed locally |
| Attachment preview cache | Loads visible previews only, limits concurrent main-process requests to two, and evicts non-visible least-recent entries from the bounded cache | `frontend/src/__tests__/roundrelay/attachmentPreviews.spec.js` | Passed locally |
| Renderer bridge normalization | Uses only `window.roundrelayDesktop` services and normalizes missing data | `frontend/src/__tests__/roundrelay/desktop.spec.js` | Passed locally |
| Renderer i18n | Chinese/English keys and interpolation remain consistent | `frontend/src/__tests__/roundrelay/i18n.spec.js` | Passed locally |
| Renderer CSP and assets | Entry point keeps self-only/default restrictions, denies unsafe surfaces, and uses relative packaged assets | `frontend/src/__tests__/roundrelay/security.spec.js` | Passed locally |
| Main-frame IPC authorization | All registered local channels accept only the exact frontend main frame; other frames/paths are denied before dispatch | `desktop/test/main-security.test.cjs` | Passed locally |
| Electron navigation, lifecycle, and shutdown gate | Loads bundled frontend, denies in-window remote navigation, serializes refresh, rejects every trusted IPC call after shutdown starts, then waits for workspace/installer cleanup before quitting | `desktop/test/main-security.test.cjs` | Passed locally |
| Narrow preload API | Local document gets only named workspace/installer/Skill/attachment/Provider/knowledge-source methods; attachment APIs expose no file read or path resolution; non-local documents get no privileged API | `desktop/test/preload-security.test.cjs` | Passed locally |
| Packaged Electron hardening | Fuses disable Node/runtime injection and require ASAR integrity | `desktop/test/package-security.test.cjs` | Passed locally |
| Provider secret storage | Complete payload required; URL constrained; key encrypted; failures/corruption fail closed; delete works | `desktop/test/provider-store.test.cjs` | Passed locally |
| Agent readiness | Detects native credentials without returning values and scopes forwarded credential variables by Agent | `desktop/test/local-agent-readiness.test.cjs` | Passed locally |
| Installer allowlist and lifecycle | Fixed recipes, URL/command rejection, environment filtering, verification, cancellation, and single-task behavior | `desktop/test/agent-installer.test.cjs` | Passed locally |
| Image storage and validation | Validates PNG/JPEG signatures, MIME/name agreement, 8 MiB/four-image limits, image dimensions, private storage, checksums, tamper resistance, cleanup, bounded previews, and referenced-attachment deletion guards | `desktop/test/attachment-store.test.cjs`; `desktop/test/image-dimensions.test.cjs`; `desktop/test/main-security.test.cjs` | Passed locally |
| CLI invocation and Hermes final-result safety | Per-Agent read-only/write arguments, Kimi ACP lifecycle, image limits, Hermes native Skill preload, best-effort pre-run message watermark, post-watermark `assistant` `stop`/`length` selection, ANSI-stripped official stdout fallback, early session persistence, environment scoping, secret redaction, and process-tree cancellation | `desktop/test/cli-adapters.test.cjs` | Passed locally |
| Workspace state and automation | Explicit persisted-field allowlists, path stripping, visual topic roots, conversation-and-Agent session reuse, legacy topic-session migration, workdir session invalidation, Agent-specific transcript deltas, target-scoped Skills, image-only messages, equal-image-context preflight, attachment retry delivery, final-only downstream relay, early session persistence, failure isolation, complete rounds, strict consensus, and runtime bounds | `desktop/test/local-workspace.test.cjs` | Passed locally |
| Terminal run lifecycle | Completion events are transient and best-effort, listener failures do not change results, all-failed automatic runs keep the round-limit diagnostic, notification payloads are content-free, notification clicks open the target conversation, background successful direct runs receive completion markers, and shutdown suppresses new notifications | `desktop/test/local-workspace.test.cjs`; `desktop/test/main-security.test.cjs` | Passed locally |
| Managed OpenClaw | Isolated paths, key absent from config, immutable permission config, invalid scopes fail closed | `desktop/test/openclaw-runtime.test.cjs` | Passed locally |
| macOS packaging transform | Removes unused permission declarations, sets Electron fuses, and applies ad-hoc signing | `desktop/test/after-pack.test.cjs` | Passed locally |

## CI-Declared Checks

`.github/workflows/ci.yml` declares these push and pull-request checks:

- Frontend: `npm ci`, `npm test`, `npm run build`, `npm run build:desktop` on Ubuntu.
- Desktop: frontend/desktop `npm ci`, `npm test`, and `npm run pack` on macOS.

The workflow file exists, but branch protection and successful required checks are external GitHub state and are not verified by this repository documentation.

## Proposed Tests

| Type | Use case / rule | Expected behavior | Status |
| --- | --- | --- | --- |
| Automated packaged-app IPC integration | Extend the focused packaged smoke to exercise real preload IPC and attachment/Skill flows | Privileged calls work only in the main frame; imported images and selected Skills reach the expected Agent without exposing paths | Proposed |
| Guarded live | Real Agent CLI matrix on supported macOS/Windows versions | Detection, readiness, prompt execution, cancellation, session resume, Hermes final-row timing, and permission behavior match unit contracts | Proposed |
| Guarded live | Installer recipes on clean disposable OS users/VMs | Only the selected Agent is installed, cancellation cleans up, secrets are absent from child environment | Proposed |
| Automated integration | Installer artifact integrity after pinning is implemented | Modified script/package metadata is rejected before execution | Proposed |
| Automated visual regression | Light/dark theme and logo contrast | Detect theme, layout, or asset regressions without relying on manual screenshot inspection | Proposed |
| Guarded live | macOS Developer ID signing and notarization | Gatekeeper accepts the app and DMG on a clean machine | Proposed |
| Guarded live | Windows packaged build | Installation, app launch, CLI discovery, npm shim handling, and cancellation work on a real Windows device | Proposed |
| Automated resilience | Abrupt termination during workspace/provider writes | Previous valid state remains readable and no secret is left in a temporary file | Proposed |

## Gaps

| Priority | Rule with no current verification | Exposure | Status |
| --- | --- | --- | --- |
| High | Mutable installer packages/scripts are not digest- or signature-pinned | Upstream compromise can execute code as the local user | None until integrity pinning exists |
| High | Public release signing/notarization is not exercised | Distributed macOS artifacts can be rejected by Gatekeeper | None |
| Medium | No automated packaged preload/Agent end-to-end suite | Unit mocks may miss real IPC, attachment/Skill routing, or Agent process integration faults | One guarded live Harness acceptance plus the focused packaged UI smoke; no automated suite |
| Medium | No clean-machine live Agent/installer matrix | Upstream CLI changes can invalidate flags, output parsing, paths, or installer behavior | None |
| Medium | No repeatable live Hermes CLI matrix or real macOS notification-click exercise | Upstream Hermes authentication/persistence timing and operating-system notification behavior can diverge from the isolated acceptance run | One isolated packaged Hermes-to-Codex run plus Electron SQLite smoke; no matrix or notification-click exercise |
| Medium | Windows release is not built or tested in CI | Windows support remains implementation-level rather than release-verified | None |
| Low | No automated visual regression or accessibility audit | Theme, contrast, focus, and responsive regressions require manual discovery | None |
| Low | No long-history/performance test | Large local message histories may expose latency or file-size limits late | None |
