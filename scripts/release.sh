#!/usr/bin/env bash
set -euo pipefail

# Builds, signs, and notarizes the universal DMG, then uploads a draft GitHub
# release with everything the updater endpoint needs. Publish the draft by hand
# after checking the notes and installing the DMG once.
#
# Required environment:
#   APPLE_SIGNING_IDENTITY   Developer ID Application identity (auto-detected
#                            from the keychain when exactly one is present)
#   APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY +
#   APPLE_API_ISSUER + APPLE_API_KEY_PATH, for notarization.
#   TAURI_SIGNING_PRIVATE_KEY (contents), TAURI_SIGNING_PRIVATE_KEY_PATH, or
#   ~/.tauri/session-updater.key, for signing the updater archive.
#   Set SESSION_ALLOW_UNNOTARIZED=1 to build a release without notarizing
#   (downloads will hit Gatekeeper).

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null && pwd)"
cd "$repo_root"

github_repository="aka-com/session"

# Signing/notarization credentials live in .env (gitignored), as plain
# KEY=VALUE lines. Variables already set in the environment win, so a one-off
# override doesn't require editing the file.
if [[ -f .env ]]; then
  # `|| [[ -n "$line" ]]` keeps a final line that lacks a trailing newline.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    name="${line%%=*}"
    value="${line#*=}"
    # Strip one layer of matching quotes so KEY="a b" exports as a b.
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    [[ -n "${!name+x}" ]] || export "$name=$value"
  done <.env
fi

read_version() {
  sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$1" | head -1
}

read_cargo_version() {
  sed -n 's/^version = "\([^"]*\)"/\1/p' "$1" | head -1
}

