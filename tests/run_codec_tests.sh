#!/usr/bin/env bash
# Builds the native codec test, has the kernel write reference WXF files, round-trips them through
# the codec, then has the kernel check the files the codec writes.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd -P)
mkdir -p build/written
${CC:-cc} -std=c11 -O2 -Wall -Wextra -Werror -fsanitize=address,undefined -o build/codec_test tests/codec_test.c wxf/wxf.c
kernel/wolframkernel-udocker -noprompt -initfile "$root/tests/cases.wl" -run 'Exit[]'
build/codec_test roundtrip build/kernel/*.wxf
build/codec_test write build/written
kernel/wolframkernel-udocker -noprompt -initfile "$root/tests/check_written.wl" -run 'Exit[]'
