#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null && pwd)"

require_notarized=0
case "${1:-}" in
  "") ;;
  --require-notarized) require_notarized=1 ;;
  *)
    echo "Usage: $0 [--require-notarized]" >&2
    exit 2
    ;;
esac

if [[ "$#" -gt 1 ]]; then
  echo "Usage: $0 [--require-notarized]" >&2
  exit 2
fi

target="${SESSION_BUILD_TARGET:-universal-apple-darwin}"
version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$repo_root/src-tauri/tauri.conf.json" | head -1)"
bundle_root="$repo_root/src-tauri/target/$target/release/bundle"
app="$bundle_root/macos/Session.app"
dmg="$bundle_root/dmg/Session_${version}_universal.dmg"
archive="$bundle_root/macos/Session.app.tar.gz"
signature="$archive.sig"
manifest="$bundle_root/macos/latest.json"

for file in "$app" "$dmg" "$archive" "$signature" "$manifest"; do
  if [[ ! -e "$file" ]]; then
    echo "Missing release artifact: $file" >&2
    exit 1
  fi
done

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")"
bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
if [[ "$bundle_id" != "dev.session.desktop" || "$bundle_version" != "$version" ]]; then
  echo "Unexpected app metadata: identifier=$bundle_id version=$bundle_version" >&2
  exit 1
fi

architectures="$(lipo -archs "$app/Contents/MacOS/session")"
if [[ " $architectures " != *" arm64 "* || " $architectures " != *" x86_64 "* ]]; then
  echo "Release executable is not universal: $architectures" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app"
codesign --verify --strict --verbose=2 "$dmg"
tar -tzf "$archive" | grep -Fx 'Session.app/Contents/MacOS/session' >/dev/null
[[ -s "$signature" ]]

python3 - "$manifest" "$version" <<'PY'
import json
import sys

path, expected_version = sys.argv[1:]
with open(path, encoding="utf-8") as file:
    manifest = json.load(file)

if manifest.get("version") != expected_version:
    raise SystemExit(f"latest.json version is {manifest.get('version')!r}, expected {expected_version!r}")

expected_url = f"https://github.com/aka-com/session/releases/download/v{expected_version}/Session.app.tar.gz"
platforms = manifest.get("platforms", {})
for platform in ("darwin-aarch64", "darwin-x86_64"):
    entry = platforms.get(platform, {})
    if entry.get("url") != expected_url or not entry.get("signature"):
        raise SystemExit(f"latest.json has an invalid {platform} entry")
PY

if [[ "$require_notarized" -eq 1 ]]; then
  xcrun stapler validate "$app"
  xcrun stapler validate "$dmg"
  spctl --assess --type execute --verbose=2 "$app"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
fi

echo "Verified Session $version release artifacts ($architectures)."
