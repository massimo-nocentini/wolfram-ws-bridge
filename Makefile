# make            build web/wxf.wasm (wasm32) and web/wxf64.wasm (wasm64, memory64)
# make test       codec tests against the kernel, then the end-to-end tests (server must be running)

CLANG ?= clang
# any wasm-ld works; without one on PATH, use the rust-lld that ships with rustup toolchains
WASM_LD ?= $(shell command -v wasm-ld 2>/dev/null)
ifeq ($(strip $(WASM_LD)),)
WASM_LD := $(firstword $(wildcard $(HOME)/.rustup/toolchains/*/lib/rustlib/*/bin/rust-lld)) -flavor wasm
endif

WASM_CFLAGS = -O2 -ffreestanding -nostdlib -mbulk-memory -fvisibility=hidden -std=c11 -Wall -Wextra -Werror \
              -DWXF_REALLOC=wxf_arena_realloc
WASM_LDFLAGS = --no-entry --strip-all --stack-first -z stack-size=65536

all: web/wxf.wasm web/wxf64.wasm

web/wxf.wasm: build/wasm32/wxf.o build/wasm32/wasm_api.o
	$(WASM_LD) $(WASM_LDFLAGS) -o $@ $^

web/wxf64.wasm: build/wasm64/wxf.o build/wasm64/wasm_api.o
	$(WASM_LD) -mwasm64 $(WASM_LDFLAGS) -o $@ $^

build/wasm32/%.o: wxf/%.c wxf/wxf.h | build/wasm32
	$(CLANG) --target=wasm32 $(WASM_CFLAGS) -c -o $@ $<
build/wasm32/%.o: wasm/%.c wxf/wxf.h | build/wasm32
	$(CLANG) --target=wasm32 $(WASM_CFLAGS) -c -o $@ $<
build/wasm64/%.o: wxf/%.c wxf/wxf.h | build/wasm64
	$(CLANG) --target=wasm64 $(WASM_CFLAGS) -c -o $@ $<
build/wasm64/%.o: wasm/%.c wxf/wxf.h | build/wasm64
	$(CLANG) --target=wasm64 $(WASM_CFLAGS) -c -o $@ $<

build/wasm32 build/wasm64:
	mkdir -p $@

test: all
	tests/run_codec_tests.sh
	node tests/node_e2e.mjs
	node tests/screenshots.mjs

clean:
	rm -rf build web/wxf.wasm web/wxf64.wasm

.PHONY: all test clean
