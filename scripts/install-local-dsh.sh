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
    # Directory assets referenced by the package manifest rather than emitted
    # by the build: `dsh-web-app` lists `presets/*.patch.yml` in
    # `dsh.bundle.patch` (the declarative agent presets, Creator among them),
    # so a lib-only install leaves the profile pointing at missing patch files
    # and the Creator preset never activates.
    for sub in ('presets',):
        s = os.path.join(src, sub)
        if not os.path.isdir(s):
            continue
        d = os.path.join(dst, sub)
        if os.path.isdir(d):
            shutil.rmtree(d)
        shutil.copytree(s, d)
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

# --- 2b: third-party dependencies of the installed packages ---
# Step 1 copies build output only, so a package whose `lib/` imports a plain
# npm dependency (execa, @modelcontextprotocol/client, typescript, ...) would
# resolve it from nowhere and fail to import at boot — the web profile reports
# those as "failed to import" and the Creator preset stays broken because
# `dsh-plugin-manager` cannot load. Mirror the workspace's own resolved
# third-party tree into the bundle so every copied lib has its dependencies.
echo "==> installing third-party dependencies into the bundle"
python3 - <<'PY'
import json, os, re, shutil

REPO = os.environ['REPO']
DSH_BUNDLE = os.environ['DSH_BUNDLE']
BUNDLE_NM = os.path.join(DSH_BUNDLE, 'node_modules')
# The workspace siblings installed by the previous step; a `@deepseek-ai/`
# name in this set is satisfied inside the bundle and must not be re-resolved
# as a third-party package.
installed_shorts = set(os.listdir(os.path.join(BUNDLE_NM, '@deepseek-ai'))
                       if os.path.isdir(os.path.join(BUNDLE_NM, '@deepseek-ai')) else [])

def package_roots():
    import glob
    roots = []
    for pat in ('packages/*/*', 'vendor/*', 'apps/*'):
        roots.extend(glob.glob(os.path.join(REPO, pat)))
    return roots

def third_party_names():
    names = {}
    for root in package_roots():
        manifest = os.path.join(root, 'package.json')
        if not os.path.isfile(manifest):
            continue
        try:
            data = json.load(open(manifest))
        except Exception:
            continue
        for field in ('dependencies', 'peerDependencies', 'optionalDependencies'):
            for name, spec in (data.get(field) or {}).items():
                # A `@deepseek-ai/` dependency is an in-repo workspace sibling
                # only when that name is built and installed above. External
                # scoped packages that merely share the namespace — notably
                # `@deepseek-ai/libreoffice-kit`, which comes from npm and is
                # required by dsh-office-to-pdf, dsh-skill-office and
                # dsh-desktop-host — must join the closure too, or those libs
                # fail to import at boot with ERR_MODULE_NOT_FOUND.
                if name.startswith('@deepseek-ai/') and name.split('/', 1)[1] in installed_shorts:
                    continue
                # Optional peers are frequently absent by design.
                if field == 'optionalDependencies':
                    continue
                if isinstance(spec, str) and spec.startswith(('link:', 'workspace:')):
                    continue
                names.setdefault(name, spec)
    return names

def read_version(package_dir):
    try:
        return json.load(open(os.path.join(package_dir, 'package.json'))).get('version')
    except Exception:
        return None

def satisfies(version, spec):
    """Conservative semver-range check for the caret/tilde/exact ranges pnpm uses."""
    if version is None or not isinstance(spec, str):
        return True
    spec = spec.strip()
    if spec.startswith(('link:', 'workspace:', 'file:', 'git', 'http')):
        return True
    match = re.match(r'^[\^~]?(\d+)\.(\d+)\.(\d+)', spec)
    if match is None:
        return True
    want = tuple(int(part) for part in match.groups())
    try:
        have = tuple(int(part) for part in re.match(r'^(\d+)\.(\d+)\.(\d+)', version).groups())
    except Exception:
        return True
    if spec.startswith('^'):
        # A caret range stays inside the same major (0.x stays inside 0.minor).
        if want[0] == 0:
            return have[0] == 0 and have[1] == want[1] and have >= want
        return have[0] == want[0] and have >= want
    if spec.startswith('~'):
        return have[0] == want[0] and have[1] == want[1] and have >= want
    return have == want

