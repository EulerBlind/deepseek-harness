# Local development loop for the DeepSeek Harness source tree.
#
# One command: update source from origin/master, build the workspace, and
# install the freshly built artifacts into the locally installed dsh bundle
# (the global `@deepseek-ai/dsh` package that the multica profile loads).
#
#   make            # same as: make all   (update -> build -> install)
#   make update     # fetch origin/master and rebase the current branch
#   make build      # pnpm install + build:lib (+ rebuild runtime plugin dist)
#   make install    # copy built artifacts into the local dsh bundle
#   make backup     # tarball the current installed bundle under /tmp
#   make test       # targeted vitest suites for the changed packages
#   make check      # show the effective paths this Makefile operates on
#
# Scope note: `make install` targets the launcher bundle only. The multica
# runtime (dsh-multica-runtime) resolves @deepseek-ai/dsh-* from its OWN
# pnpm store pinned to 0.1.0-rc.6 + patchedDependencies; that tree is
# pnpm-managed and must not be partially overwritten with rc.7 libs (a
# mixed-version runtime fails to boot). To point the runtime at harness
# builds, upgrade its dependency versions and run `pnpm install` there.
#
# Environment overrides:
#   REPO              source tree root          (default: this directory)
#   DSH_BUNDLE        dsh package install dir   (see `make check`)
#   RUNTIME_REPO      multica runtime plugin    (see `make check`)
#   INSTALL_CONFIG    set to 1 to also copy apps/cli/config into the bundle

SHELL := /bin/bash
.DEFAULT_GOAL := all

REPO        ?= $(realpath .)
NVM         ?= $(HOME)/.nvm/versions/node/v24.13.0
DSH_BUNDLE  ?= $(NVM)/lib/node_modules/@deepseek-ai/dsh
RUNTIME_REPO ?= $(HOME)/projects/dsh-multica-runtime

TIMESTAMP  := $(shell date +%Y%m%d-%H%M%S)
BACKUP     := /tmp/dsh-bundle-backup-$(TIMESTAMP).tar.gz

ifeq ($(INSTALL_CONFIG),1)
INSTALL_CONFIG_FLAG := --include-config
else
INSTALL_CONFIG_FLAG :=
endif

.PHONY: all update build install backup restore check test

all: update build install
	@echo "==> done: source updated, built, installed into $(DSH_BUNDLE)"

update:
	@echo "==> [update] fetching origin/master"
	cd $(REPO) && git fetch origin
	@echo "==> [update] rebasing current branch onto origin/master (local commits preserved)"
	cd $(REPO) && git rebase origin/master
	@echo "==> [update] current head: $$(cd $(REPO) && git log --oneline -1)"

build:
	@echo "==> [build] pnpm install + build:lib"
	cd $(REPO) && (pnpm install --frozen-lockfile || pnpm install)
	cd $(REPO) && pnpm run build:lib
	@echo "==> [build] rebuilding runtime plugin dist"
	cd $(RUNTIME_REPO) && (pnpm install --frozen-lockfile || pnpm install) && pnpm run build
	@echo "==> [build] done"

install:
	@echo "==> [install] backing up current bundle -> $(BACKUP)"
	mkdir -p "$(dir $(BACKUP))"
	tar czf $(BACKUP) -C $(dir $(DSH_BUNDLE)) $(notdir $(DSH_BUNDLE))
	@echo "==> [install] installing built packages into $(DSH_BUNDLE)"
	REPO=$(REPO) DSH_BUNDLE=$(DSH_BUNDLE) RUNTIME_REPO=$(RUNTIME_REPO) \
	  scripts/install-local-dsh.sh $(INSTALL_CONFIG_FLAG)
	@echo "==> [install] done (backup: $(BACKUP))"

backup:
	@echo "==> backing up current bundle -> $(BACKUP)"
	tar czf $(BACKUP) -C $(dir $(DSH_BUNDLE)) $(notdir $(DSH_BUNDLE))
	@echo "backup written: $(BACKUP)"

restore:
	@echo "usage: tar xzf <backup> -C $(dir $(DSH_BUNDLE))"
	@echo "       then restart dsh (new task/session) to pick up the restored bundle"

check:
	@echo "REPO        = $(REPO)"
	@echo "DSH_BUNDLE  = $(DSH_BUNDLE)"
	@echo "  lib dir   = $(DSH_BUNDLE)/lib"
	@echo "  packages  = $(DSH_BUNDLE)/node_modules/@deepseek-ai"
	@echo "RUNTIME_REPO= $(RUNTIME_REPO)"
	@echo "BACKUP      = $(BACKUP)"

test:
	cd $(REPO) && npx vitest run \
	  packages/core/tools/tests/tools.spec.ts \
	  packages/mcp/mcp-client/tests/mcp-client.spec.ts