# Changelog

## 0.1.2 - 2026-08-17 (Meldwork-V1.0.2 prerelease candidate)

### Collaboration Harness V4

- Replaced the legacy group reply label with Concurrent Responses while preserving the existing `manual` persistence and IPC value.
- Freezes one shared task snapshot before Scheduler leases, keeps every selected Agent in the batch, isolates same-batch replies, and commits completed replies in stable member order.
- Starts Auto Discussion with independent parallel proposals instead of assigning the first Agent as the primary author and every later Agent as a review-only participant.
- Lets the selected Agents challenge proposals and negotiate one responsibility graph. Harness validates unanimous agreement on the normalized plan, dependencies, permissions, and participant coverage instead of privately assigning the work.
- Runs distinct agreed work packages, selects one synthesis writer, and binds independent verification to the current candidate Artifact. Contradictions remain tracked issues until resolved.
- Adds strict structured collaboration receipts, bounded Artifact/Evidence references, compact delivery watermarks, phase-and-slot operation IDs, serialized Human Gates, and idempotent crash recovery.
- Preserves V1 manual, V2 Auto Discussion, and V3 Task Graph records on their legacy parsers and executors.

### Agent Runtime

- Normalizes supported CLI output into streaming answer deltas, plans, status, tool lifecycle events, warnings, and terminal results without exposing raw commands, local paths, secrets, or chain-of-thought.
- Improves Hermes streaming and tool-event capture while preserving its read-only SQLite final-result watermark and sanitized stdout fallback.
- Improves OpenClaw stream and tool-event normalization in the Connector protocol and keeps its managed runtime state, Provider secret handling, and permission policy isolated.
- Strips collaboration control blocks from user-visible messages, live deltas, durable traces, and later Agent context; invalid or missing required receipts fail the current phase.

### Interface

- Shows real collaboration phases for parallel divergence, cross-Agent challenge and negotiation, responsibility-based work, convergence, and independent verification.
- Adds group-scoped unlimited-mode confirmation and state-driven motion with keyboard, Escape, `aria-live`, narrow-layout, and reduced-motion support.
- Adds an animated return-to-bottom control to group and direct conversation timelines.
- Keeps Agent message copy actions in the metadata row, aligns version switching, regenerate, and delete controls in the compact footer row, and hardens long-name, timestamp, and narrow-screen layout behavior.
- Keeps legacy round-zero trace labels neutral instead of relabeling historical responses as concurrent work.

### Durability And Safety

- Records V4 phases, batches, slots, attempts, frozen snapshots, dynamic roles, result references, delivery watermarks, commit state, and typed Gate state in the Run Ledger.
- Allows safe read-only recovery, requires a Human Gate before retrying an ambiguous writable slot, rejects late results after stop, and resumes batch commits idempotently.
- Keeps workspace writes opt-in. Concurrent replies, proposals, challenges, negotiated work, and verification remain read-only; only the synthesis writer receives write authority when enabled.
- Restricts renderer snapshots to validated phase, participant, role, progress, and Gate fields. Prompts, executable paths, native Session references, internal snapshot IDs, and unrestricted tool payloads remain main-process only.

### Packaging And Distribution

- Sets the desktop package version to `0.1.2` with permanent Bundle ID `com.rydersun.meldwork`.
- Produces Apple silicon DMG and ZIP prerelease candidates using ad-hoc signing. This is not Apple Developer ID signing or notarization and may require Open Anyway on first launch.
- Keeps `dist:public` as the fail-closed future formal-distribution path requiring a Developer ID identity, Hardened Runtime, complete Apple notarization credentials, and post-sign validation.
- Uses the Meldwork Non-Commercial Source License; commercial use requires prior written permission.

### Verification

- Release-candidate frontend tests: 299/299 passed; the exact final commit will be rerun before publication.
- Release-candidate desktop tests: 1270/1270 passed with zero failures or cancellations; the exact final commit will be rerun before publication.
- Release-candidate deterministic Eval Harness: 6 cases and 18 results passed; the exact final commit will be rerun before publication.
- Web and Electron renderer builds and `pack` passed on the release-candidate tree; they will be rerun from the exact final commit before publication. `dist` remains pending for that commit.
- Fresh DMG and ZIP SHA-256 values are intentionally not recorded until the exact final `dist` build completes.
- `codesign --verify --deep --strict` passed for a pre-final ad-hoc signed app; the exact final app must be verified again, and `spctl` rejection remains expected without Developer ID signing and notarization.
- A pre-final packaged candidate passed Codex, Claude Code, and Hermes streaming/tool lifecycle acceptance; final-source artifacts still require release verification.
- Exact packaged OpenClaw streaming/tool lifecycle acceptance and packaged Auto Discussion end-to-end acceptance remain unverified and are not release claims.

## 0.1.0 Private Preview 1 - 2026-08-03

This private preview packages the initial Meldwork MVP for internal evaluation on Apple silicon Macs.

### Highlights

- Local-first direct conversations and persistent multi-Agent working groups.
- Automatic multi-round discussions with explicit Agent targeting and bounded execution.
- Durable, sanitized run traces for reviewing Agent activity without exposing credentials, executable paths, or private reasoning.
- Independent Provider profiles, native Agent session continuity, Skills, knowledge-source references, images, and controlled workspace access.
- Support for Codex, Hermes, OpenClaw, WorkBuddy, Kimi Code, MiMo Code, Claude Code, Gemini CLI, OpenCode, Qwen Code, OpenCodeReview, and Custom Agents.
- Major frontend and Electron modularization while preserving the existing UI and public desktop bridge contracts.

### Distribution

- macOS Apple silicon: DMG and ZIP artifacts.
- Private preview only. The application was ad-hoc signed and not notarized with an Apple Developer ID.
- Windows and Intel Mac release artifacts were not included.

### License

Meldwork was source-available under PolyForm Noncommercial 1.0.0 for this historical preview. Commercial use required a separate written agreement.

### Verification

- Frontend tests: 217 passed.
- Desktop tests: 470 passed.
- Web and Electron frontend builds passed.
- Electron packaging, ASAR inspection, and deep signature verification passed.
