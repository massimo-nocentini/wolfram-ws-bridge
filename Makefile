# make            build web/wxf.wasm
# make test       codec tests against the kernel, then the end-to-end tests (server must be running)

CLANG ?= clang
# any wasm-ld works; without one on PATH, use the rust-lld that ships with rustup toolchains
WASM_LD ?= $(shell command -v wasm-ld 2>/dev/null)
ifeq ($(strip $(WASM_LD)),)
WASM_LD := $(firstword $(wildcard $(HOME)/.rustup/toolchains/*/lib/rustlib/*/bin/rust-lld)) -flavor wasm
endif

WASM_CFLAGS = --target=wasm32 -O2 -ffreestanding -nostdlib -mbulk-memory -fvisibility=hidden \
              -std=c11 -Wall -Wextra -Werror

web/wxf.wasm: build/wasm/wxf.o build/wasm/wasm_api.o
	$(WASM_LD) --no-entry --strip-all --stack-first -z stack-size=65536 -o $@ $^

build/wasm/%.o: wxf/%.c wxf/wxf.h | build/wasm
	$(CLANG) $(WASM_CFLAGS) -c -o $@ $<

build/wasm/%.o: wasm/%.c wxf/wxf.h | build/wasm
	$(CLANG) $(WASM_CFLAGS) -c -o $@ $<

build/wasm:
	mkdir -p $@

test: web/wxf.wasm
	tests/run_codec_tests.sh
	node tests/node_e2e.mjs

clean:
	rm -rf build web/wxf.wasm

.PHONY: test clean
