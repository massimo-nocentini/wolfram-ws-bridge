# wolfram-ws-bridge

Talk to a Wolfram kernel from a browser: expressions travel as **WXF** (Wolfram's documented
binary expression format) over a **WebSocket**, encoded and decoded by a small C library compiled
to WebAssembly.

```
browser: your JS ── wolfram-socket.js ── wxf.js ── wxf.wasm (C codec)
            │  binary WebSocket messages, one WXF expression each
server:  server/bridge.py (Python, websockets + pyzmq)
            │  local ZMQ socket per kernel
kernel:  WolframKernel running kernel/WSBridge.wl (allowlist, limits, evaluation)
```

Nothing in this repository is derived from Wolfram code: the codec is written from the public
WXF description, and the server uses only documented kernel functionality. The kernel itself
needs its normal Wolfram Engine license.

## Layout

| Path | What it is |
|---|---|
| `wxf/wxf.h`, `wxf/wxf.c` | WXF encoder/decoder in C, no libc, no allocation of its own (WSTP-like put calls; token reader) |
| `wasm/wasm_api.c` | wasm32 exports and a bump arena for the codec |
| `web/wxf.wasm` | the built module (9 KB, no imports); rebuild with `make` |
| `web/wxf.js` | JS expressions ⇄ WXF bytes through the wasm module; `toInputForm` for display |
| `web/wolfram-socket.js` | WebSocket client: `evaluate(expr or string)` → Promise of the reply |
| `web/index.html` | test page served by the bridge |
| `server/bridge.py` | WebSocket + static HTTP server, kernel pool with watchdog |
| `kernel/WSBridge.wl` | kernel side: decode, allowlist check, time/memory limits, request loop |
| `kernel/allowlist.txt` | the `System`` functions clients may use |
| `kernel/wolframkernel-udocker` | runs the kernel inside the `wlengine` udocker container |
| `tests/` | codec tests against the kernel, Python and Node end-to-end tests, limits test |

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # or requirements.txt without tests
make            # only needed after changing the C code: clang + wasm-ld (or rustup's rust-lld)
```

The kernel wrapper binds `~/.WolframEngine` (license) into the container. Settings through the
environment: `WOLFRAM_CONTAINER` (default `wlengine`), `WOLFRAM_KERNEL`, `WOLFRAM_LICENSE_DIR`,
`WOLFRAM_CONTAINER_HOME`. With a native Wolfram install, pass `--kernel /path/to/WolframKernel`.

## Run

```sh
.venv/bin/python server/bridge.py            # prints: ready: open http://127.0.0.1:18000/?token=...
```

Open the printed URL for the test page. Options: `--port`, `--host` (default `127.0.0.1`),
`--kernels N`, `--time-limit` (s, default 30), `--memory-limit` (bytes, default 2 GiB),
`--request-timeout`, `--max-message`, `--allow-origin URL`. Set `WSBRIDGE_TOKEN` to fix the
token; otherwise a random one is generated at each start. Ctrl+C stops the server and its kernels.

## Use from JavaScript

```js
import { WXF, fn, sym, toInputForm } from './wxf.js'
import { WolframSocket } from './wolfram-socket.js'

const socket = await WolframSocket.open('ws://127.0.0.1:18000/ws?token=...', await WXF.load())
const a = await socket.evaluate('Integrate[x^2 Sin[x], x]')          // text, parsed by the kernel
const x = sym('Global`x')
const b = await socket.evaluate(fn('Factor', fn('Plus', fn('Power', x, 4), -1)))   // expression
// a.success, a.result (decoded expression), a.inputForm ("-((-2 + x^2)*Cos[x]) + 2*x*Sin[x]"),
// a.messages (["Power::infy: Infinite expression 0^(-1) encountered."]), a.timing
// failures: { success: false, failure: "NotAllowed" | "Syntax" | "TimeLimit" | ..., message, symbols }
```

Expression mapping (see the top of `web/wxf.js`): integers ⇄ `number`/`BigInt`, reals ⇄ `WReal`
(non-integer numbers also encode as reals), strings ⇄ `string`, `List` ⇄ `Array`, symbols ⇄
`WSymbol`, other heads ⇄ `WFunction`, `Association` ⇄ `WAssociation` (plain objects encode as
associations), `ByteArray` ⇄ `Uint8Array`, packed/numeric arrays ⇄ `WArray` (typed array + dims),
arbitrary-precision reals ⇄ `WBigReal`.

## Protocol

- **Request**: one binary message holding uncompressed WXF (`8:` header) of one expression. A WXF
  `String` (or a text message) is Wolfram Language input that the kernel parses, without evaluating, before
  the checks.
- **Reply**: exactly one binary message per request, in request order: the WXF of
  `<|"Success" -> True, "Result" -> expr, "InputForm" -> "...", "Messages" -> {...}, "Timing" -> t|>`
  or `<|"Success" -> False, "Failure" -> type, "Message" -> "...", ("Symbols" -> {...})|>`.
- Failure types: `Decode`, `Syntax`, `NotAllowed`, `TimeLimit`, `MemoryLimit`, `Aborted`,
  `KernelRestarted` (the kernel stopped answering and was replaced).

## Security

Evaluating expressions from the network is running code on this machine, so:

- **Allowlist**: before anything is evaluated, every symbol in the request must be a `System``
  symbol listed in `kernel/allowlist.txt`, or a `Global`` symbol without definitions (a plain
  variable). Everything else (`Set`, `ToExpression`, `Symbol`, `Get`, `Import`, `Run`, files,
  network, other contexts...) is refused. Add functions to the list with care.
- **Limits**: each evaluation runs under `TimeConstrained` and `MemoryConstrained`; a kernel that
  still does not answer is killed with its process group (udocker, proot, kernel) and replaced.
- **Access**: the server listens on `127.0.0.1` by default, the WebSocket requires the token, and
  browsers may connect only from the server's own origin (plus `--allow-origin`). Put a TLS proxy
  in front before exposing it beyond localhost.
- **License**: serving other people may need a different Wolfram license than the one for personal
  or development use. The license on this machine expires on 2026-12-10.

## Tests

```sh
tests/run_codec_tests.sh       # kernel writes 62 reference WXF files: decode+re-encode must give
                               # identical bytes; kernel reads files written by the codec (ASan/UBSan)
# with a server running (WSBRIDGE_TOKEN=testtoken):
node tests/node_e2e.mjs        # 83 checks: wasm codec round trips, kernel round trips, refusals, ordering
.venv/bin/python tests/smoke_ws.py
# with a server started with --time-limit 1 --memory-limit 200000000:
.venv/bin/python tests/limits_test.py
```

## Not supported

Compressed WXF (`8C:`) is refused, and there is no WSTP: the browser cannot open the raw TCP
connections WSTP needs, and the bridge speaks WXF instead.
