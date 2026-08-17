# Verification And Test Coverage

This page records the V1.0.2 release-candidate evidence available on 2026-08-17 for Apple silicon macOS. Repository tooling and CI require Node.js 22.12 or newer; the packaged desktop uses Electron's bundled runtime.

The candidate is ad-hoc signed, not signed with an Apple Developer ID, and not notarized. Passing `codesign` proves bundle integrity only. Gatekeeper acceptance is not claimed, and `spctl` rejection is expected for this candidate.

## Executed Verification

| Check | Evidence | Result |
| --- | --- | --- |
| Frontend unit suite | `npm --prefix frontend test` | Current release-candidate tree: 35 files and 299/299 tests passed; rerun required from the exact final commit |
| Desktop unit suite | `npm --prefix desktop test` | Current release-candidate tree: 1270/1270 tests passed with zero failures or cancellations; rerun required from the exact final commit |
| Deterministic Eval Harness | `npm --prefix desktop run eval:deterministic` | Current release-candidate tree: 6 cases and 18 results passed; rerun required from the exact final commit |
| Renderer builds | `npm --prefix frontend run build` and `npm --prefix frontend run build:desktop` | Both builds passed |
| Packaged application directory | `npm --prefix desktop run pack` | Passed on the release-candidate tree; the exact final commit must be packaged again before live acceptance |
| Prerelease archives | `npm --prefix desktop run dist` | Passed on a pre-final source state; the final DMG and ZIP have not been generated |
| DMG digest | `shasum -a 256 desktop/dist/Meldwork-0.1.2-arm64.dmg` | Pending the exact `dist` build from the final committed source; no earlier value is valid for publication |
| ZIP digest | `shasum -a 256 desktop/dist/Meldwork-0.1.2-arm64.zip` | Pending the exact `dist` build from the final committed source; no earlier value is valid for publication |
| Ad-hoc signature integrity | `codesign --verify --deep --strict --verbose=2 desktop/dist/mac-arm64/Meldwork.app` | Passed on a pre-final candidate; the exact final app must be verified again |
| Gatekeeper assessment | `spctl --assess --type execute --verbose=4 desktop/dist/mac-arm64/Meldwork.app` | Pre-final candidate was rejected as expected; repeat against the exact final app |

## Pre-Final Packaged-App Acceptance

The following guarded live checks used a V1.0.2 packaged candidate and isolated local profiles before the final source was locked. They validate the listed runtime paths but do not certify the final release artifacts.

| Surface | Result | Boundary |
| --- | --- | --- |
| Codex direct execution | Streaming answer deltas and tool lifecycle events rendered through the normalized runtime-event contract | Passed |
| Claude Code direct execution | Streaming answer deltas and tool lifecycle events rendered through the normalized runtime-event contract | Passed |
| Hermes direct execution | Streaming answer deltas and available tool lifecycle events rendered through the normalized runtime-event contract | Passed |
| OpenClaw direct execution | Adapter fixtures and managed-runtime tests pass, but exact packaged live streaming/tool acceptance was not completed | Not release-verified |
| Auto Discussion V4 | Automated orchestration, negotiation, durability, convergence, and UI coverage pass, but exact packaged end-to-end acceptance was not completed | Not release-verified |

Do not generalize the three passing live checks to every supported Agent. Connector output formats, installed versions, authentication state, and native tool-event support can still differ.

## Concurrent Collaboration V4 Coverage

