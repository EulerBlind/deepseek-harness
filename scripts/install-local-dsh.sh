#!/usr/bin/env bash
# Install freshly built workspace artifacts into the locally installed dsh
# bundle (the global @deepseek-ai/dsh package that the multica profile loads).
#
# Usage from the repo root (normally invoked by `make install`):
#   REPO=<repo> DSH_BUNDLE=<dsh pkg dir> RUNTIME_REPO=<runtime repo> \
#     scripts/install-local-dsh.sh [--include-config]
#
# What it does:
#   1. Copies lib/ + package.json + README/LICENSE for every built workspace
#      package whose name matches a package already present in the bundle's
#      node_modules/@deepseek-ai (never adds new packages).
#   2. Copies the CLI launcher artifacts (apps/cli/lib/*.js) into the bundle
#      root, and (only with --include-config) apps/cli/config too.
#   3. Rebuilds the multica runtime plugin dist (already linked by the profile).
#   4. Sanity checks: the required-key normalization must be present in the
#      installed dsh-tools and dsh-mcp-client.

set -euo pipefail

REPO="${REPO:?REPO is required}"
DSH_BUNDLE="${DSH_BUNDLE:?DSH_BUNDLE is required}"
RUNTIME_REPO="${RUNTIME_REPO:-$HOME/projects/dsh-multica-runtime}"
INCLUDE_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --include-config) INCLUDE_CONFIG=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PKG_DIR="$DSH_BUNDLE/node_modules/@deepseek-ai"
WORKSPACE_PKGS=$(cd "$REPO" && find packages vendor -maxdepth 3 -name package.json -not -path '*/node_modules/*' -not -path '*/tests/*' 2>/dev/null || true)

installed=0
for pkg in $WORKSPACE_PKGS; do
  dir=$(dirname "$pkg")
  name=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['name'])" "$pkg" 2>/dev/null || true)
  [ -z "$name" ] && continue
  case "$name" in
    @deepseek-ai/*) ;;
    *) continue ;;
  esac
  # bundle dir name = package short name (e.g. @deepseek-ai/dsh-tools -> dsh-tools)
  base=${name#@deepseek-ai/}
  # bundle must already carry this package (never introduce new ones)
  [ -d "$PKG_DIR/$base" ] || continue
  # only install packages that actually built a lib/index.js
  [ -f "$dir/lib/index.js" ] || continue
  rm -rf "$PKG_DIR/$base/lib"
  cp -a "$dir/lib" "$PKG_DIR/$base/lib"
  # copy manifest but normalize workspace: specifiers to ^<own-version>
  # (the way pnpm rewrites them at publish time) — a standalone bundle never
  # sees a bare "workspace:" range.
  python3 - "$dir/package.json" "$PKG_DIR/$base/package.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
own = d.get('version', '0.0.0')
for field in ('dependencies', 'peerDependencies', 'optionalDependencies'):
    for key in list(d.get(field, {})):
        val = d[field][key]
        if val.startswith('workspace:'):
            spec = val[len('workspace:'):]
            d[field][key] = spec if spec not in ('*', '^', '~') else f'^{own}'
json.dump(d, open(dst, 'w'), indent=2, ensure_ascii=False)
open(dst, 'a').write('\n')
PY
  for f in README.md README.zh.md README.i18n.yaml LICENSE; do
    [ -f "$dir/$f" ] && cp "$dir/$f" "$PKG_DIR/$base/$f" || true
  done
  echo "  installed $name -> $PKG_DIR/$base"
  installed=$((installed + 1))
done

# CLI launcher artifacts (lib/*.js) into the bundle root
mkdir -p "$DSH_BUNDLE/lib"
for f in "$REPO"/apps/cli/lib/*.js; do
  [ -f "$f" ] && cp "$f" "$DSH_BUNDLE/lib/$(basename "$f")" && echo "  installed launcher lib/$(basename "$f")"
done
if [ "$INCLUDE_CONFIG" = "1" ]; then
  rm -rf "$DSH_BUNDLE/config"
  cp -a "$REPO/apps/cli/config" "$DSH_BUNDLE/config"
  echo "  installed launcher config/"
fi

# Runtime plugin dist (profile links directly to the runtime repo).
if [ -d "$RUNTIME_REPO" ]; then
  (cd "$RUNTIME_REPO" && pnpm run build >/dev/null) && echo "  rebuilt runtime plugin dist ($RUNTIME_REPO)"
else
  echo "  warning: RUNTIME_REPO not found: $RUNTIME_REPO"
fi

# The multica runtime resolves @deepseek-ai/dsh-* from ITS OWN pnpm store
# (dsh-multica-runtime/node_modules/.pnpm), pinned to 0.1.0-rc.6 with a
# patchedDependencies entry for dsh-mcp-client. That tree is pnpm-managed:
# overwriting a subset of its libs with rc.7-built harness output creates a
# mixed-version runtime (rc.7 lib + rc.6 siblings) that fails to boot (e.g.
# rc.7 dsh-mcp-client imports isImageAdmissionError from rc.6
# dsh-attachment). Do NOT touch it here. To point the runtime at harness
# builds, upgrade its dependency versions (rc.7) and run
# `cd $RUNTIME_REPO && pnpm install` so pnpm builds a consistent tree.
if [ -d "$RUNTIME_REPO" ]; then
  echo "  note: runtime pnpm store left untouched (pnpm-managed; see scripts/install-local-dsh.sh)"
fi

# Sanity checks.
echo "==> sanity checks"
python3 - "$PKG_DIR/dsh-tools/lib/index.js" "$PKG_DIR/dsh-mcp-client/lib/index.js" <<'PY'
import sys
ok = True
for path in sys.argv[1:]:
    if 'required' not in open(path, encoding='utf-8').read():
        ok = False
        print(f"  MISSING required-normalization in {path}")
print("  dsh-tools/dsh-mcp-client carry the required-key normalization" if ok else "  FAILED sanity check")
if not ok:
    sys.exit(1)
PY
echo "installed $installed packages into $DSH_BUNDLE"