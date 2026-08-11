# Contributing

Meldwork is source-available under the [Meldwork Non-Commercial Source License](LICENSE). Contributions are welcome when they improve the local-first desktop product, documentation, tests, or security posture.

Unless a separate written agreement applies, a contribution accepted into this repository is available under the repository license. The project may also offer separately licensed commercial editions. Before external code is incorporated into a separately licensed commercial build, the maintainer may require a reviewed contributor-license agreement that grants the necessary relicensing rights. Opening a pull request by itself does not transfer copyright or silently grant those additional rights.

## Ground Rules

- Keep changes small and tied to a clear product or engineering need.
- Do not submit secrets, tokens, private logs, private prompts, or user data.
- Do not add remote services, telemetry, credential collection, or server dependencies without explicit project approval.
- Preserve the local-first boundary: renderer code must not gain unrestricted filesystem, shell, Provider credential, or executable-path access.
- Include focused tests for behavior, security boundary, storage, or IPC changes.
- Confirm that all submitted code and assets are yours to license and do not introduce incompatible license obligations.

## Commercial Editions

Commercial use of Meldwork requires prior written permission. Commercial editions, proprietary integrations, support, and other paid offerings may use separate terms; see [COMMERCIAL_USE.md](COMMERCIAL_USE.md).
