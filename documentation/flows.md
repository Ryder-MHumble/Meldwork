# Security And Side-Effect Flows

RoundRelay has one human actor: the local desktop user. There are no accounts, roles, claims, tenants, or server-side authorization checks. Protected operations are authorized by the Electron main process accepting IPC only from the exact bundled renderer main frame.

## 1. Application Startup

**Precondition:** The local user launches RoundRelay.

1. Electron main creates `ProviderStore`, `AttachmentStore`, and `LocalWorkspace` under `app.getPath('userData')`, plus a `LocalSkillCatalog` rooted at `app.getPath('home')`.
2. Main registers IPC handlers, creates a sandboxed `BrowserWindow`, and loads the bundled frontend with `loadFile`.
3. Before accepting attachment work, main reconciles the private attachment directory against persisted message references. Malformed workspace state disables destructive cleanup.
4. Preload exposes workspace, installer, Skill, attachment, and Provider methods only when `location.protocol === 'file:'`.
5. The renderer requests a sanitized workspace snapshot and a non-probing Provider status.
6. The renderer performs the single startup Agent refresh, which detects installed CLIs and evaluates credential readiness. Main does not launch a duplicate eager scan.
7. On the first renderer launch, a three-slide onboarding carousel opens while that refresh runs. Its completion action remains disabled until detection actually settles; completion is stored only in renderer `localStorage`.

**Deny case:** IPC from a different frame, web contents instance, protocol, or file path fails `requireDesktopRenderer`.

**State/side effects:** Reads local Agent/Skill configuration and RoundRelay data, removes only confirmed orphan attachment entries, and writes a non-secret onboarding preference after dismissal; it does not contact an application server.

## 2. Save Or Remove A Provider

**Precondition:** The user opens Provider settings in the local renderer.

1. Renderer collects `provider`, `baseUrl`, `model`, and `apiKey` and calls the preload method.
2. Main validates the renderer origin and passes only the four expected fields to `ProviderStore`.
3. `ProviderStore` accepts HTTPS or loopback HTTP URLs without embedded credentials, query, or fragment.
4. `safeStorage` encrypts the API key. Main atomically writes metadata plus ciphertext to `roundrelay-provider.json`.
5. Status responses return metadata and configuration state, never the API key.
6. Removing the Provider deletes the local credential file and refreshes Agent availability.

**Deny cases:** Missing recognized fields, invalid URL, unavailable OS encryption, encryption failure, or corrupt ciphertext fail closed. Main ignores unrecognized renderer properties instead of forwarding them to storage.

**External side effect:** Later Agent invocations may send prompts to the configured Provider. Saving metadata alone does not test or call the Provider.

## 3. Detect Or Install A Local Agent

**Precondition:** The user opens the Agent manager. Installation requires a second confirmation click in the renderer.

1. Main searches allowlisted command names in known user installation paths and verifies a non-empty version.
2. The renderer displays installed, ready, and installable states without executable paths.
3. On confirmed installation, main selects a code-defined recipe for the Agent and current OS.
4. npm recipes invoke a fixed package name. Hermes/Kimi recipes download from allowlisted HTTPS hosts into a temporary directory.
5. The installer runs one task at a time, filters sensitive environment variables, supports cancellation, and verifies the CLI version afterward.
6. Temporary installer files are removed and Agent detection is refreshed.

**Deny cases:** Unknown Agent, unsupported OS, already installed Agent, missing npm, non-allowlisted command/URL, invalid Windows npm shim, failed download, or failed version verification.

**External side effects:** Network download and global CLI installation. Current recipes are allowlisted but not cryptographically pinned.

## 4. Manage RoundRelay Conversations

**Precondition:** At least one detected Agent is available. The user selects a working directory.

1. The sidebar groups direct conversations under each available Agent and may create more than one RoundRelay conversation for the same Agent.
2. Renderer sends the RoundRelay conversation name/topic, Agent kinds, user-selected directory, and `allowWrite`.
3. Main validates the renderer and delegates create, select, rename, update, or delete operations to `LocalWorkspace` using a RoundRelay-owned conversation ID.
4. `LocalWorkspace` keeps only available Agent kinds, resolves the directory, stores `allowWrite` as an explicit boolean, and isolates native session-reference mappings by conversation, Agent, and topic.
5. The workspace file is updated and a sanitized snapshot is emitted to the trusted renderer.

**Deny cases:** No available Agent, invalid group ID, or attempts to enable an unavailable Agent.

**State/side effects:** Writes local conversation configuration. Deleting a conversation removes its RoundRelay messages and native session-reference mapping and is denied while that conversation is running. It does not delete any CLI-native session or history from the CLI's own storage.

## 5. Select Skills And Import Images

**Precondition:** A conversation and at least one target Agent are selected.

1. Typing `@` or pressing the Skill button asks `agentInstaller.skills(kind)` for each current target. The installed-Agent gate and `LocalSkillCatalog` return only sanitized `{targetKind, namespace, slug, name}` records.
2. The renderer keeps at most four selections and sends structured Skill coordinates, not filesystem paths or Skill contents.
3. The image button opens a main-owned PNG/JPEG picker. Clipboard images cross the bridge only as an exact `{name, mimeType, bytes}` payload.
4. `AttachmentStore` validates source-file safety, magic bytes, declared MIME/name agreement, the 8 MiB limit, private modes, checksum, and image dimensions before returning safe metadata plus a bounded preview.
5. Before persisting a message, `LocalWorkspace` resolves attachment IDs to main-only absolute paths, revalidates every Skill against the current target's catalog, and checks every selected Agent's image count/capability.
6. Persisted messages and renderer snapshots contain attachment metadata and target-scoped Skill hints only. Historical previews are loaded separately by ID through a bounded, visibility-driven renderer cache.
7. Removing an unsent image calls the discard IPC. Deleting a conversation removes only attachments no longer referenced by another message; startup cleanup removes confirmed orphans and interrupted-import residue.

