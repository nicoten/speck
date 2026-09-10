#!/usr/bin/env bash
# Build and package a Speck release.
#
# Signing keys are taken only from ~/.speck, never from the environment: a
# TAURI_SIGNING_* variable exported in a shell profile would otherwise sign
# Speck with another project's key, and the app would then refuse its own
# updates. Anything inherited is cleared first.
#
# The DMG is built with hdiutil rather than Tauri's bundler, which drives Finder
# over AppleScript purely to lay out the window and fails outright when Finder
# is busy.
set -euo pipefail

KEYS="${SPECK_KEYS:-$HOME/.speck}"
KEY="$KEYS/updater.key"
PASS_FILE="$KEYS/updater.pass"

for f in "$KEY" "$PASS_FILE"; do
  [ -f "$f" ] || { echo "missing $f — see README, Releasing" >&2; exit 1; }
done

cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION=$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
PKG_VERSION=$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')

if [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "version mismatch: tauri.conf.json $VERSION vs package.json $PKG_VERSION" >&2
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
  arm64) TARGET=darwin-aarch64 ;;
  x86_64) TARGET=darwin-x86_64 ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

echo "Building Speck $VERSION for $TARGET"

BUNDLE="$ROOT/src-tauri/target/release/bundle"
rm -f "$BUNDLE"/macos/rw.*.dmg "$BUNDLE"/dmg/rw.*.dmg 2>/dev/null || true

env -u TAURI_SIGNING_PRIVATE_KEY \
    -u TAURI_SIGNING_PRIVATE_KEY_PATH \
    -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PASS_FILE")" \
    pnpm tauri build --bundles app

APP="$BUNDLE/macos/Speck.app"
TARBALL="$BUNDLE/macos/Speck.app.tar.gz"
SIG="$TARBALL.sig"

for f in "$APP" "$TARBALL" "$SIG"; do
  [ -e "$f" ] || { echo "expected artifact missing: $f" >&2; exit 1; }
done

# A DMG for people to download. No Finder involved, so no pretty layout — just
# the app beside an Applications link to drag it into.
OUT="$ROOT/dist-release"
rm -rf "$OUT" && mkdir -p "$OUT/stage"
cp -R "$APP" "$OUT/stage/"
ln -s /Applications "$OUT/stage/Applications"
DMG="$OUT/Speck_${VERSION}_${ARCH}.dmg"
hdiutil create -quiet -volname "Speck $VERSION" -srcfolder "$OUT/stage" \
  -ov -format UDZO "$DMG"
rm -rf "$OUT/stage"

cp "$TARBALL" "$SIG" "$OUT/"

# The manifest the app reads from releases/latest/download/latest.json. The URL
# points at this version's asset, so an older manifest never resolves to a
# newer binary.
python3 - "$VERSION" "$TARGET" "$SIG" "$OUT/latest.json" <<'PY'
import datetime, json, sys
version, target, sig_path, out = sys.argv[1:5]
with open(sig_path) as f:
    signature = f.read().strip()
manifest = {
    "version": version,
    "notes": f"Speck {version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "platforms": {
        target: {
            "signature": signature,
            "url": "https://github.com/nicoten/speck/releases/download/"
                   f"v{version}/Speck.app.tar.gz",
        }
    },
}
with open(out, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

echo
echo "Release artifacts in dist-release/:"
ls -1 "$OUT"
