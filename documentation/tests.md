# Verification And Test Coverage

Last verified on 2026-07-29 using macOS arm64 and Node.js 20.19 or newer.

## Executed Verification

| Check | Evidence | Result |
| --- | --- | --- |
| Frontend unit suite | `npm --prefix frontend test` | 4 files, 13/13 tests passed |
| Desktop unit suite | `npm --prefix desktop test` | 133/133 tests passed |
| Renderer builds | `npm --prefix frontend run build` and `npm --prefix frontend run build:desktop` | Both Vite builds passed |
| macOS distribution | `npm --prefix desktop run dist` | arm64 `.app`, DMG, and ZIP produced |
| Packaged renderer smoke | Launch packaged `.app`, attach through local CDP, inspect DOM and screenshots | 9 Agent cards and all 10 visible images loaded; light/dark themes and 980x680 Chinese view had zero horizontal overflow |
| Logo packaging | Inspect source PNGs, generated `icon.icns`, and packaged asar | 1024px RGBA app/product icon plus 64px RGBA favicon present; removed Skill module absent |
| Idle startup network | Inspect the RoundRelay process tree with `lsof` after disconnecting CDP | No established TCP or UDP connection; only the explicitly enabled loopback CDP listener remained |
| Empty-store secure-storage behavior | Unit tests plus a one-second process sample | No `SecItemCopyMatching`, `SecKeychain`, `CSSM_Decrypt`, or decrypt call observed without a stored Provider |
| macOS signature | `codesign --verify --deep --strict` | Passed with ad-hoc signature; `spctl` rejection is expected until Developer ID signing/notarization exists |
| Distribution hashes | SHA-256 | DMG `dcfe2bde89508580da15f17bc45e16780b1bfedca61c472947e10d7fb2f3d8df`; ZIP `89f0ff8a241eb1d88e417925d95418bfdf23f5a1b615d06bbfb79b0de08b4ab6` |

## Automated Coverage

| Use case / rule | Expected behavior, including deny case | Evidence | Status |
| --- | --- | --- | --- |
| Renderer workbench | Shows nine Agents, supports local groups/direct chats, persists theme and switches locale | `frontend/src/__tests__/roundrelay/App.spec.js` | Passed locally |
| Renderer bridge normalization | Uses only `window.roundrelayDesktop` services and normalizes missing data | `frontend/src/__tests__/roundrelay/desktop.spec.js` | Passed locally |
| Renderer i18n | Chinese/English keys and interpolation remain consistent | `frontend/src/__tests__/roundrelay/i18n.spec.js` | Passed locally |
| Renderer CSP and assets | Entry point keeps self-only/default restrictions, denies unsafe surfaces, and uses relative packaged assets | `frontend/src/__tests__/roundrelay/security.spec.js` | Passed locally |
| Main-frame IPC authorization | Exact local frontend main frame is accepted; other frames/paths are denied | `desktop/test/main-security.test.cjs` | Passed locally |
| Electron navigation and lifecycle | Loads bundled frontend, denies in-window remote navigation, serializes refresh, and waits on quit cleanup | `desktop/test/main-security.test.cjs` | Passed locally |
| Narrow preload API | Local document gets only named workspace/installer/Provider methods; non-local document gets no privileged API | `desktop/test/preload-security.test.cjs` | Passed locally |
| Packaged Electron hardening | Fuses disable Node/runtime injection and require ASAR integrity | `desktop/test/package-security.test.cjs` | Passed locally |
| Provider secret storage | Complete payload required; URL constrained; key encrypted; failures/corruption fail closed; delete works | `desktop/test/provider-store.test.cjs` | Passed locally |
| Agent readiness | Detects native credentials without returning values and scopes forwarded credential variables by Agent | `desktop/test/local-agent-readiness.test.cjs` | Passed locally |
| Installer allowlist and lifecycle | Fixed recipes, URL/command rejection, environment filtering, verification, cancellation, and single-task behavior | `desktop/test/agent-installer.test.cjs` | Passed locally |
| CLI invocation safety | Per-Agent read-only/write arguments, session parsing, environment scoping, secret redaction, and process-tree cancellation | `desktop/test/cli-adapters.test.cjs` | Passed locally |
| Workspace state and automation | Explicit persisted-field allowlists, path stripping, topic/session isolation, write authorization, partial failures, and bounded auto turns | `desktop/test/local-workspace.test.cjs` | Passed locally |
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
| Automated packaged-app integration | Launch the unpacked Electron app and exercise preload IPC through a real renderer | UI loads from `file:`, privileged calls work only in the main frame, no remote navigation succeeds | Proposed |
| Guarded live | Real Agent CLI matrix on supported macOS/Windows versions | Detection, readiness, prompt execution, cancellation, session resume, and read-only behavior match unit contracts | Proposed |
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
| Medium | No real packaged Electron end-to-end suite | Unit mocks may miss preload, file URL, ASAR, or lifecycle integration faults | None |
| Medium | No clean-machine live Agent/installer matrix | Upstream CLI changes can invalidate flags, output parsing, paths, or installer behavior | None |
| Medium | Windows release is not built or tested in CI | Windows support remains implementation-level rather than release-verified | None |
| Low | No automated visual regression or accessibility audit | Theme, contrast, focus, and responsive regressions require manual discovery | None |
| Low | No long-history/performance test | Large local message histories may expose latency or file-size limits late | None |