**Deny cases:** Unknown/stale/cross-Agent Skill, more than four Skills, malformed attachment input, unsupported type, MIME mismatch, more than 8 MiB per image, more than four images, unsafe/tampered storage, unsupported target Agent, or a target-specific image limit. Validation fails before a message or Agent run is recorded.

**State/side effects:** Imports private local image copies and reads local Skill manifests. No Skill path, attachment path, preview payload, or raw bytes are persisted in the workspace snapshot.

## 6. Send A Message To Agents

**Precondition:** The conversation is not already running and at least one selected target belongs to the group.

1. `LocalWorkspace` persists the user message and creates a cancellable run.
2. It builds a bounded prompt from the local topic transcript and includes only the selected Skill hints assigned to that Agent.
3. Main resolves the Agent executable and attachment paths internally, selects Provider/native credential environment, and invokes the CLI in the group working directory. Codex, Hermes, and OpenCode receive images through their validated native arguments; Hermes also receives selected Skill slugs through `--skills`.
4. CLI adapters apply per-Agent read-only or write-enabled arguments. Child processes receive an allowlisted system environment plus only current-Agent credentials.
5. Main emits sanitized active progress. Hermes process details are bounded and kept separate from the final answer; a pre-run message-ID watermark prevents an earlier turn from being selected as the current result.
6. Normalized final Agent text is stored as message content, while native session references remain main-only. For Hermes, a post-watermark non-empty `assistant` row with `finish_reason` `stop` or `length` overrides process output. When the watermark or final lookup is unavailable, locked, incompatible, or empty, the ANSI-stripped official `--quiet` stdout is used as the fallback; `tool_calls` rows are never selected. A newly reported Hermes session reference is persisted before this lookup, including when the database path cannot provide a result.
7. Failures are recorded as diagnostic system messages. One failed Agent does not cancel successful Agents; when every Agent fails after the user message has been persisted, the send resolves as an accepted failed run so the renderer does not restore and duplicate the committed draft or attachments.
8. On terminal state, main emits a best-effort sanitized run event. When the window is unfocused it also creates a content-free operating-system notification whose click action focuses the app and opens the RoundRelay conversation; shutdown suppresses these notifications.

**Deny cases:** Empty text and no image, target outside the group, unavailable Agent, concurrent run, invalid Skill/attachment context, invalid sandbox, or authentication failure.

**External side effects:** Agent/provider network calls and possible workspace reads. Workspace writes are intended only when `allowWrite` is true, subject to upstream CLI enforcement.

## 7. Equal-Context Automatic Discussion And Stop

**Precondition:** A group has at least two Agents and a persisted user topic root.

1. Before creating a run, `LocalWorkspace` checks the root message's entire image set against every group Agent. If any Agent cannot receive the same set, the discussion is rejected before any process starts.
2. The user chooses a bounded round count; the default is three and the hard cap is twelve.
3. `LocalWorkspace` invokes every group Agent once per complete round, preserving a main-only native session reference for each Agent and topic. Root images are delivered once to each Agent; a failed delivery is retried on that Agent's next attempt instead of silently dropping context. Root Skill selections are revalidated and remain scoped to their target Agent on every attempt.
4. Each Agent must end with one internal consensus marker. The marker is removed before persistence, and the run stops early only when every Agent completes and agrees in the same round.
5. A failed Agent is recorded once per stable failure, while later Agents and later bounded rounds continue. Active progress and terminal state are emitted separately from message history.
6. The user can stop the group, and a 30-minute total runtime limit also aborts the active process tree.

**Deny cases:** Missing topic root, fewer than two Agents, or another active run.

**State/side effects:** Final messages, bounded execution metadata, and main-only session-reference mappings are updated. Active and terminal run events remain transient. There is a per-run safety timer, but no recurring schedule, unattended cron trigger, or retry daemon.

“Equal context” here means every Agent can receive the same root image set before the run is allowed. Discussion remains sequential, so later Agents in a round can see earlier replies; native sessions and selected Skills also remain Agent-specific.

## 8. Shutdown IPC Gate

**Precondition:** Electron receives `before-quit`.

1. Main sets `shutdownStarted` before beginning asynchronous cleanup.
2. Every registered trusted IPC handler continues to verify the renderer and then rejects with `DESKTOP_CLIENT_SHUTTING_DOWN`; no new read, mutation, import, install, Provider, or Agent operation can enter during teardown.
3. Main cancels pending/active installation work, aborts all Agent runs, and waits for both workspace and installer settlement.
4. Repeated quit requests reuse the same cleanup operation. After settlement, main marks cleanup complete and calls `app.quit()` once more to exit.

**Deny case:** Any renderer IPC request after shutdown starts is rejected even when it comes from the otherwise trusted main frame.

**State/side effects:** Active child processes are stopped before exit, and no new IPC side effect can race with final persistence or attachment cleanup.
