# Security And Side-Effect Flows

Meldwork has one human actor: the local desktop user. There are no accounts, roles, claims, tenants, or server-side authorization checks. Protected operations are authorized by the Electron main process accepting IPC only from the exact bundled renderer main frame.

## 1. Application Startup

**Precondition:** The local user launches Meldwork.

1. Electron main creates Provider, knowledge, attachment, Context Pack, Outcome, Human Gate, Cloud operation, Channel Inbox, and bounded Run Ledger stores under `app.getPath('userData')`, plus `LocalWorkspace`, Connector registries/runtimes, and a `LocalSkillCatalog` rooted at `app.getPath('home')`.
2. Main registers IPC handlers, creates a sandboxed `BrowserWindow`, and loads the bundled frontend with `loadFile`.
3. Before accepting attachment work, main reconciles the private attachment directory against persisted message references. Malformed workspace state disables destructive cleanup.
4. Preload exposes workspace, installer, Skill, attachment, and Provider methods only when `location.protocol === 'file:'`.
5. The renderer requests a sanitized workspace snapshot and a non-probing Provider status.
6. The renderer performs the single startup Agent refresh, which detects installed CLIs and evaluates credential readiness. Main does not launch a duplicate eager scan.
7. `LocalWorkspace` restores durable Human Gate decisions and recoverable continuations before marking unrelated nonterminal local runs `interrupted`, then reconciles terminal Agent attempts into compact conversation messages. Writable local work is never auto-resumed without an accepted continuation.
8. Cloud runtime claims configured remote jobs by durable owner/cursor and replays idempotent pending operations; Channel runtime starts configured main-process receivers and drains its durable Inbox. Both runtimes default to zero Connectors.
9. On the first renderer launch, a three-slide onboarding carousel opens while that refresh runs. Its completion action remains disabled until detection actually settles; completion is stored only in renderer `localStorage`.

**Deny case:** IPC from a different frame, web contents instance, protocol, or file path fails `requireDesktopRenderer`.

**State/side effects:** Reads local Agent/Skill configuration and Meldwork data, removes only confirmed orphan attachment entries, and writes a non-secret onboarding preference after dismissal; it does not contact an application server.

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

## 4. Manage Meldwork Conversations

**Precondition:** At least one detected Agent is available. The user selects a working directory.

1. The sidebar groups direct conversations under each available Agent and may create more than one Meldwork conversation for the same Agent.
2. Renderer sends the Meldwork conversation name/topic, Agent kinds, user-selected directory, and `allowWrite`.
3. Main validates the renderer and delegates create, select, rename, update, or delete operations to `LocalWorkspace` using a Meldwork-owned conversation ID.
4. `LocalWorkspace` keeps only available Agent kinds, resolves the directory, stores `allowWrite` as an explicit boolean, and isolates direct native Sessions by conversation and Agent and group native Sessions by Task and Agent.
5. Older topic/conversation-scoped group references are migrated once to Task scope. Changing the working directory clears that conversation's native Session mappings.
6. The workspace file is updated and a sanitized snapshot is emitted to the trusted renderer.

**Deny cases:** No available Agent, invalid group ID, or attempts to enable an unavailable Agent.

**State/side effects:** Writes local conversation configuration. Deleting a conversation is denied while it is running, first purges its Run Ledger records, then removes Meldwork messages and native session-reference mappings. A failed ledger purge leaves the conversation intact; a later workspace-write failure rolls back the in-memory conversation state, so deletion remains retryable without retaining app-owned trace checkpoints. It does not delete any CLI-native session or history from the CLI's own storage.

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

## 6. Connect And Select Knowledge Sources

**Precondition:** The user opens Knowledge Base settings or opens the composer mention menu.

1. Main resolves a code-defined source catalog. Feishu and DingTalk are probed through allowlisted local CLI commands; Obsidian is detected as an app or CLI and uses a user-selected Vault directory.
2. Main returns sanitized readiness, login, permission, read/write, command-name, and selected-Vault status. Notion, Confluence, Google Drive, and SharePoint remain planned reference entries rather than active Connectors.
3. Selecting an Obsidian Vault uses a main-owned directory dialog and persists only the normalized absolute path in `roundrelay-knowledge-base.json`.
4. The composer may select up to four ready knowledge sources and scopes each selection to explicit target Agents.
5. Before accepting the message, main re-probes missing cache entries and validates that the source is currently readable, its access mode is supported, and every target belongs to the current run.
6. Before invocation, the Knowledge Connector runtime turns explicit Obsidian selections into bounded search/fetch results and immutable snapshots with stable source IDs, content hashes, and reopenable citations. Feishu and DingTalk selections retain explicit live CLI-reference semantics.
7. Only the selected Agent receives its approved snapshot/citation records or validated live-reference hint.