read_cargo_lock_version() {
  awk -v expected_name="$1" '
    /^\[\[package\]\]$/ { package = "" }
    /^name = "/ {
      package = $0
      sub(/^name = "/, "", package)
      sub(/"$/, "", package)
      next
    }
    package == expected_name && /^version = "/ {
      version = $0
      sub(/^version = "/, "", version)
      sub(/"$/, "", version)
      print version
      exit
    }
  ' src-tauri/Cargo.lock
}

version="$(read_version src-tauri/tauri.conf.json)"
npm_version="$(read_version package.json)"
npm_lock_version="$(read_version package-lock.json)"
cargo_version="$(read_cargo_version src-tauri/Cargo.toml)"
cli_version="$(read_cargo_version src-tauri/crates/session-cli/Cargo.toml)"
proto_version="$(read_cargo_version src-tauri/crates/session-proto/Cargo.toml)"
cargo_lock_version="$(read_cargo_lock_version session)"
cli_lock_version="$(read_cargo_lock_version session-cli)"
proto_lock_version="$(read_cargo_lock_version session-proto)"

# The updater manifest, DMG filename, and Info.plist each read a different one
# of these files, so a release with drifted versions half-works at best.
if [[ -z "$version" || -z "$npm_version" || -z "$npm_lock_version" ||
  -z "$cargo_version" || -z "$cli_version" || -z "$proto_version" ||
  -z "$cargo_lock_version" || -z "$cli_lock_version" || -z "$proto_lock_version" ]]; then
  echo "Could not read the release version from every package file." >&2
  exit 1
fi

if [[ "$version" != "$npm_version" ]] || [[ "$version" != "$npm_lock_version" ]] ||
  [[ "$version" != "$cargo_version" ]] || [[ "$version" != "$cli_version" ]] ||
  [[ "$version" != "$proto_version" ]] || [[ "$version" != "$cargo_lock_version" ]] ||
  [[ "$version" != "$cli_lock_version" ]] || [[ "$version" != "$proto_lock_version" ]]; then
  echo "Version mismatch:" >&2
  echo "  src-tauri/tauri.conf.json=$version" >&2
  echo "  package.json=$npm_version" >&2
  echo "  package-lock.json=$npm_lock_version" >&2
  echo "  src-tauri/Cargo.toml=$cargo_version" >&2
  echo "  src-tauri/crates/session-cli/Cargo.toml=$cli_version" >&2
  echo "  src-tauri/crates/session-proto/Cargo.toml=$proto_version" >&2
  echo "  src-tauri/Cargo.lock session=$cargo_lock_version" >&2
  echo "  src-tauri/Cargo.lock session-cli=$cli_lock_version" >&2
  echo "  src-tauri/Cargo.lock session-proto=$proto_lock_version" >&2
  exit 1
fi

tag="v$version"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty — commit or stash before releasing." >&2
  exit 1
fi

# Refresh the remote branch and tags before checking them. Otherwise a stale
# origin/main can reject a pushed commit or allow a release from an old commit.
if ! git fetch --quiet --tags origin main; then
  echo "Could not refresh origin/main and release tags." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists — bump the version first." >&2
  exit 1
fi

# Releases are cut from the current pushed main commit so an older checkout
# cannot accidentally publish a stale version.
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "HEAD does not match origin/main — pull or push first." >&2
  exit 1
fi

target="${SESSION_BUILD_TARGET:-universal-apple-darwin}"
if [[ "$target" != "universal-apple-darwin" ]]; then
  echo "Releases must use SESSION_BUILD_TARGET=universal-apple-darwin." >&2
  exit 1
fi

if ! command -v gh >/dev/null || ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is missing or not authenticated — run: gh auth login" >&2
  exit 1
fi

if ! release_branch="$(gh api "repos/$github_repository" --jq .default_branch)" ||
  [[ -z "$release_branch" ]]; then
  echo "Could not read the default branch for $github_repository." >&2
  exit 1
fi
if ! release_head="$(gh api "repos/$github_repository/commits/$release_branch" --jq .sha)" ||
  [[ -z "$release_head" ]]; then
  echo "Could not read $github_repository's $release_branch commit." >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$release_head" ]]; then
  echo "HEAD does not match $github_repository's $release_branch — push it before releasing." >&2
  exit 1
fi

default_updater_key="$HOME/.tauri/session-updater.key"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  updater_key_path="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$default_updater_key}"
  if [[ ! -f "$updater_key_path" ]]; then
    echo "Updater signing failed: a public key is configured, but no private key was provided." >&2
    if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
      echo "Private key file does not exist: $updater_key_path" >&2
    fi
    echo "Set TAURI_SIGNING_PRIVATE_KEY, set TAURI_SIGNING_PRIVATE_KEY_PATH, or install the updater key at:" >&2
    echo "  $default_updater_key" >&2
    exit 1
  fi
  export TAURI_SIGNING_PRIVATE_KEY="$updater_key_path"
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  identities="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p')"
  if [[ "$(printf '%s\n' "$identities" | grep -c .)" -ne 1 ]]; then
    echo "Set APPLE_SIGNING_IDENTITY (found identities: ${identities:-none})." >&2
    exit 1
  fi
  export APPLE_SIGNING_IDENTITY="$identities"
  echo "Signing as: $APPLE_SIGNING_IDENTITY"
fi

have_apple_id_creds() {
  [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] ||
    return 1
}

have_api_key_creds() {
  [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]] ||
    return 1
}

have_notary_creds() {
  have_apple_id_creds || have_api_key_creds
}

if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "APPLE_TEAM_ID is required when APPLE_ID and APPLE_PASSWORD are set." >&2
  exit 1
fi

if ! have_notary_creds && [[ "${SESSION_ALLOW_UNNOTARIZED:-}" != "1" ]]; then
  echo "No notarization credentials (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID or" >&2
  echo "APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH). Set them, or" >&2
  echo "SESSION_ALLOW_UNNOTARIZED=1" >&2
  echo "to knowingly ship a build Gatekeeper will block." >&2
  exit 1
fi

if ! have_apple_id_creds && have_api_key_creds && [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
  echo "APPLE_API_KEY_PATH does not exist: $APPLE_API_KEY_PATH" >&2
  exit 1
fi

npm run preflight

if have_notary_creds; then
  "$script_dir/build.sh" --notarize
else
  # The credential check above permits this only when the caller explicitly
  # accepted an unnotarized release with SESSION_ALLOW_UNNOTARIZED=1.
  "$script_dir/build.sh"
fi
"$script_dir/generate-latest-json.sh"

bundle_root="src-tauri/target/$target/release/bundle"
dmg="$bundle_root/dmg/Session_${version}_universal.dmg"
archive="$bundle_root/macos/Session.app.tar.gz"
signature="$archive.sig"
manifest="$bundle_root/macos/latest.json"

for file in "$dmg" "$archive" "$signature" "$manifest"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing release artifact: $file" >&2
    exit 1
  fi
done

if have_notary_creds; then
  "$script_dir/verify-release.sh" --require-notarized
else
  "$script_dir/verify-release.sh"
fi

checksums="$bundle_root/SHA256SUMS"
(cd "$(dirname "$dmg")" && shasum -a 256 "$(basename "$dmg")") >"$checksums"
(cd "$(dirname "$archive")" && shasum -a 256 "$(basename "$archive")") >>"$checksums"

gh release create "$tag" \
  --repo "$github_repository" \
  --draft \
  --title "Session $tag" \
  --generate-notes \
  --target "$(git rev-parse HEAD)" \
  "$dmg" "$archive" "$signature" "$manifest" "$checksums"

echo
echo "Draft release $tag created. Install the DMG once to smoke-test, then publish:"
echo "  gh release edit $tag --repo $github_repository --draft=false"
