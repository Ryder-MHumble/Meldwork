# Local Skill trust and execution contracts

Meldwork treats a selected Skill as immutable prompt material, not executable renderer code. A
local Skill must place `meldwork.skill.json` next to `SKILL.md`. The desktop main process captures
both files, binds trust to their exact content hash, and rejects the Skill before Agent execution
when its declared contract does not match the current task.

## Manifest

```json
{
  "schemaVersion": 1,
  "recordType": "meldwork-skill-manifest",
  "identity": {
    "id": "global/read-only-review",
    "version": "1.0.0"
  },
  "origin": {
    "type": "local-unsigned",
    "publisher": "Local author"
  },
  "agents": [
    {
      "kind": "codex",
      "minVersion": "0.130.0",
      "maxVersion": "0.200.0"
    }
  ],
  "inputTypes": ["text"],
  "tools": ["filesystem"],
  "credentials": [],
  "permissionMode": "read-only",
  "networkDestinations": [],
  "sideEffectClass": "none"
}
```

`identity.id` must equal `<catalog namespace>/<Skill directory slug>`. Agent versions use strict
semantic versions. Supported input types are `text`, `image`, `audio`, `video`, `file`, and
`structured-data`. Tool classes are `agent-native`, `filesystem`, `filesystem-read`, `shell`,
`network`, and `browser`.

Credentials declare requirements only. The current Skill boundary does not broker credentials, so
a Skill that declares credentials is rejected until a credential-ref integration is available.
Network destinations must be credential-free HTTPS origins. Any non-`none` side effect requires
`workspace-write`; `external-write` also requires at least one declared destination.

## Trust lifecycle

On first use, Meldwork shows a native approval dialog containing the unsigned origin, Agent range,
inputs, tools, credentials, permission mode, destinations, side-effect class, manifest hash, and
content hash. Approval is scoped to the Agent coordinates and exact hashes. Editing any Skill file
or the manifest creates a new scope and requires another approval.

Trust decisions are stored in the private application data directory as a hash-chained audit log.
The narrow desktop API can list and revoke decisions, but it never returns Skill source paths,
credential values, or executable access. Corrupt audit state disables Skill trust without blocking
desktop startup.

## Enforcement

Meldwork verifies the contract during message preflight and again immediately before Agent
execution. It rejects missing manifests, unapproved or revoked content, snapshot tampering,
incompatible Agent versions, missing input types or tool classes, unavailable credentials, and any
permission escalation. The Agent prompt receives only the approved immutable snapshot entry.