**Deny cases:** Unknown or planned source, missing login, missing permission, unreadable or invalid Vault, unsupported access mode, empty target set, target outside the run, or stale source state.

**State/side effects:** Probes may invoke local Feishu/DingTalk commands and read local installation state. Obsidian Connector retrieval is bounded and read-only, and its snapshots/citations are stored privately. A later Agent run may send approved derived content to its configured Provider; live CLI references retain an explicit provenance limitation.

## 7. Send A Message To Agents

**Precondition:** The conversation is not already running and at least one selected target belongs to the group.

1. `LocalWorkspace` reserves a unique `runId` and Task identity, captures an immutable Context Pack before the first durable execution checkpoint, validates the complete request, persists the user message, and begins a cancellable run for the explicit target Agents.
2. Each attempt receives an immutable delivery record containing its exact approved prompt fingerprint, source IDs/hashes, target scope, permission mode, Connector version, and native Session provenance. The first group turn sends the bootstrap instructions; after a native Session has completed once, later group turns send only a `ROUNDRELAY_HARNESS_CONTEXT_V1` continuation containing bounded stable constraints and recent conclusions. A resumed Session therefore receives only its validated, Harness-compressed delta; Session rotation or recovery returns to bootstrap.
3. Main resolves a built-in adapter or approved Agent Connector plus attachment paths, CredentialRefs, Provider/native environment, and selected Skill/knowledge snapshots. Prompt text cannot select an executable or unapproved Connector.
4. CLI adapters apply per-Agent read-only or write-enabled arguments. Child processes receive an allowlisted system environment plus only current-Agent credentials.
5. Main emits allowlisted status, conclusion deltas, reasoning summaries, plans, tool lifecycle summaries, warnings, and bounded result metadata. Direct conversations render these inline while running; group conversations stream conclusions in the shared conversation and keep detailed process events in the right-side panel. Raw chain-of-thought and unrestricted tool output are never emitted.
6. Meaningful Agent events and context statistics update the bounded Run Ledger checkpoint. Versioned Connector events are reduced idempotently, while normalized final text becomes message content and typed Artifacts/Evidence remain separate durable records. Native Session references remain main-only. For Hermes, a post-watermark non-empty `assistant` row with `finish_reason` `stop` or `length` overrides process output; validated `--quiet` stdout remains the fallback.
7. Failures are recorded as diagnostic system messages, with any conclusion already emitted through answer deltas retained below the status text. One failed Agent does not cancel successful Agents; when every Agent fails after the user message has been persisted, the send resolves as an accepted failed run so the renderer does not restore and duplicate the committed draft or attachments.
8. On terminal state, main finalizes the Ledger record and emits a best-effort sanitized run event. Live direct disclosures collapse; the active group process panel closes, while result messages retain a trace entry that can reopen durable compact evidence. A historical panel opened from a result remains open across unrelated run completion. When the window is unfocused main also creates a content-free operating-system notification whose click action focuses the app and opens the Meldwork conversation; shutdown suppresses these notifications.

**Deny cases:** Empty text and no image, target outside the group, unavailable Agent, concurrent run, invalid Skill/attachment context, invalid sandbox, or authentication failure.

**External side effects:** Agent/provider network calls and possible workspace reads. Workspace writes are intended only when `allowWrite` is true, subject to upstream CLI enforcement.

## 8. Equal-Context Automatic Discussion And Stop

**Precondition:** A group has at least two explicitly targeted Agents and a persisted user topic root.

1. Before creating a run, `LocalWorkspace` checks the root message's entire image set against every explicitly targeted Agent. If any target cannot receive the same set, the discussion is rejected before any process starts.
2. The user chooses either a finite round count from one to ten, defaulting to six, or explicitly confirms no round limit. Unlimited mode has no total runtime cap; it stops on consensus, explicit user stop, application shutdown, or a terminal run failure. Every individual Agent attempt still has its own watchdog timeout.
3. `LocalWorkspace` invokes every explicitly targeted group Agent once per complete round. Each group Task and Agent has a main-only native Session reference, while all selected Agents receive the same bounded shared Task context and prior conclusions. Direct conversations retain conversation-and-Agent Session continuity. Root images are delivered once to each Agent; a failed delivery is retried on that Agent's next attempt instead of silently dropping context. Root Skill and knowledge-source selections are revalidated and remain scoped to their target Agent on every attempt.
4. Each Agent must end with one internal consensus marker. The marker is removed before persistence, and the run stops early only when every Agent completes and agrees in the same round.
5. A failed Agent is recorded once per stable failure, while later Agents and later bounded rounds continue. Retryable network and rate-limit failures use bounded backoff. HTTP 401/403 and compatibility failures end the affected Agent slot after one attempt, retain the configured group membership, and require an explicit user retry or replacement after configuration is corrected. Each later Agent receives prior conclusions plus compact, source-addressable evidence capsules instead of complete tool logs.
6. The user can stop only the currently displayed `(groupId, runId)` pair. A missing or stale `runId` is rejected, preventing an old UI request from cancelling a newer run. Per-Agent cancel, retry, and replace controls abort only the selected attempt; whole-run stop aborts the active process tree. Both paths retain the conversation run lock until child/output cleanup settles.

