# Variables And Secrets

RoundRelay requires no `.env` file, server URL, account token, JWT, database credential, email credential, or cron secret.

## User And Runtime Configuration

| Name | Used by | Source and scope | Persistence / rotation | Risk and handling |
| --- | --- | --- | --- | --- |
| `ROUNDRELAY_CODEX_SANDBOX` | Codex adapter | Optional Electron process environment | Read at invocation; restart to change | Accepts only `read-only` or `workspace-write`; invalid values fall back to `read-only` |
| Provider `provider` | Compatible local Agents | User input in renderer, validated by main | Stored locally in `roundrelay-provider.json`; replace through UI | Non-secret display metadata |
| Provider `baseUrl` | Compatible local Agents | User input in renderer, validated by main | Stored locally; replace through UI | HTTPS required, except loopback HTTP; embedded credentials/query/fragment rejected |
| Provider `model` | Compatible local Agents | User input in renderer, validated by main | Stored locally; replace through UI | Non-secret model identifier |
| Provider `apiKey` | Compatible local Agents | User enters it in renderer; passed once over local IPC | Encrypted with `safeStorage`; rotate by saving a replacement or delete through UI | Secret; status and snapshots never return it |
| Theme / locale | Renderer | User preference | Browser `localStorage` | Non-secret |

## Native Agent Credential Inputs

RoundRelay detects and forwards only credential variables associated with the selected Agent:

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

These credentials are owned and rotated through the upstream CLI/provider, not RoundRelay. Readiness checks report only `ready`, `missing`, or `unknown`; they do not return credential values.

## Internal Child-Process Variables

Main derives these at invocation time; users should not set them as RoundRelay configuration:

| Variables | Purpose |
| --- | --- |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | Normalized configured Provider values for compatible Agents |
| `HERMES_INFERENCE_MODEL` | Mirrors the configured model for Hermes |
| `CODEBUDDY_MODEL`, `CODEBUDDY_API_KEY`, `CODEBUDDY_BASE_URL` | WorkBuddy Provider mapping |
| `ROUNDRELAY_OPENCLAW_API_KEY` | Secret environment reference used by generated OpenClaw config |
| `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_WORKSPACE_DIR` | Isolated managed OpenClaw runtime paths |
| `HERMES_EXEC_ASK`, `HERMES_YOLO_MODE`, `OPENCODE_PERMISSION` | Runtime safety overrides |

The API key is intentionally absent from generated OpenClaw JSON and supplied only through the child environment.

## Non-Secret System Environment

Agent children receive an allowlist of operating-system identity/path/locale/temp/certificate variables plus a constructed `PATH`. RoundRelay does not forward the entire Electron environment.

## Pre-Release Checklist

- Confirm no real keys or tokens are present in source, tests, logs, or packaged assets.
- Confirm `safeStorage.isEncryptionAvailable()` succeeds on each supported release OS.
- Confirm Provider status never returns the API key and credential files remain mode `0600`.
- Confirm child-process environment tests cover newly supported Agents or variables.
- Confirm installer logs/state never expose command output or ambient secrets.
- Rotate any credential used during guarded live testing before distributing artifacts.
