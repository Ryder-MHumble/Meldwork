# Variables And Secrets

Meldwork requires no `.env` file, server URL, account token, JWT, database credential, email credential, or cron secret.

## User And Runtime Configuration

| Name | Used by | Source and scope | Persistence / rotation | Risk and handling |
| --- | --- | --- | --- | --- |
| `ROUNDRELAY_CODEX_SANDBOX` | Codex adapter | Optional Electron process environment | Read at invocation; restart to change | Accepts only `read-only` or `workspace-write`; invalid values fall back to `read-only` |
| Provider `provider` | Compatible local Agents | User input in renderer, validated by main | Stored locally in `roundrelay-provider.json`; replace through UI | Non-secret display metadata |
| Provider `baseUrl` | Compatible local Agents | User input in renderer, validated by main | Stored locally; replace through UI | HTTPS required, except loopback HTTP; embedded credentials/query/fragment rejected |
| Provider `model` | Compatible local Agents | User input in renderer, validated by main | Stored locally; replace through UI | Non-secret model identifier |
| Provider `apiKey` | Compatible local Agents | User enters it in renderer; passed once over local IPC | Encrypted with `safeStorage`; rotate by saving a replacement or delete through UI | Secret; status and snapshots never return it |
| Obsidian Vault path | Knowledge-source selection | User chooses a directory through the main-owned OS picker | Stored in `roundrelay-knowledge-base.json`; replace or clear through UI | Non-secret local path, but may reveal directory naming; only selected Agents receive it as task context |
| Feishu / DingTalk CLI auth | Knowledge-source selection | Owned by the installed `lark-cli`/`opdev` or `dws` CLI | Managed and rotated through the upstream CLI | Meldwork probes status and document access but does not receive or store the upstream token |
| Theme / locale | Renderer | User preference | Browser `localStorage` | Non-secret |

## Native Agent Credential Inputs

Meldwork detects and forwards only credential variables associated with the selected Agent:

| Agent | Recognized process variables |
| --- | --- |
| Codex | `OPENAI_API_KEY` |
| Hermes | `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` |
| OpenClaw | `OPENAI_API_KEY`, `OPENROUTER_API_KEY` |
| WorkBuddy | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` |
| Kimi Code | `MOONSHOT_API_KEY`, `KIMI_API_KEY` |
| Claude Code | `ANTHROPIC_API_KEY` |
| Qwen Code | `DASHSCOPE_API_KEY`, `OPENAI_API_KEY` |
| Gemini CLI | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| OpenCode | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` |
| OpenCodeReview | `OCR_LLM_TOKEN`, `OPENAI_API_KEY` |

These credentials are owned and rotated through the upstream CLI/provider, not Meldwork. Readiness checks report only `ready`, `missing`, or `unknown`; they do not return credential values.

## Internal Child-Process Variables

Main derives these at invocation time; users should not set them as Meldwork configuration:

| Variables | Purpose |
| --- | --- |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | Normalized configured Provider values for compatible Agents |
| `HERMES_INFERENCE_MODEL` | Mirrors the configured model for Hermes |
| `CODEBUDDY_MODEL`, `CODEBUDDY_API_KEY`, `CODEBUDDY_BASE_URL` | WorkBuddy Provider mapping |
| `OCR_LLM_URL`, `OCR_LLM_TOKEN`, `OCR_LLM_MODEL`, `OCR_USE_ANTHROPIC` | OpenCodeReview Provider mapping |
| `ROUNDRELAY_OPENCLAW_API_KEY` | Secret environment reference used by generated OpenClaw config |
| `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_WORKSPACE_DIR` | Isolated managed OpenClaw runtime paths |
| `HERMES_EXEC_ASK`, `HERMES_YOLO_MODE`, `OPENCODE_PERMISSION` | Runtime safety overrides |

The API key is intentionally absent from generated OpenClaw JSON and supplied only through the child environment.

## Release Signing And Notarization

These variables are used only by `npm --prefix desktop run dist:public`. They must come from the local Keychain or the release system's encrypted secret store and must never reach the renderer or packaged application.

| Name | Used by | Source and scope | Persistence / rotation | Risk and handling |
| --- | --- | --- | --- | --- |
| `CSC_LINK` | electron-builder signing | Encrypted CI secret containing or pointing to the Developer ID `.p12` | Replace when the certificate is renewed or revoked | Secret certificate material; must be paired with `CSC_KEY_PASSWORD` |
| `CSC_KEY_PASSWORD` | electron-builder signing | Encrypted CI secret | Rotate with the exported `.p12` | Secret; never print or store in repository files |
| `CSC_NAME` | Local Keychain signing | Optional local identity selector | Update when the certificate identity changes | Non-secret name, but `dist:public` accepts only a Developer ID Application identity |
| `APPLE_API_KEY` | Apple notarization | Path to the private App Store Connect `.p8` key | Revoke and replace in App Store Connect | Secret file; `*.p8` is ignored by Git |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Apple notarization | App Store Connect identifiers stored with release secrets | Replace when the API key changes | Treat as release metadata and keep out of renderer state |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Alternative Apple notarization | Encrypted release secrets | Rotate the app-specific password and update Team membership as needed | The app-specific password is secret; the normal Apple ID password must never be used |
| `APPLE_KEYCHAIN_PROFILE`, `APPLE_KEYCHAIN` | Local `notarytool` profile | Local Keychain profile name and optional Keychain path | Recreate when Apple credentials rotate | References only; underlying credentials remain in Keychain |

The public-release preflight requires one complete signing source and one complete notarization strategy. Partial credential groups fail before packaging, and the post-sign hook rejects ad-hoc or mismatched identities.

## Non-Secret System Environment

Agent children receive an allowlist of operating-system identity/path/locale/temp/certificate variables plus a constructed `PATH`. Meldwork does not forward the entire Electron environment.

## Pre-Release Checklist

- Confirm no real keys or tokens are present in source, tests, logs, or packaged assets.
- Confirm `safeStorage.isEncryptionAvailable()` succeeds on each supported release OS.
- Confirm Provider status never returns the API key and credential files remain mode `0600`.
- Confirm child-process environment tests cover newly supported Agents or variables.
- Confirm installer logs/state never expose command output or ambient secrets.
- Confirm `dist:public` passes with the intended Developer ID and fails when signing or notarization credentials are removed.
- Confirm no `.p8`, `.p12`, certificate password, or notarization profile is present in Git history or release archives.
- Rotate any credential used during guarded live testing before distributing artifacts.
