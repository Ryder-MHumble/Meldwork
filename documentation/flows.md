# Security And Side-Effect Flows

RoundRelay has one human actor: the local desktop user. There are no accounts, roles, claims, tenants, or server-side authorization checks. Protected operations are authorized by the Electron main process accepting IPC only from the exact bundled renderer main frame.

## 1. Application Startup

**Precondition:** The local user launches RoundRelay.

1. Electron main creates `ProviderStore` and `LocalWorkspace` under `app.getPath('userData')`.
2. Main registers IPC handlers, creates a sandboxed `BrowserWindow`, and loads the bundled frontend with `loadFile`.
3. After the window exists, main detects installed Agent CLIs and evaluates credential readiness.
4. Preload exposes workspace, installer, and Provider methods only when `location.protocol === 'file:'`.
5. The renderer requests a sanitized workspace snapshot and a non-probing Provider status.

**Deny case:** IPC from a different frame, web contents instance, protocol, or file path fails `requireDesktopRenderer`.

**State/side effects:** Reads local Agent configuration and RoundRelay data; does not contact an application server.

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

## 4. Create Or Change A Conversation

**Precondition:** At least one detected Agent is available. The user selects a working directory.

1. Renderer sends group name/topic, Agent kinds, resolved directory, and `allowWrite`.
2. Main validates the renderer and delegates to `LocalWorkspace`.
3. `LocalWorkspace` keeps only available Agent kinds, resolves the directory, and stores `allowWrite` as an explicit boolean.
4. The workspace file is updated and a sanitized snapshot is emitted to the trusted renderer.

**Deny cases:** No available Agent, invalid group ID, or attempts to enable an unavailable Agent.

**State/side effects:** Writes local group configuration. Deleting a group also deletes its local messages and session references; deletion is denied while that group is running.

## 5. Send A Message To Agents

**Precondition:** The conversation is not already running and at least one selected target belongs to the group.

1. `LocalWorkspace` persists the user message and creates a cancellable run.
2. It builds a bounded prompt from the local topic transcript.
3. Main resolves the Agent executable internally, selects Provider/native credential environment, and invokes the CLI in the group working directory.
4. CLI adapters apply per-Agent read-only or write-enabled arguments. Child processes receive an allowlisted system environment plus only current-Agent credentials.
5. Normalized Agent output and native session references are stored locally.
6. Failures are recorded as system messages; one failed Agent does not cancel successful Agents, while an all-failed run rejects with an aggregate error.

**Deny cases:** Empty message, target outside the group, unavailable Agent, concurrent run, invalid sandbox, or authentication failure.

**External side effects:** Agent/provider network calls and possible workspace reads. Workspace writes are intended only when `allowWrite` is true, subject to upstream CLI enforcement.

## 6. Automatic Discussion, Stop, And Quit

**Precondition:** A group has at least two Agents and a persisted user topic root.

1. The user starts automatic discussion and chooses a bounded round count; the default is three and the hard cap is twelve.
2. `LocalWorkspace` invokes every group Agent once per complete round, preserving a separate native session for each Agent and topic.
3. Each Agent must end with one internal consensus marker. The marker is removed before persistence, and the run stops early only when every Agent completes and agrees in the same round.
4. A failed Agent is recorded once per stable failure, while later Agents and later bounded rounds continue.
5. The user can stop the group, and a 30-minute total runtime limit also aborts the active process tree.
6. On application quit, main cancels an active installer, aborts all Agent runs, waits for settlement, then exits.

**Deny cases:** Missing topic root, fewer than two Agents, or another active run.

**State/side effects:** Local messages and sessions are updated. There is a per-run safety timer, but no recurring schedule, unattended cron trigger, or retry daemon.
