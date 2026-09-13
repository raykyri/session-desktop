# Releasing the macOS DMG

Session's release build is a signed and notarized universal macOS app. The
release is hosted in `aka-com/session`; the updater keypair remains the existing
deployment contract and is not regenerated for the repository rename.

## Prerequisites

- Install the Rust `aarch64-apple-darwin` and `x86_64-apple-darwin` targets.
- Install and unlock the `Developer ID Application` certificate in the login
  keychain.
- Put the updater private key at `~/.tauri/session-updater.key`, or set
  `TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH`.
- Configure `.env` with `APPLE_SIGNING_IDENTITY` plus either the Apple ID
  (`APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`) or App Store Connect API
  key (`APPLE_API_KEY`, `APPLE_API_ISSUER`, and `APPLE_API_KEY_PATH`)
  notarization credentials.
- Authenticate GitHub CLI with access to `aka-com/session` using `gh auth login`.

Before building, choose a version newer than the last published build. Update
`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, and the three
Cargo package manifests; then refresh `src-tauri/Cargo.lock`. The release script
checks every one of those versions. The worktree must also be clean, and `HEAD`
must equal both `origin/main` and the default branch in `aka-com/session`.

## Build and inspect locally

To create the production artifacts without touching GitHub:

```sh
scripts/build.sh --notarize
scripts/generate-latest-json.sh
scripts/verify-release.sh --require-notarized
```

The distributable DMG is written to:

```text
src-tauri/target/universal-apple-darwin/release/bundle/dmg/Session_<version>_universal.dmg
```

Mount that DMG, drag Session to Applications, launch it, and exercise startup,
creating a research session, and Check for Updates. Testing the installed copy
also catches quarantine and Gatekeeper behavior that launching the build-tree
app does not.

## Create and publish the release

After committing and pushing the version bump to `main`, run:

```sh
npm run build:release
```

That command runs the full preflight, rebuilds and notarizes the universal app
and DMG, verifies the artifacts, writes `latest.json` and `SHA256SUMS`, and
uploads everything to a draft `aka-com/session` GitHub release. It does not
publish the release.

Install the DMG attached to the draft once more. When it passes, publish it with
the exact command printed by the release script:

```sh
gh release edit v<version> --repo aka-com/session --draft=false
```

Publishing makes `releases/latest/download/latest.json` visible to Session's
updater. Do not publish an unnotarized build.