def resolve_from(source_root, name, spec=None):
    """Resolve one package name through pnpm's symlink layout, if present."""
    direct = os.path.join(source_root, 'node_modules', name)
    if os.path.exists(direct) and satisfies(read_version(direct), spec):
        return os.path.realpath(direct)
    # Fall back to the pnpm store entry that owns this name, preferring the one
    # whose version satisfies the requesting package's range: a flat copy into
    # the bundle root means the first version copied wins, so choosing the wrong
    # one silently breaks a sibling that needed another major.
    store = os.path.join(REPO, 'node_modules', '.pnpm')
    if not os.path.isdir(store):
        return None
    prefix = name.replace('/', '+') + '@'
    candidates = []
    for entry in sorted(os.listdir(store)):
        if entry.startswith(prefix):
            candidate = os.path.join(store, entry, 'node_modules', name)
            if os.path.exists(candidate):
                candidates.append(os.path.realpath(candidate))
    for candidate in candidates:
        if satisfies(read_version(candidate), spec):
            return candidate
    return None

def nested_dependency_names(manifest_path):
    """Runtime dependencies of a third-party package, skipping optionals."""
    try:
        data = json.load(open(manifest_path))
    except Exception:
        return []
    names = {}
    for field in ('dependencies', 'peerDependencies'):
        for name, spec in (data.get(field) or {}).items():
            if name.startswith('@deepseek-ai/'):
                continue
            if isinstance(spec, str) and spec.startswith(('link:', 'workspace:')):
                continue
            names.setdefault(name, spec)
    return names

def resolve_third_party(name, spec=None, importer=None):
    """Resolve a third-party name from an importer dir, then the workspace roots."""
    searches = []
    if importer is not None:
        searches.append(importer)
    searches.extend(package_roots())
    searches.append(REPO)
    for root in searches:
        found = resolve_from(root, name, spec)
        if found is not None and os.path.isdir(found):
            return found
    return None

# Breadth-first closure: a copied lib resolves its own dependencies from the
# bundle root, so every transitive third-party name must land there too.
#
# Flat placement means one version per name, so a name reachable through an
# unsatisfied range (pulled in transitively by another package) still has to
# upgrade the installed copy: skipping satisfied names outright would freeze
# whichever version happened to arrive first.
roots = package_roots()
pending = sorted(third_party_names().items())
seen = set()
copied = 0
upgraded = 0
replaced = []
skipped = []
while pending:
    name, spec = pending.pop(0)
    wanted = resolve_third_party(name, spec)
    if wanted is None:
        skipped.append(f'{name}@{spec}')
        continue
    dest = os.path.join(BUNDLE_NM, name)
    installed_ok = os.path.exists(dest) and satisfies(read_version(dest), spec)
    if name in seen and installed_ok:
        continue
    seen.add(name)
    # A dangling symlink still occupies the path; treat only a real target as
    # already satisfied so an existing link is replaced rather than crashing.
    if os.path.islink(dest) and not os.path.exists(dest):
        os.remove(dest)
    if os.path.exists(dest):
        if installed_ok:
            pending.extend(sorted(nested_dependency_names(
                os.path.join(dest, 'package.json')).items()))
            continue
        replaced.append(f'{name}: {read_version(dest)} -> {read_version(wanted)} (needed {spec})')
        shutil.rmtree(dest)
        upgraded += 1
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copytree(wanted, dest, symlinks=True, dirs_exist_ok=True)
    copied += 1
    pending.extend(sorted(nested_dependency_names(os.path.join(wanted, 'package.json')).items()))

print(f'  installed {copied} third-party dependency tree(s) into {BUNDLE_NM}')
if upgraded:
    print(f'  corrected {upgraded} conflicting version(s): {"; ".join(replaced)}')
if skipped:
    print(f'  note: {len(skipped)} dependency name(s) not present in the workspace store: {", ".join(skipped)}')
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