| Use case / rule | Expected behavior | Evidence |
| --- | --- | --- |
| Strict V4 records and legacy compatibility | Strictly validates V4 phases, slots, frozen snapshots, stable operation IDs, delivery watermarks, commit state, and Human Gates while preserving V1 manual, V2 Auto Discussion, and V3 Task Graph parsing | `desktop/test/collaboration/orchestration-v4-records.test.cjs`; `desktop/test/runs/run-ledger.test.cjs` |
| Concurrent response batch isolation | Freezes one shared snapshot before Scheduler leases, retains every selected Agent, prevents same-batch visibility, and commits out-of-order results in stable member order | `desktop/test/workspace/local-workspace-v4-manual-durability.test.cjs`; `desktop/test/workspace/local-workspace-harness.test.cjs`; `desktop/test/runs/run-scheduler.test.cjs` |
| Independent proposals and Agent negotiation | Starts all selected Agents from the same task snapshot, gathers independent proposals, requires cross-Agent discussion, and accepts work only after all participants agree to the same normalized responsibility plan | `desktop/test/workspace/local-workspace-v4-agent-negotiation.test.cjs`; `desktop/test/workspace/local-workspace-auto.test.cjs` |
| Responsibility-based work | Schedules the agreed work packages with dependency and permission boundaries instead of assigning every non-first Agent a permanent review-only role | `desktop/test/workspace/local-workspace-v4-agent-negotiation.test.cjs`; `desktop/test/workspace/local-workspace-v4-auto-durability.test.cjs` |
| Structured receipts and context budget | Validates proposal, challenge, work, synthesis, and verification receipts; strips control blocks from visible output; rejects malformed receipts; keeps bounded collaboration delivery and incremental watermarks | `desktop/test/workspace/local-workspace-v4-receipt.test.cjs`; `desktop/test/workspace/local-workspace-context-packs.test.cjs` |
| Synthesis, findings, and convergence | Gives workspace write authority to one synthesis Agent, binds verification to the current Artifact, tracks contradictory `ReviewerFinding` records as unresolved issues, and completes only after independent support | `desktop/test/workspace/local-workspace-v4-convergence.test.cjs`; `desktop/test/collaboration/collaboration-records.test.cjs` |
| Crash recovery and idempotent commit | Recovers safe read-only slots, prevents ambiguous writable retries without a Human Gate, rejects late results after stop, and resumes batch commit idempotently | `desktop/test/workspace/local-workspace-v4-auto-durability.test.cjs`; `desktop/test/workspace/local-workspace-v4-manual-durability.test.cjs`; `desktop/test/workspace/local-workspace-human-gate-recovery.test.cjs` |
| Gate serialization | Stops dispatching new slots after the first parallel Gate, lets already-running read-only work settle, and serializes continuation decisions | `desktop/test/workspace/local-workspace-v4-gate-pause.test.cjs`; `desktop/test/gates/human-gate-coordinator.test.cjs` |
| Unlimited-mode and trace UI | Shows validated phase, participant, role, slot, and Gate state; scopes unlimited confirmation to one group; supports reduced motion; preserves neutral labels for legacy round-zero traces | `frontend/src/__tests__/meldwork/App.unlimited-review.spec.js`; `frontend/src/__tests__/meldwork/App.run-trace.spec.js`; `frontend/src/__tests__/meldwork/App.conversation-trace.spec.js` |

## Runtime And Product Coverage

