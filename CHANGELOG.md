# Changelog

## 0.1.4 - 2026-09-01 (Meldwork-V1.0.4 prerelease)

### Natural Group Discussions

- Sequential discussion mode now runs one Agent at a time in the configured CLI order and records every round visibly.
- Auto Discussion starts with concurrent proposals, then lets Agent responses route the next turn through exact final-line `@Agent` mentions. One mention runs one Agent; multiple mentions run concurrently.
- Natural discussion prompts allow Agents to exchange views before work and review instead of forcing every turn into a review-only role.

### Session And Recovery

- Reuses one native Agent session per Agent task across discussion rounds and restarts.
- Persists round messages and checkpoints before and after Agent execution so completed turns are recovered without duplicate reruns.
- Rejects stale operation and snapshot bindings before late results can be committed.

### Verification And Distribution

- Focused natural discussion coverage: 17/17 tests passed.
- Desktop syntax checks and `git diff --check` passed.
- The Apple silicon DMG and ZIP are ad-hoc signed and not notarized. Live CLI behavior still depends on each installed Agent's version, authentication, Provider, and capabilities.

## 0.1.3 - 2026-08-18 (Meldwork-V1.0.3 prerelease)

### Concurrent Conversations

- Concurrent Responses now treats an empty explicit selection as the whole group, so users can send one message to every group Agent without adding `@` mentions first.
- Keeps every group member in the frozen batch. Agents beyond the available Scheduler capacity remain visibly queued instead of being removed from the request.
- Preserves valid visible proposals when a CLI omits or malforms its proposal receipt, while later Auto Discussion phases retain their strict structured-receipt boundary.

### Conversation Experience

- Refines user-message metadata, Agent logos, inline Agent/Skill/knowledge mentions, Markdown rendering, mention-menu tracking, and narrow-layout wrapping.
- Returns newly sent conversations to the active Agent loading state and keeps the animated return-to-bottom control for readers who have scrolled up.
- Removes the special No round limit composer background, border, shadow, and container breathing effect. The infinity status cue and real collaboration phase feedback remain available.

### Stop Durability

- Persists completed and streamed concurrent Agent replies when the user stops a batch instead of removing already visible work.
- Records stopped Agent attempts as interrupted, rejects late post-stop results, and resumes the stable batch commit idempotently after restart.

### Packaging And Verification

- Sets the frontend and desktop package version to `0.1.3` and publishes Apple silicon DMG and ZIP prerelease artifacts with a matching SHA-256 manifest.
- Frontend tests: 306/306 passed. Desktop tests: 1338/1338 passed.
- Web and Electron renderer builds, Electron `pack`, packaged acceptance, and `git diff --check` passed before release packaging.
- The prerelease remains ad-hoc signed, without Apple Developer ID signing or notarization, and may require Open Anyway on first launch.

## 0.1.2 - 2026-08-18 (Meldwork-V1.0.2 prerelease)

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
- Improves OpenClaw stream and tool-event normalization in the Connector protocol, keeps its managed runtime state, Provider secret handling, and permission policy isolated, and closes disposable ACP sessions plus the authenticated loopback Gateway and in-flight health probes during shutdown.
- Strips collaboration control blocks from user-visible messages, live deltas, durable traces, and later Agent context; invalid or missing required receipts fail the current phase.

### Interface

- Shows real collaboration phases for parallel divergence, cross-Agent challenge and negotiation, responsibility-based work, convergence, and independent verification.
- Adds group-scoped unlimited-mode confirmation and state-driven motion with keyboard, Escape, `aria-live`, narrow-layout, and reduced-motion support.
- Adds an animated return-to-bottom control to group and direct conversation timelines.
- Keeps Agent message copy actions in the metadata row, aligns version switching, regenerate, and delete controls in the compact footer row, and hardens long-name, timestamp, and narrow-screen layout behavior.
- Keeps legacy round-zero trace labels neutral instead of relabeling historical responses as concurrent work.

### Durability And Safety

- Records V4 phases, batches, slots, attempts, frozen snapshots, dynamic roles, result references, delivery watermarks, commit state, and typed Gate state in the Run Ledger.
- Binds pending V4 Human Gates and continuations to the exact leased Agent attempt, allows safe read-only recovery, requires a Human Gate before retrying an ambiguous writable slot, rejects late results after stop, and resumes batch commits idempotently.
- Rejects terminal Agent results and V4 phase advancement while an exact permission Gate is unresolved, rejects duplicate active ACP permission request IDs, and distinguishes known checkpoint failure from unknown post-write outcomes so live recovery state cannot regress behind the durable Ledger.
- Keeps workspace writes opt-in. Concurrent replies, proposals, challenges, negotiated work, and verification remain read-only; only the synthesis writer receives write authority when enabled.
- Restricts renderer snapshots to validated phase, participant, role, progress, and Gate fields. Prompts, executable paths, native Session references, internal snapshot IDs, and unrestricted tool payloads remain main-process only.

### Packaging And Distribution

- Sets the desktop package version to `0.1.2` with permanent Bundle ID `com.rydersun.meldwork`.
- Produces Apple silicon DMG and ZIP prerelease artifacts using ad-hoc signing. This is not Apple Developer ID signing or notarization and may require Open Anyway on first launch.
- Keeps `dist:public` as the fail-closed future formal-distribution path requiring a Developer ID identity, Hardened Runtime, complete Apple notarization credentials, and post-sign validation.
- Uses the Meldwork Non-Commercial Source License; commercial use requires prior written permission.

### Verification

- Frontend tests: 302/302 passed. Desktop tests: 1335/1335 passed.
- Deterministic Eval Harness: 6 cases and 18 results passed.
- Web and Electron renderer builds, Electron `pack`, and `git diff --check` passed on the final source tree.
- Packaged Manual V4 completed with Codex, Claude, and Hermes evidence; packaged Auto Discussion V4 completed with Codex and Claude evidence; stopped runs remained stopped.
- Hermes live streaming and tool lifecycle acceptance passed. The latest OpenClaw live run failed closed with `LOCAL_AGENT_PROCESS_FAILED`; protocol fixtures and managed-runtime tests pass, but OpenClaw live streaming/tool acceptance is not claimed.
- The final 360 x 800 packaged UI acceptance passed for group and direct return-to-latest behavior, Trace layout, message actions, and stop durability. A separate Codex direct run exceeded the 300-second observation window before completing late, so it is retained as a live timing limitation rather than counted as a UI failure.
- Release DMG and ZIP digests are published in `SHA256SUMS.txt` and verified against the uploaded assets.
- The prerelease remains ad-hoc signed, without Apple Developer ID signing or notarization; `spctl` rejection remains expected.

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
