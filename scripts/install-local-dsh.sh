#!/usr/bin/env bash
# Install freshly built workspace artifacts into the locally installed dsh
# bundle (the global @deepseek-ai/dsh package that the multica profile loads).
#
# Usage from the repo root (normally invoked by `make install`):
#   REPO=<repo> DSH_BUNDLE=<dsh pkg dir> RUNTIME_REPO=<runtime repo> \
#     scripts/install-local-dsh.sh [--include-config]
#
# What it does (complete snapshot, not a partial patch):
#   1. Installs EVERY built @deepseek-ai workspace package into the bundle's
#      node_modules/@deepseek-ai: lib/ + dist/ + native bin/ + normalized
#      package.json + cordis.patch.yml + README/LICENSE/prebuilds. Unlike the
#      old flow, this does NOT require a package to already exist in the bundle
#      — an upstream rebase routinely adds/renames packages, and a partial
#      install is the common cause of boot failures after an update.
#   2. Removes stale @deepseek-ai bundle packages that no longer exist in the
#      workspace (keeps the bundle package set mirroring the source tree).
#   3. Copies the CLI launcher artifacts (apps/cli/lib/*.js) into the bundle
#      root, and (only with --include-config) apps/cli/config too.
#   4. Copies the web frontend dist (apps/web/dist) into dsh-web-frontend.
#   5. Rebuilds the multica runtime plugin dist (already linked by the profile).
#   6. Sanity checks: the required-key normalization must be present in the
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

# --- 1 + 2: complete package set install + stale removal (python core) ---
export REPO DSH_BUNDLE
python3 - <<'PY'
import json, os, shutil, glob

REPO = os.environ['REPO']
DSH_BUNDLE = os.environ['DSH_BUNDLE']
PKG_DIR = os.path.join(DSH_BUNDLE, 'node_modules', '@deepseek-ai')
os.makedirs(PKG_DIR, exist_ok=True)

def normalize_pkg(d):
    own = d.get('version', '0.0.0')
    for field in ('dependencies', 'peerDependencies', 'optionalDependencies'):
        for k in list(d.get(field, {})):
            v = d[field][k]
            if v.startswith('workspace:'):
                spec = v[len('workspace:'):]
                d[field][k] = spec if spec not in ('*', '^', '~') else f'^{own}'
    return d

def discover_workspace():
    """Map @deepseek-ai short name -> source dir across the whole tree."""
    pkgs = {}
    patterns = [
        os.path.join(REPO, 'packages', '*', '*', 'package.json'),
        os.path.join(REPO, 'vendor', '*', 'package.json'),
        os.path.join(REPO, 'apps', '*', 'package.json'),
        os.path.join(REPO, 'native', 'system', 'packages', '*', 'package.json'),
    ]
    for pat in patterns:
        for p in glob.glob(pat):
            try:
                d = json.load(open(p))
            except Exception:
                continue
            name = d.get('name', '')
            if name.startswith('@deepseek-ai/'):
                pkgs[name.split('/', 1)[1]] = os.path.dirname(p)
    return pkgs

def has_built(src):
    """A package counts as built when it emitted any runtime artifact."""
    lib = os.path.join(src, 'lib')
    if os.path.isdir(lib):
        try:
            if any(f.endswith(('.js', '.cjs', '.mjs')) for f in os.listdir(lib)):
                return True
        except OSError:
            pass
    if os.path.isdir(os.path.join(src, 'dist')):
        return True
    if os.path.isdir(os.path.join(src, 'bin')):
        return True
    return False