| Area | Covered behavior | Evidence |
| --- | --- | --- |
| Agent stream and tool-event normalization | Normalizes supported Agent outputs into answer deltas, plans, status, tool lifecycle, warnings, and terminal results without exposing commands, paths, secrets, or raw chain-of-thought | `desktop/test/agents/cli/cli-adapters-agent-protocols.test.cjs`; `desktop/test/agents/cli/cli-adapters.test.cjs`; `desktop/test/security/preload-security.test.cjs` |
| Hermes result recovery | Uses a read-only message watermark and a post-watermark final assistant row when available, with sanitized official stdout fallback | `desktop/test/agents/cli/cli-adapters-agent-protocols.test.cjs`; `desktop/test/agents/cli/cli-adapters.test.cjs` |
| Managed OpenClaw | Isolates runtime state, keeps Provider secrets out of generated config, validates permission scopes, and normalizes supported streaming/tool events in protocol fixtures | `desktop/test/agents/cli/openclaw-runtime.test.cjs`; `desktop/test/agents/cli/cli-adapters-agent-protocols.test.cjs` |
| Conversation controls | Covers group/direct timelines, per-Agent states, retry/stop/replace controls, message actions, and the animated return-to-bottom control including reduced-motion behavior | `frontend/src/__tests__/meldwork/conversationViewport.spec.js`; `frontend/src/__tests__/meldwork/conversationTimeline.spec.js`; `frontend/src/__tests__/meldwork/App.conversation-trace.spec.js` |
| Renderer privacy boundary | Uses the narrow preload bridge and exposes only allowlisted run fields; rejects non-main-frame IPC and unsafe navigation | `frontend/src/__tests__/meldwork/security.spec.js`; `desktop/test/security/main-security.test.cjs`; `desktop/test/security/preload-security.test.cjs` |
| Attachments and Skills | Validates bounded attachment import/storage/preview behavior and target-scoped Skill snapshots without exposing local paths to the renderer | `frontend/src/__tests__/meldwork/App.attachments.spec.js`; `desktop/test/attachments/attachment-store.test.cjs`; `desktop/test/skills/local-skill-catalog.test.cjs` |
| Agent and Knowledge connectors | Enforces approved Connector manifests, scoped instances, durable event reduction, read-only Knowledge lifecycles, and restart-safe references | `desktop/test/agents/connectors/agent-connector-runtime.test.cjs`; `desktop/test/knowledge/knowledge-connector-contract.test.cjs`; `desktop/test/runs/run-event-protocol.test.cjs` |
| Packaging hardening | Applies Electron fuses, removes unused permission declarations, preserves the Bundle ID, and ad-hoc signs local/prerelease packages | `desktop/test/packaging/package-security.test.cjs`; `desktop/test/packaging/after-pack.test.cjs` |
| Formal release fail-closed path | Requires a Developer ID source and complete notarization credentials; rejects ad-hoc identities, missing Team ID, missing Hardened Runtime, or the wrong Bundle ID | `desktop/test/packaging/public-release-preflight.test.cjs`; `desktop/test/packaging/after-sign.test.cjs` |

## CI-Declared Checks

`.github/workflows/ci.yml` declares these push and pull-request checks:

- Frontend: install, unit tests, web build, and desktop renderer build on Ubuntu.
- Desktop: install, unit tests, deterministic Eval Harness, and packaged application build on macOS.

The workflow file does not prove branch-protection configuration or the status of any specific GitHub run.

## Remaining Gaps

| Priority | Gap | Release boundary |
| --- | --- | --- |
| High | No Developer ID signing, Apple notarization, Stapling, or clean-machine Gatekeeper acceptance | V1.0.2 remains an ad-hoc signed prerelease candidate that may require Open Anyway |
| High | Exact packaged Auto Discussion V4 end-to-end acceptance was not completed | Automated V4 coverage does not establish a live multi-Agent release certification |
| Medium | Exact packaged OpenClaw streaming and tool-lifecycle acceptance was not completed | Protocol and managed-runtime tests pass, but live OpenClaw behavior is not claimed |
| Medium | No clean-machine live matrix for every listed Agent and installer recipe | Upstream CLI versions, authentication, and output formats can diverge from fixtures |
| Medium | No production Cloud Agent provider or task-oriented Channel Connector is configured | Mock/framework coverage does not establish a production remote integration |
| Medium | Windows and Intel Mac packages were not built or accepted | V1.0.2 distribution evidence applies only to Apple silicon macOS |
| Low | No comprehensive automated visual-regression, accessibility, or long-history performance suite | Responsive, assistive-technology, and large-history risks still require additional validation |

## Documentation Checks

Before publication, validate every backticked test path in this page, run `git diff --check`, and compare `desktop/dist/SHA256SUMS.txt` with fresh `shasum -a 256` output from the final candidate artifacts.
