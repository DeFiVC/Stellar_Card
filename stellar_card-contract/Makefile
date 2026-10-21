.PHONY: build optimize test contract-integration-test integration-test integration-test-lint wasm-size

# Issue #392 (Part 1): build for wasm32v1-none everywhere — the target
# soroban-sdk 22 recommends and the one CI installs. wasm32-unknown-unknown
# on Rust >= 1.82 emits reference-types/multi-value, which Soroban rejects,
# and `make test` / the integration script already used wasm32v1-none, so
# `make build` was measuring a different binary from the one tested.
WASM_TARGET := wasm32v1-none
WASM_PATH := target/$(WASM_TARGET)/release/stellar_card_receiver.wasm
# What deploy.sh / upgrade.sh upload: the rustc output after a binaryen pass.
OPTIMIZED_WASM_PATH := target/$(WASM_TARGET)/release/stellar_card_receiver.optimized.wasm

# Size budgets. Soroban's network-enforced ceiling is 64KiB (65536 bytes);
# these sit a few KiB above the measured sizes so ordinary drift passes but
# a real regression fails. Measured at the time of setting (rustc 1.94,
# soroban-sdk 22.0.11): 46,083 bytes raw, 36,603 bytes optimized. The raw
# budget is also asserted by `test_wasm_within_size_budget` in src/lib.rs —
# keep the two in sync.
WASM_SIZE_BUDGET_BYTES := 86016
OPTIMIZED_WASM_SIZE_BUDGET_BYTES := 65536

# [profile.release] in Cargo.toml already sets opt-level=z, lto,
# codegen-units=1, panic=abort and strips symbols. `optimize` adds a
# binaryen pass on top (dead-code elimination and instruction-level size
# rewrites rustc can't do), which takes the binary down by ~20%.
build:
	cargo build --target $(WASM_TARGET) --release
	@$(MAKE) --no-print-directory optimize
	@$(MAKE) --no-print-directory wasm-size

# Prefers the Stellar CLI's built-in optimizer (already a dependency for
# deploying), falls back to binaryen's wasm-opt, and otherwise skips with a
# warning rather than failing the build. The previous output is removed
# first so a skipped pass can never leave a stale optimized binary behind.
optimize:
	@rm -f "$(OPTIMIZED_WASM_PATH)"
	@if command -v stellar >/dev/null 2>&1 && \
		stellar contract optimize --wasm "$(WASM_PATH)" --wasm-out "$(OPTIMIZED_WASM_PATH)" >/dev/null 2>&1; then \
		echo "optimize: stellar contract optimize -> $(OPTIMIZED_WASM_PATH)"; \
	elif command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt -Oz --strip-debug --strip-producers -c "$(WASM_PATH)" -o "$(OPTIMIZED_WASM_PATH)"; \
		echo "optimize: wasm-opt -Oz -> $(OPTIMIZED_WASM_PATH)"; \
	else \
		echo "optimize: neither 'stellar contract optimize' nor wasm-opt is available — skipping. Install the Stellar CLI or binaryen for a smaller binary." >&2; \
	fi

# Issue #412 (Part 3) / #392 (Part 1): report the built WASM's size and fail
# if it regresses past its budget, so a size regression is caught in CI at
# build time instead of after deployment starts costing more per
# invocation or approaches the network's 64KiB hard limit. The optimized
# binary is checked whenever `optimize` produced one.
wasm-size:
	@./scripts/check_wasm_size.sh "$(WASM_PATH)" "$(WASM_SIZE_BUDGET_BYTES)"
	@if [ -f "$(OPTIMIZED_WASM_PATH)" ]; then \
		./scripts/check_wasm_size.sh "$(OPTIMIZED_WASM_PATH)" "$(OPTIMIZED_WASM_SIZE_BUDGET_BYTES)"; \
	fi

# The upgrade test imports the compiled contract WASM.
test:
	cargo build --target $(WASM_TARGET) --release
	cargo test

# Issue #400 (Part 2): in-process integration suite only (tests/integration.rs).
# Also runs as part of `make test`; this target is for quick iteration.
contract-integration-test:
	cargo test --test integration

# End-to-end suite against a local Quickstart network (needs Docker + Stellar CLI).
# Builds via `make build` unless SKIP_BUILD=1, and deploys the optimized WASM.
integration-test:
	./scripts/test_local_network.sh

# Issue #390 (Part 1): catch a broken script before it costs a Quickstart
# boot (~1-3 min) to find out. `bash -n` always runs; shellcheck runs when
# installed (it is on GitHub's ubuntu runners).
integration-test-lint:
	@for script in scripts/*.sh; do bash -n "$$script" || exit 1; done
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck --severity=warning scripts/*.sh; \
	else \
		echo "integration-test-lint: shellcheck not installed — ran bash -n only"; \
	fi
	@echo "integration-test-lint: scripts OK"
