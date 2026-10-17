#!/bin/bash
#
# Package (and optionally sign) the Firefox extension into a versioned .xpi.
#
# Usage:
#   ./scripts/package-extension.sh            # build an unsigned .xpi
#   ./scripts/package-extension.sh --sign     # build + sign via AMO (needs API creds)
#
# Signing uses Mozilla's web-ext tool and the AMO API. It requires:
#   - Node.js + web-ext            (npm install -g web-ext)
#   - AMO_JWT_ISSUER / AMO_JWT_SECRET  (from https://addons.mozilla.org/developers/addon/api/key/)
#
# Building your own signed copy (e.g. from a fork): the default extension ID
# belongs to the upstream AMO listing, and AMO only signs an ID for the account
# that owns it. Set CCB_EXTENSION_ID to an ID of your own (any email-style
# string, e.g. claudecodebrowser@yourname.github.io) and CCB_REPO_SLUG to your
# fork; both are stamped into a build copy of the manifest. Then pass the same
# CCB_EXTENSION_ID to scripts/install.sh so the native host accepts it.
#
# A signed .xpi can be installed permanently and — if you set an update_url
# (see below) — auto-updates. An unsigned .xpi only loads as a temporary
# add-on via about:debugging, or in Developer/Nightly with
# xpinstall.signatures.required=false.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$SCRIPT_DIR/extension"
DIST="$SCRIPT_DIR/dist"
SIGN=0
[ "$1" = "--sign" ] && SIGN=1

VERSION=$(python3 -c "import json; print(json.load(open('$SRC/manifest.json'))['version'])")
EXT_ID=$(python3 -c "import json; print(json.load(open('$SRC/manifest.json'))['browser_specific_settings']['gecko']['id'])")
EXT_ID="${CCB_EXTENSION_ID:-$EXT_ID}"
XPI="$DIST/claudecodebrowser-${VERSION}.xpi"

# Where release assets live. The manifest's update_url points at
# releases/latest/download/updates.json (a stable URL), and each release's
# .xpi is downloaded from its versioned tag.
REPO_SLUG="${CCB_REPO_SLUG:-nanogenomic/ClaudeCodeBrowser}"
XPI_URL="https://github.com/${REPO_SLUG}/releases/download/v${VERSION}/claudecodebrowser-${VERSION}.xpi"

mkdir -p "$DIST"

# Package from a staged copy so the ID / update_url can be customised without
# touching extension/manifest.json.
BUILD_SRC="$DIST/build-src"
rm -rf "$BUILD_SRC"
mkdir -p "$BUILD_SRC"
( cd "$SRC" && tar cf - --exclude '.DS_Store' . ) | ( cd "$BUILD_SRC" && tar xf - )
python3 - "$BUILD_SRC/manifest.json" "$EXT_ID" "https://github.com/${REPO_SLUG}/releases/latest/download/updates.json" << 'PYEOF2'
import json, sys
path, ext_id, update_url = sys.argv[1:4]
manifest = json.load(open(path))
gecko = manifest['browser_specific_settings']['gecko']
gecko['id'] = ext_id
gecko['update_url'] = update_url
json.dump(manifest, open(path, 'w'), indent=2)
PYEOF2
SRC="$BUILD_SRC"

echo "Packaging ClaudeCodeBrowser extension v${VERSION} (${EXT_ID})"

# Emit the Firefox update manifest so installed copies can auto-update.
cat > "$DIST/updates.json" << EOF
{
  "addons": {
    "${EXT_ID}": {
      "updates": [
        { "version": "${VERSION}", "update_link": "${XPI_URL}" }
      ]
    }
  }
}
EOF
echo "Wrote update manifest: $DIST/updates.json"

if [ "$SIGN" = "1" ]; then
    if command -v web-ext &> /dev/null; then
        WEB_EXT=(web-ext)
    elif command -v npx &> /dev/null; then
        WEB_EXT=(npx --yes web-ext@8.3.0)
    else
        echo "Error: web-ext not found. Install Node.js, then: npm install -g web-ext" >&2
        exit 1
    fi
    if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
        echo "Error: set AMO_JWT_ISSUER and AMO_JWT_SECRET (from the AMO API key page)." >&2
        exit 1
    fi
    echo "Signing via AMO (channel: unlisted, self-distribution)..."
    # --channel=unlisted signs without a public AMO listing, for self-hosting.
    # Use --channel=listed to submit to the public AMO catalog instead.
    "${WEB_EXT[@]}" sign \
        --source-dir "$SRC" \
        --artifacts-dir "$DIST" \
        --channel=unlisted \
        --api-key "$AMO_JWT_ISSUER" \
        --api-secret "$AMO_JWT_SECRET"
    # web-ext names the signed file with underscores; normalize to the name
    # the update manifest expects so update_link resolves.
    SIGNED=$(ls -t "$DIST"/*.xpi 2>/dev/null | head -n1)
    if [ -z "$SIGNED" ]; then
        echo "Error: signing produced no .xpi (see web-ext output above)." >&2
        exit 1
    fi
    if [ -n "$SIGNED" ] && [ "$SIGNED" != "$XPI" ]; then
        cp "$SIGNED" "$XPI"
    fi
    echo "Signed .xpi ready: $XPI"
    echo ""
    echo "To publish this as an auto-updating release:"
    echo "  1. Create GitHub release tag v${VERSION}"
    echo "  2. Upload BOTH assets: $XPI  and  $DIST/updates.json"
    echo "  Installed copies then update within ~24h (or via about:addons > Check for Updates)."
else
    # Plain zip -> .xpi. The archive root must be the manifest, not a folder.
    ( cd "$SRC" && zip -r -FS "$XPI" . -x '*.DS_Store' > /dev/null )
    echo "Unsigned package: $XPI"
    echo ""
    echo "To load it: Firefox -> about:debugging -> This Firefox ->"
    echo "  Load Temporary Add-on -> select the .xpi (or extension/manifest.json)."
    echo "For a permanently installable, auto-updating build, re-run with --sign."
fi