def install(src, short):
    dst = os.path.join(PKG_DIR, short)
    os.makedirs(dst, exist_ok=True)
    for sub in ('lib', 'dist', 'bin'):
        s = os.path.join(src, sub)
        if not os.path.isdir(s):
            continue
        d = os.path.join(dst, sub)
        if os.path.isdir(d):
            shutil.rmtree(d)
        shutil.copytree(s, d)
    try:
        d = normalize_pkg(json.load(open(os.path.join(src, 'package.json'))))
    except Exception:
        return
    with open(os.path.join(dst, 'package.json'), 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write('\n')
    for f in ('README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE', 'cordis.patch.yml', 'prebuilds.json'):
        if os.path.isfile(os.path.join(src, f)):
            shutil.copy(os.path.join(src, f), os.path.join(dst, f))
    print(f'  installed {short}')

workspace = discover_workspace()
installed = 0
not_built = []
for short, src in sorted(workspace.items()):
    if not has_built(src):
        not_built.append(short)
        continue
    install(src, short)
    installed += 1

# Remove bundle packages no longer present in the workspace (renamed/removed
# upstream). Packages present in the workspace but not built are kept with a
# warning so a failed single package never silently nukes a needed bundle.
removed = 0
for short in sorted(os.listdir(PKG_DIR)):
    if short not in workspace:
        shutil.rmtree(os.path.join(PKG_DIR, short))
        removed += 1
        print(f'  removed stale {short}')

print(f'  installed {installed} packages into {PKG_DIR}')
if removed:
    print(f'  removed {removed} stale bundle package(s)')
if not_built:
    print(f'  warning: skipped {len(not_built)} package(s) without built output: {", ".join(sorted(not_built))}')
PY

# --- 3: CLI launcher artifacts (lib/*.js) into the bundle root ---
mkdir -p "$DSH_BUNDLE/lib"
for f in "$REPO"/apps/cli/lib/*.js; do
  [ -f "$f" ] && cp "$f" "$DSH_BUNDLE/lib/$(basename "$f")" && echo "  installed launcher lib/$(basename "$f")"
done
if [ "$INCLUDE_CONFIG" = "1" ]; then
  rm -rf "$DSH_BUNDLE/config"
  cp -a "$REPO/apps/cli/config" "$DSH_BUNDLE/config"
  echo "  installed launcher config/"
fi

# --- 4: web frontend dist (vite build:web output) into dsh-web-frontend ---
if [ -d "$REPO/apps/web/dist" ] && [ -f "$REPO/apps/web/dist/index.html" ]; then
  rm -rf "$PKG_DIR/dsh-web-frontend/dist"
  cp -a "$REPO/apps/web/dist" "$PKG_DIR/dsh-web-frontend/dist"
  echo "  installed web frontend dist -> dsh-web-frontend/dist"
else
  echo "  warning: apps/web/dist missing (did you run build:web?)"
fi

# --- 4b: sync daemon-managed profile hook packages from the bundle ---
# The multica profile pins rc.6 copies of dsh-hooks-claude-code / dsh-hook-protocol
# that iterate the removed `session.events` getter and break against the newer
# bundle session API ("agent.session.events is not iterable"). Overwrite them
# with the bundle's built versions on every install so the profile always
# matches the bundle it loads against.
DSH_PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/multica}"
if [ -d "$DSH_PROFILE/node_modules/@deepseek-ai" ]; then
  for h in dsh-hooks-claude-code dsh-hook-protocol; do
    if [ -d "$PKG_DIR/$h/lib" ] && [ -d "$DSH_PROFILE/node_modules/@deepseek-ai/$h" ]; then
      rm -rf "$DSH_PROFILE/node_modules/@deepseek-ai/$h/lib"
      cp -a "$PKG_DIR/$h/lib" "$DSH_PROFILE/node_modules/@deepseek-ai/$h/lib"
      cp "$PKG_DIR/$h/package.json" "$DSH_PROFILE/node_modules/@deepseek-ai/$h/package.json"
      echo "  synced profile hook $h -> bundle version"
    fi
  done
else
  echo "  note: no dsh profile at $DSH_PROFILE (skipping hook sync)"
fi

# --- 5: runtime plugin dist (profile links directly to the runtime repo) ---
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

# --- 6: sanity checks ---
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
echo "==> install complete"