**Deny cases:** Missing topic root, fewer than two selected target Agents, or another active run.

**State/side effects:** Final messages, compact evidence capsules, bounded private Run Ledger checkpoints, and main-only session-reference mappings are updated. Live renderer events remain transient. A manual stop persists the last available Agent trace as `stopped`; shutdown-originated cancellation and crash recovery use `interrupted`, while an individual watchdog timeout remains `timeout`. There is no total Run timer, recurring schedule, unattended cron trigger, auto-resume worker, or retry daemon.

“Equal context” here means every Agent can receive the same root image set before the run is allowed. Discussion remains sequential, so later Agents in a round can see earlier replies. Native Sessions are Task-and-Agent-specific for group work and conversation-and-Agent-specific for direct work; selected Skills remain Agent-specific.

## 9. Cloud Agent Detach And Reattach

**Precondition:** A main-owned approved Cloud Connector is configured; local-only deployments leave the Connector list empty.

1. Main submits with a stable idempotency key and persists the remote job ID, cursor, Connector/upstream provenance, and recovery owner.
2. The UI may close while Electron main keeps observing. After restart, the runtime claims the remote job, reconciles its cursor, and reduces duplicate/out-of-order events without duplicating terminal transitions or Artifacts.
3. Waiting input/permission answers and cancel operations are persisted before delivery and replayed with the same idempotency key after a crash.
4. Preload exposes only sanitized status, waiting request, Artifact/Evidence IDs, and explicit input/permission/cancel commands; raw job IDs and cursors remain main-only.

**External side effects:** Calls the configured Cloud Connector. Shutdown aborts observation and waits only for a bounded grace period even when a Connector ignores cancellation.

## 10. Channel Ingress And Durable Inbox

**Precondition:** A main-owned Channel Connector, Connection, ExternalActor, Subscription, and Workspace/Task mapping are configured. The production default has no Connector.

1. The Connector verifies the signed envelope in main. Runtime rejects invalid, expired, replayed, cross-Workspace, disabled-subscription, or unknown-actor events.
2. A valid event creates one durable Delivery keyed by Connection and idempotency key. Only the bounded Task request is stored; raw headers/signatures and full IM history are discarded.
3. The Inbox upserts the mapped local Task exactly once across retries/restart and advances a durable cursor.
4. Outbound replies reference the originating Delivery and are stored as auditable idempotent records.
5. Closing the last window does not stop an active receiver; application shutdown stops it with a bounded grace period.

**Renderer boundary:** There is no Channel IPC, preload method, Inbox browser, raw payload exposure, or renderer-visible CredentialRef.

## 11. Shutdown IPC Gate

**Precondition:** Electron receives `before-quit`.

1. Main sets `shutdownStarted` before beginning asynchronous cleanup.
2. Every registered trusted IPC handler continues to verify the renderer and then rejects with `DESKTOP_CLIENT_SHUTTING_DOWN`; no new read, mutation, import, install, Provider, or Agent operation can enter during teardown.
3. Main cancels pending/active installation work, assigns `shutdown` only to run controllers without an existing stop reason, aborts local Agent processes, checkpoints/finalizes shutdown-originated attempts as `interrupted` while preserving prior stopped/timeout intent, and starts bounded Channel/Cloud runtime shutdown.
4. Main waits for workspace/installer settlement and the bounded Connector grace periods. A Connector that ignores `AbortSignal` cannot block application exit indefinitely.
5. Repeated quit requests reuse the same cleanup operation. After settlement, main marks cleanup complete and calls `app.quit()` once more to exit.

**Deny case:** Any renderer IPC request after shutdown starts is rejected even when it comes from the otherwise trusted main frame.

**State/side effects:** Active child processes are stopped before exit, the last bounded sanitized trace is retained, and no new IPC side effect can race with final persistence or attachment cleanup. An abrupt exit is reconciled from the last atomic Run Ledger checkpoint on the next launch.
