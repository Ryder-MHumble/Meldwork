# macOS Developer ID Signing And Notarization

The current private preview is ad-hoc signed. Public DMG and ZIP distribution should use a Developer ID Application certificate and Apple notarization so Gatekeeper accepts the app on a clean Mac.

## 1. Enroll With Apple

1. Sign in at [developer.apple.com/programs/](https://developer.apple.com/programs/) with the Apple ID that will own the release.
2. Enable two-factor authentication and enroll in the Apple Developer Program. Apple currently charges an annual membership fee; confirm the current local price and organization-verification requirements on Apple's enrollment page.
3. If publishing as an organization, enroll the legal entity rather than a personal account. Apple may request a D-U-N-S number and authority to bind the organization.
4. Record the ten-character Apple Team ID from the Membership page.

Approval may take from hours to several business days depending on identity or organization verification. This repository cannot automate enrollment.

## 2. Choose The Permanent App Identity

The public Bundle ID is `com.rydersun.meldwork`. Register this exact identifier before the first notarized Release and keep it stable afterward; changing it later can affect macOS identity, permissions, Keychain access, and update continuity.

Register the chosen identifier under Certificates, Identifiers & Profiles. Use one stable reverse-DNS value and keep it unchanged after public release.

## 3. Create The Signing Certificate

Recommended local setup:

1. Install the latest stable Xcode supported by the release Mac.
2. Open Xcode Settings, select Accounts, add the enrolled Apple ID, and choose the correct Team.
3. Open Manage Certificates and create a `Developer ID Application` certificate.
4. Confirm the certificate and private key exist in the login Keychain:

```bash
security find-identity -v -p codesigning
```

DMG and ZIP distribution needs `Developer ID Application`. `Developer ID Installer` is only needed when distributing a signed `.pkg` installer.

Back up the certificate and private key as an encrypted `.p12` stored outside the repository. Never commit certificates, passwords, API keys, or notarization profiles.

## 4. Create Notarization Credentials

The preferred CI path is an App Store Connect API key:

1. Open App Store Connect, then Users and Access, Integrations, App Store Connect API.
2. Create a key with the minimum role that can submit notarization jobs for the Team.
3. Download the `.p8` file once and record its Key ID and Issuer ID.

For local-only use, `notarytool` can store credentials in Keychain:

```bash
xcrun notarytool store-credentials "meldwork-notary" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "YOUR_TEAM_ID" \
  --password "YOUR_APP_SPECIFIC_PASSWORD"
```

Create the app-specific password at appleid.apple.com. Do not use the normal Apple ID password.

## 5. Configure electron-builder

The repository now uses `com.rydersun.meldwork` and AGPL-3.0-only for the Community Edition. The public release configuration must keep hardened runtime enabled and allow electron-builder to sign and notarize after the existing `afterPack` fuse hardening.

For a local Keychain certificate, electron-builder can discover the valid `Developer ID Application` identity. In CI, export the certificate as an encrypted `.p12` and provide secrets such as:

```text
CSC_LINK
CSC_KEY_PASSWORD
APPLE_API_KEY
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

`APPLE_API_KEY` must point to the private `.p8` file in the runner. An Apple ID alternative uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.

For a local Keychain profile, set `APPLE_KEYCHAIN_PROFILE=meldwork-notary`; `APPLE_KEYCHAIN` is optional when the profile is stored in the default Keychain.

The `dist:public` command runs `scripts/public-release-preflight.cjs`, uses `electron-builder.public.cjs` with `forceCodeSigning: true` and `mac.notarize: true`, and then runs `scripts/after-sign.cjs`. The post-sign hook rejects ad-hoc identities, a missing Team ID, a missing hardened-runtime flag, or any Bundle ID other than `com.rydersun.meldwork`.

Do not add plaintext fallbacks. A public release without signing or notarization credentials fails before packaging instead of publishing an ad-hoc artifact.

## 6. Build And Verify

Build the distribution artifacts:

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist:public
```

Use `npm --prefix desktop run dist` only for local package validation. It is intentionally not a public-release command.

Verify the exact output before publishing:

```bash
codesign --verify --deep --strict --verbose=2 \
  desktop/dist/mac-arm64/Meldwork.app

spctl --assess --type execute --verbose=4 \
  desktop/dist/mac-arm64/Meldwork.app

xcrun stapler validate desktop/dist/mac-arm64/Meldwork.app
xcrun stapler validate desktop/dist/Meldwork-0.1.0-arm64.dmg
```

Install the DMG on a clean Apple silicon Mac user account and launch it normally, without right-click bypasses or `xattr` removal. Gatekeeper acceptance on that clean account is the release gate.

Generate checksums only after signing, notarization, and stapling are complete:

```bash
shasum -a 256 \
  desktop/dist/Meldwork-0.1.0-arm64.dmg \
  desktop/dist/Meldwork-0.1.0-arm64.zip
```

## 7. Common Failures

- `CSSMERR_TP_NOT_TRUSTED`: the certificate chain is invalid, expired, missing its private key, or not trusted in the active Keychain.
- `no identity found`: the Developer ID certificate is not installed or electron-builder cannot access its Keychain.
- Notarization rejects the binary: inspect the `notarytool` log for unsigned nested code, missing hardened runtime, invalid entitlements, or bundled executable content.
- `spctl` rejects an otherwise signed app: notarization or stapling is missing, the ticket is invalid, or the tested app differs from the submitted artifact.
- A signed release opens with a fresh data directory: the Bundle ID or product identity changed after the preview; stop and define an explicit migration before publishing.
