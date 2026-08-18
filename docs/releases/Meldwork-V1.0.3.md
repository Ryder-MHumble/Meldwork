# Meldwork V1.0.3

This prerelease makes concurrent group conversations more predictable and keeps useful Agent work durable when a run is stopped.

## Improvements

- **Reply with the whole group by default**: In Concurrent Responses, sending without an explicit Agent selection now invokes every Agent in the group. Scheduler limits may queue members, but no selected group member is removed from the batch.
- **Cleaner conversation composition**: Agent, Skill, and knowledge mentions now flow inline with the message, user metadata and Agent logos are easier to scan, Markdown formatting is rendered consistently, and mention menus follow the active selection while scrolling.
- **Reliable conversation positioning**: New messages return to the active Agent loading state, while the animated return-to-bottom control remains available when reading older content.
- **Quieter unlimited mode**: No round limit now uses the normal composer surface instead of a special background, border, shadow, or container breathing animation. The infinity cue and real phase feedback remain visible.

## Reliability Fixes

- Completed and streamed concurrent replies remain visible and durable when the user stops a batch.
- Stopped attempts are recorded as interrupted, late results are rejected, and batch commits resume idempotently after restart.
- A valid visible proposal is preserved when a CLI omits or malforms its proposal receipt; strict structured receipts still protect later Auto Discussion phases.

## Verification

- Frontend: 306/306 tests passed.
- Desktop: 1338/1338 tests passed.
- Deterministic Eval Harness: 6 cases and 18 results passed.
- Web build, Electron renderer build, desktop pack, release archive generation, archive integrity, signature integrity, packaged application acceptance, and `git diff --check` passed.
- Packaged acceptance confirmed that an unaddressed Concurrent Responses message targets every group Agent and that finite and No round limit composers use the same surface styling.

## Distribution

- Apple silicon macOS only: DMG and ZIP are included with `SHA256SUMS.txt`.
- The app is ad-hoc signed, not Apple Developer ID signed or notarized. macOS may require **Open Anyway** on first launch.
- Live Agent behavior still depends on the installed CLI version, authentication, Provider, and declared capabilities. This release does not claim live certification for every supported Agent.
- Meldwork is distributed under the Meldwork Non-Commercial Source License. Commercial use requires prior written permission.
