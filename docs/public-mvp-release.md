# Public MVP Release Checklist

Meldwork's public MVP is one Apple silicon macOS workflow: two locally ready Agents produce and review one deliverable in a bounded group, while the human controls context, workspace access, and adoption.

## Public MVP Contract

- Supported release target: Apple silicon macOS only.
- Required workflow: create a two-Agent group, attach task files, complete a bounded discussion, inspect final replies and run state, then make a human adoption decision.
- Required local capability: at least two release-certified Agent CLIs can be detected, authenticated, invoked, cancelled, and resumed where their native protocol supports it.
- Data boundary: conversations, attachments, run state, Provider profiles, and selections remain in Electron-owned local storage; third-party Agent and Provider traffic follows the user's selected tools.
- Explicit absences: no Windows or Intel Mac release claim, no production Cloud Agent, no production Channel ingress, no automatic merge of separate conversation histories, and no claim that every listed Agent is release-certified.

## Blocking Decisions

- [x] Use AGPL-3.0-only for the Community Edition and preserve a separate commercial-license path for proprietary redistribution, embedding, and future commercial editions.
- [x] Use the stable macOS Bundle ID `com.rydersun.meldwork` before registering the first public binary.
- [ ] Confirm the public project name after trademark, domain, and account checks documented in `brand-strategy.md`.

## Distribution Gates

- [ ] Enroll the release owner or organization in the Apple Developer Program.
- [ ] Create and install a Developer ID Application certificate.
- [ ] Configure notarization credentials without committing them to the repository.
- [ ] Produce DMG and ZIP artifacts from a clean tagged commit with `npm --prefix desktop run dist:public`.
- [ ] Verify Developer ID signatures, Gatekeeper acceptance, notarization, stapling, archive contents, and SHA-256 checksums.
- [ ] Install the DMG on a clean Apple silicon Mac user account with no prior Meldwork data.

## Product Acceptance

- [ ] Complete the two-Agent produce-and-review workflow on the exact release package with two certified Agent/version combinations.
- [ ] Verify first-run detection, missing-auth guidance, Provider configuration, cancellation, restart recovery, file drag-and-drop, attachment opening, and deletion cleanup.
- [ ] Confirm that a failed or unavailable Agent does not erase history or make the remaining result look fully verified.
- [ ] Capture English and Chinese screenshots from the exact release package.
- [ ] Record every known limitation in the Release notes.

## Repository Gates

- [ ] Update README download links and remove private-preview wording only after the public Release exists.
- [ ] Make CI checks required for `main` after the repository is public; the current private repository plan returns HTTP 403 for branch protection.
- [x] Enable GitHub dependency vulnerability alerts.
- [ ] Enable GitHub private vulnerability reporting and confirm the reporting path after the repository is public; the endpoint is unavailable while this repository remains private.
- [x] Verify README, contribution, security, notice, commercial-use, and license links.
- [ ] Put a reviewed contributor-license agreement process in place before merging external code intended for separately licensed commercial builds.
- [ ] Publish `v0.1.0` release notes, DMG, ZIP, and `SHA256SUMS.txt` from the same commit.
- [ ] Change repository visibility only after the tagged Release and public documentation agree.

## Not Required For The First Public MVP

- Windows or Intel Mac packages.
- A production Cloud or Channel Connector.
- Certification of every Agent shown in the catalog.
- A server, account system, telemetry, automatic updater, or hosted conversation storage.
- A separate workflow for every business domain.
