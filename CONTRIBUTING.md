# Contributing

Meldwork is currently a source-available, non-commercial project. Contributions are welcome when they improve the local-first desktop product, documentation, tests, or security posture.

By submitting a contribution, you agree that your contribution is licensed under the same license as this repository unless a separate written agreement says otherwise.

## Ground Rules

- Keep changes small and tied to a clear product or engineering need.
- Do not submit secrets, tokens, private logs, private prompts, or user data.
- Do not add remote services, telemetry, credential collection, or server dependencies without explicit project approval.
- Preserve the local-first boundary: renderer code must not gain unrestricted filesystem, shell, Provider credential, or executable-path access.
- Include focused tests for behavior, security boundary, storage, or IPC changes.

## Commercial Rights

Submitting a contribution does not grant commercial-use rights to this repository. Commercial use requires a separate written agreement; see [COMMERCIAL_USE.md](COMMERCIAL_USE.md).
