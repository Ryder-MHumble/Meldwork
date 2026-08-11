# Agent Connector SDK

Meldwork imports Agent Connectors as local, content-addressed JSON packages. A package selects one app-owned recipe provider and contains one strict Agent Connector Manifest. It cannot register an executable, expose a filesystem path to the renderer, or add renderer-side shell access.

## Package record

The canonical JSON record has these fields:

```json
{
  "packageId": "connector-package-<sha256>",
  "schemaVersion": 1,
  "recordType": "agent-connector-package",
  "publisher": {
    "id": "example.publisher",
    "name": "Example Publisher"
  },
  "provider": {
    "id": "sdk.local-echo.v1",
    "config": {}
  },
  "manifest": {}
}
```

`packageId` is the SHA-256 hash of the canonical record body without `packageId`. The nested Manifest has its own content-addressed `manifestId`. Non-canonical JSON, unknown fields, forged IDs, unsupported providers, provider/Manifest mismatches, and undeclared capabilities are rejected.

The installable non-delegate example is [local-echo.connector.json](../desktop/samples/local-echo.connector.json).

## Providers

`sdk.local-echo.v1` is a credential-free, local-only reference provider. It returns text without delegating to an installed Agent and requires a `cli/json` Manifest with no outbound destinations.

`sdk.http-json.v1` sends a bounded JSON POST from the Electron main process. Its configuration is:

```json
{
  "id": "sdk.http-json.v1",
  "config": {
    "endpoint": "https://connector.example.com/v1/run",
    "authSlotId": "access-token"
  }
}
```

The endpoint must be HTTPS and its exact origin must appear in the Manifest's `outboundDestinations`. `authSlotId` is either `null` or a declared credential slot; when present, the app resolves the encrypted CredentialRef in the main process and sends it as a Bearer token. The renderer never receives the credential or reference.

The request body contains `prompt`, `sessionRef`, `resume`, `permissionMode`, and `operationId`. A successful response is JSON with a required string `text` and an optional string `sessionRef`.

## Trust lifecycle

The supported lifecycle is:

```text
imported -> approved -> installed -> disabled -> installed
                   \-> revoked -> removed
imported/approved/disabled -> revoked
imported/approved/disabled/revoked -> removed
```

Import uses a native file picker, and approval uses a native confirmation dialog that displays publisher identity, origin filename and hash, Connector version, transport, permissions, credential slots, outbound destinations, and SDK provider. Trust changes are persisted as a hash-chained append-only audit log. Missing or corrupt package state disables the Connector subsystem without preventing the desktop app from starting.

Upgrade installs one approved newer package for the same `connectorId` and disables the previous package. An in-use package must have its instances removed before upgrade or removal.

## Conformance

Run the complete local suite with:

```bash
npm --prefix desktop run connector:conformance
```

The suite covers canonical package and Manifest parsing, trust persistence and tamper detection, capability enforcement, event validation, cancellation, resume input, encrypted credentials, outbound destination enforcement, failure semantics, upgrades, and the non-delegate sample end to end. It requires no server.
