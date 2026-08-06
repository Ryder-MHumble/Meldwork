# Changelog

## Unreleased public MVP release candidate

### Highlights

- Hardened durable group orchestration, crash recovery, Human Gates, Agent controls, and bounded run traces.
- Added validated image, media, document, code, Office, and archive attachments through picker, paste, and drag-and-drop flows.
- Added read-only staging when an Agent lacks native support for a selected attachment type.
- Removed the superseded Role Review module and kept review as a bounded two-Agent group workflow.
- Completed Agent, Knowledge, mock Cloud, and Channel framework contracts while keeping production Cloud and Channel connectors disabled by default.
- Changed the Community Edition license from PolyForm Noncommercial 1.0.0 to AGPL-3.0-only, with separate commercial licensing available for proprietary use cases.
- Set the permanent macOS Bundle ID to `com.rydersun.meldwork` before the first public release.

### Verification

- Frontend tests: 237 passed.
- Desktop tests: 842 passed.
- Web and Electron renderer builds passed without the previous 500 kB chunk warning.
- Apple silicon package validation and exact packaged direct/group attachment acceptance passed.
- Public distribution still requires Developer ID signing and Apple notarization.

## 0.1.0 Private Preview 1 - 2026-08-03

This private preview packages the current Meldwork MVP for internal evaluation on Apple silicon Macs.

### Highlights

- Local-first direct conversations and persistent multi-Agent working groups.
- Automatic multi-round discussions with explicit Agent targeting and bounded execution.
- Durable, sanitized run traces for reviewing Agent activity without exposing credentials, executable paths, or private reasoning.
- Independent Provider profiles, native Agent session continuity, Skills, knowledge-source references, images, and controlled workspace access.
- Support for Codex, Hermes, OpenClaw, WorkBuddy, Kimi Code, MiMo Code, Claude Code, Gemini CLI, OpenCode, Qwen Code, OpenCodeReview, and Custom Agents.
- Major frontend and Electron modularization while preserving the existing UI and public desktop bridge contracts.

### Distribution

- macOS Apple silicon: DMG and ZIP artifacts.
- Private preview only. The application is ad-hoc signed and not notarized with an Apple Developer ID.
- Windows and Intel Mac release artifacts are not included in this preview.

### License

Meldwork is source-available under PolyForm Noncommercial 1.0.0. Commercial use requires a separate written agreement.

### Verification

- Frontend tests: 217 passed.
- Desktop tests: 470 passed.
- Web and Electron frontend builds passed.
- Electron packaging, ASAR inspection, and deep signature verification passed.
