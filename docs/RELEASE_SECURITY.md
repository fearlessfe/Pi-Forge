# Release security

Pi Forge publishes only from SemVer tags through `.github/workflows/release.yml`. The build jobs use the protected GitHub environment `production-release`; configure required reviewers and restrict deployment branches/tags in repository settings before the first public release.

## Protected secrets

Store these values as `production-release` environment secrets, not repository variables:

| Platform | Secret | Value |
| --- | --- | --- |
| macOS | `MACOS_CERTIFICATE_P12` | Base64-encoded Developer ID Application `.p12` |
| macOS | `MACOS_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| macOS | `MACOS_NOTARIZATION_KEY_B64` | Base64-encoded App Store Connect API `.p8` key |
| macOS | `APPLE_API_KEY_ID` | App Store Connect API key ID |
| macOS | `APPLE_API_ISSUER` | App Store Connect issuer ID |
| Windows | `WINDOWS_CERTIFICATE_PFX` | Base64-encoded Authenticode `.pfx` |
| Windows | `WINDOWS_CERTIFICATE_PASSWORD` | Password for the `.pfx` |
| Windows | `WINDOWS_PUBLISHER_NAME` | Exact certificate publisher/subject expected by the updater and verification script |

Linux artifacts are not code-signed. They are still covered by the exact artifact manifest, SHA-256 checksums, packaged CycloneDX SBOM, and GitHub attestations.

## Enforced release path

1. The quality job checks the tag and runs frozen install, lint, typecheck, and unit tests.
2. Native runners build the exact platform matrix. macOS and Windows fail if signing credentials are absent or `forceCodeSigning` cannot sign the application.
3. The unpacked packaged application must pass preload, IPC, Runtime, and node-pty smoke checks.
4. macOS verification requires a Developer ID team, hardened runtime, the expected entitlements, Gatekeeper acceptance, and stapled notarization. Windows verification requires a valid Authenticode signature whose signer matches `WINDOWS_PUBLISHER_NAME`.
5. Each packaged `app.asar` produces a CycloneDX 1.6 SBOM. Every installer receives build-provenance and SBOM attestations.
6. Only the Windows x64 installer and macOS universal ZIP retain updater metadata and blockmaps. The scripts reject stale or cross-architecture update metadata and verify each manifest digest.
7. The publish job merges the platform artifacts, checks the exact set, writes `SHA256SUMS`, creates a draft, downloads it again, and compares the remote assets before publishing.

Do not publish artifacts copied from local `apps/desktop/release`; that directory is ignored build output and local packages are normally unsigned.

## Automatic update boundary

Automatic updates are supported only by packaged macOS and Windows builds. The GitHub feed is fixed in Electron Builder configuration and never crosses the preload boundary. The UI can request check, download, and install, but cannot supply a URL or updater options. Download and installation are explicit; automatic download, install-on-quit, downgrade, and prerelease updates are disabled.

Installation is rejected while a foreground Agent or queued/running background Subagent exists. Before requesting installer restart, Main flushes observability data and atomically snapshots the application user-data and Pi home roots. Cache, logs, Crashpad data, and prior snapshots are excluded. Manifests contain file sizes and SHA-256 digests, and only the newest two snapshots are retained under the application user-data `update-snapshots` directory.

`pnpm --dir apps/desktop verify:update-snapshot` simulates an upgrade mutation and verifies an integrity-checked restore into isolated directories. Restoration is deliberately not exposed to the renderer and the application does not automatically downgrade binaries. A production rollback remains an operator-controlled action: stop Pi Forge, preserve the current data directory, verify a retained snapshot in isolation, install a previously signed release through the trusted release channel, then restore only after review.
