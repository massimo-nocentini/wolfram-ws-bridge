# wolfram-ws-bridge

Talk to a Wolfram kernel from a browser: expressions travel as **WXF** (Wolfram's documented
binary expression format) over a **WebSocket**, encoded and decoded by a small C library compiled
to WebAssembly.

```
browser: your JS ── wolfram-socket.js ── wxf.js ── wxf.wasm or wxf64.wasm (C codec)
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
| `wasm/wasm_api.c` | wasm32/wasm64 exports and a bump arena for the codec |
| `web/wxf.wasm`, `web/wxf64.wasm` | the built modules, wasm32 and wasm64 (7 KB each, no imports); rebuild with `make` |
| `web/wxf.js` | JS expressions ⇄ WXF bytes through the wasm module; `toInputForm` for display |
| `web/wolfram-socket.js` | WebSocket client: `evaluate(expr or string)` → Promise of the reply; `imageURL` for pictures |
| `web/index.html` | test page served by the bridge: math typeset with KaTeX, plots and images as pictures |
| `web/vendor/katex/` | KaTeX 0.19.1 (MIT), vendored from the npm package: script, CSS, woff2 fonts (see its README) |
| `server/bridge.py` | WebSocket + static HTTP server, kernel pool with watchdog |
| `kernel/WSBridge.wl` | kernel side: decode, allowlist check, time/memory limits, TeX and pictures of results, request loop |
| `kernel/allowlist.txt` | the `System`` functions clients may use |
| `kernel/wolframkernel-udocker` | runs the kernel inside the `wlengine` udocker container |
| `Dockerfile`, `.github/workflows/docker.yml` | server image on top of the official Wolfram Engine image, built and published to GHCR by GitHub Actions |
| `Dockerfile.raspberrypi` | arm64 server image for a Raspberry Pi, with the Wolfram Engine for Raspberry Pi; built locally on the Pi, never published |
| `tests/` | codec tests against the kernel, Python and Node end-to-end tests, limits test |

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # or requirements.txt without tests
make            # only needed after changing the C code: clang + wasm-ld (or rustup's rust-lld);
                # builds web/wxf.wasm (wasm32) and web/wxf64.wasm (wasm64)
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
`--format-time-limit` (s for the TeX or picture of a result, default 20),
`--request-timeout` (s, default time limit + format time limit + 15), `--max-message` (bytes of
a request, default 8 MiB), `--max-reply` (bytes of a reply, default 64 MiB; a larger one is
replaced by a `ReplyTooLarge` failure), `--allow-origin URL`. Set `WSBRIDGE_TOKEN` to fix the
token; otherwise a random one is generated at each start. Ctrl+C stops the server and its kernels.
Each kernel's front end, which draws the pictures, starts a kernel of its own: count two license
processes per kernel.

## Docker

The image `ghcr.io/massimo-nocentini/wolfram-ws-bridge` is the server with its own Wolfram
Engine: the `Dockerfile` adds Python, the server, the kernel files and `web/` to Wolfram's
official `wolframresearch/wolframengine:15.0` image (build argument `WOLFRAM_ENGINE_IMAGE`). The
workflow `.github/workflows/docker.yml` builds it for every push and pull request and publishes it
for pushes to `main` (tags `main` and `sha-<commit>`) and for tags `v<version>` (tag `<version>`).
A package published from a public repository is public. The image contains the Wolfram Engine:
unless Wolfram's license terms allow redistributing it, make the package private (the package's
settings on GitHub, "Change visibility") and pull it after `docker login ghcr.io` with a token
that has the `read:packages` scope.

The image has no license. Mount an activated `Licensing` folder over the container user's one:

```sh
docker run --rm -p 127.0.0.1:18000:18000 -e WSBRIDGE_TOKEN=change-me \
  -v ~/.WolframEngine/Licensing:/home/wolframengine/.WolframEngine/Licensing \
  ghcr.io/massimo-nocentini/wolfram-ws-bridge:main
# then open http://127.0.0.1:18000/?token=change-me
```

- Arguments after the image name go to `server/bridge.py` (`--kernels`, `--time-limit`, ...). The
  server listens on all interfaces inside the container; publish the port on `127.0.0.1` as
  above unless a TLS proxy is in front.
- Pages may connect only from `http://127.0.0.1:<port>` and `http://localhost:<port>`, with the
  port the server listens on. Publishing it on another host port (`-p 8080:18000`) needs
  `--allow-origin http://127.0.0.1:8080`.
- A license activated on the host is tied to that machine. If the kernel in the container does
  not accept it (the server stops at once with `kernel-1 exited with code 70` and the end of the
  kernel's log, `No valid password found.`), activate once inside a container with the
  folder mounted, `docker run -it --rm -v ...:/home/wolframengine/.WolframEngine/Licensing
  --entrypoint wolframscript ghcr.io/massimo-nocentini/wolfram-ws-bridge:main -activate`, or run
  with `--network host` on Linux.
- `tini` is PID 1 and reaps the front-end processes of replaced kernels; `docker stop` stops
  the server and its kernels.
- Build it yourself with `docker build -t wolfram-ws-bridge .` (the base image is 3.3 GB).

### Raspberry Pi (arm64)

Wolfram publishes its Docker image for x86-64 only (`docker run --platform linux/amd64` runs it on
other machines through emulation, slowly). On a Raspberry Pi, `Dockerfile.raspberrypi` builds a
native arm64 image instead: Debian bookworm with the `wolfram-engine` package from Raspberry Pi's
apt repository (used for that package only) and the same server layers. Build it on the Pi:

```sh
docker build -f Dockerfile.raspberrypi --build-arg WOLFRAM_RPI_EULA=accept -t wolfram-ws-bridge:rpi .
docker run --rm -p 127.0.0.1:18000:18000 -e WSBRIDGE_TOKEN=change-me \
  -v wsb-licensing:/home/wolframengine/.WolframEngine/Licensing wolfram-ws-bridge:rpi
```

- That Wolfram Engine comes under the [Wolfram - Raspberry Pi Bundle License
  Agreement](http://www.wolfram.com/legal/agreements/wolfram-mathematica-raspberry-pi.html), which
  the build accepts with `WOLFRAM_RPI_EULA=accept` (without it the build stops): personal or
  educational use on a Raspberry Pi only, no commercial use, no redistribution (do not push the
  image anywhere), and no access by other users through a web server. The GitHub workflow does
  not build this image.
- The download is about 2.2 GB and the installed engine 5.3 GB; leave about 10 GB free.
- The engine is version 15.0.1 (15.0 in the x86-64 image).
- If the kernel does not start (`No valid password found.` in the server's log), the engine may
  not see that it runs on a Pi: Docker hides `/sys/firmware`, where the device tree is. Try
  `--security-opt systempaths=unconfined`, or activate once with the volume mounted:
  `docker run -it --rm -v wsb-licensing:/home/wolframengine/.WolframEngine/Licensing
  --entrypoint wolframscript wolfram-ws-bridge:rpi -activate`.

## Use from JavaScript

```js
import { WXF, fn, sym, toInputForm } from './wxf.js'
import { WolframSocket } from './wolfram-socket.js'

const socket = await WolframSocket.open('ws://127.0.0.1:18000/ws?token=...', await WXF.load())
const a = await socket.evaluate('Integrate[x^2 Sin[x], x]')          // text, parsed by the kernel
const x = sym('Global`x')
const b = await socket.evaluate(fn('Factor', fn('Plus', fn('Power', x, 4), -1)))   // expression
// a.success, a.result (decoded expression), a.inputForm ("-((-2 + x^2)*Cos[x]) + 2*x*Sin[x]"),
// a.messages (["Power::infy: Infinite expression 0^(-1) encountered."]), a.timing,
// a.tex ("2 x \\sin (x)-\\left(x^2-2\\right) \\cos (x)"), a.image (undefined here),
// a.format (undefined unless the TeX or picture ran out of time or memory: "TimeLimit"...)
// a.result is undefined for a result above 16 MiB (ByteCount); its inputForm is then "-LargeResult-"
// failures: { success: false, failure: "NotAllowed" | "Syntax" | "TimeLimit" | ..., message, symbols }
```

### Showing results

A successful reply also says how to show the result on a page: `tex`, a TeX string for KaTeX (or
MathJax), or, for graphics, `image`: `{ format: 'SVG', data: string }` for plots and other
graphics, `{ format: 'PNG', data: Uint8Array }` for an `Image`. Then `inputForm` is just
`-Graphics-`, `-Graphics3D-` or `-Image-`. `imageURL(image)` makes an object URL for an `<img>`
(an SVG shown by `<img>` cannot run scripts):

```js
import { WolframSocket, imageURL } from './wolfram-socket.js'

const r = await socket.evaluate('Plot[Sin[x], {x, 0, 6}]')
if (r.image) img.src = imageURL(r.image)                 // URL.revokeObjectURL(img.src) when done
else if (r.tex !== undefined) katex.render(r.tex, element, { displayMode: true, throwOnError: false, trust: false, maxSize: 50 })
else element.textContent = r.inputForm
```

Neither field is there when the result cannot be shown that way (TeX longer than 20000
characters, a failed export, formatting that takes longer than its time limit, a picture over
the size limits under Protocol, strings with box syntax in the result); the InputForm text is
always there. The test page does exactly this, with the KaTeX copy in `web/vendor/katex/`
(no CDN; `trust`, `maxSize` and `maxExpand` given explicitly, and a wider `\arraystretch` so that
matrices of fractions do not touch), pictures on a white card so that black axes stay readable in
dark mode, and the InputForm under each formula to copy.

### wasm32 or wasm64

`WXF.load()` loads `wxf.wasm` (wasm32), which runs everywhere and is limited to 4 GiB of memory.
For the wasm64 build, which needs memory64 support (Chrome/Edge 133+, Firefox 134+, Node 24+):

```js
const wxf = await WXF.load(new URL('./wxf64.wasm', import.meta.url))   // wxf.wasm64 === true
```

The JavaScript API is the same for both. On wasm64 the module's pointers and sizes are 64-bit
(`BigInt` at the JS boundary); `wxf.js` converts them. The test page takes `?wasm=64`.

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
  `<|"Success" -> True, "Result" -> expr, "InputForm" -> "...", "Messages" -> {...}, "Timing" -> t, display|>`
  or `<|"Success" -> False, "Failure" -> type, "Message" -> "...", ("Symbols" -> {...})|>`.
  `display` is at most one of `"TeX" -> "..."` (the result's `TeXForm`) and
  `"Image" -> <|"Format" -> "SVG" | "PNG", "Data" -> svgString | pngByteArray|>`; none if the
  result cannot be shown that way, plus `"Format" -> "TimeLimit" | "MemoryLimit" | "Aborted"` when
  making it ran out of time or memory. `Timing` is the evaluation alone. A result larger than
  16 MiB (``WSBridge`$ResultLimit``, by `ByteCount`) comes without `"Result"` and with
  `"InputForm" -> "-LargeResult-"`.
- **Pictures**: a result that is or contains `Graphics`, `Graphics3D`, `Legended` (plots with
  `PlotLegends`), `GraphicsRow`/`Column`/`Grid` or `Image` is exported as SVG (a list of plots as
  one SVG); a lone `Image` as PNG. An SVG of more than 500 kB (dense contour or density plots,
  whose polygon mesh also shows hairline seams) is replaced by a PNG at 144 dpi wrapped in an SVG
  of the same size. 3D graphics come as SVG with an embedded raster image, as the kernel exports them.
  The front end draws the pictures, and its memory is not counted by `MemoryConstrained`, so there
  is no picture of a result with more than 10^6 leaves, more than 20000 of them outside the
  graphics (`{Graphics[], Range[10^5]}`), an `ImageSize` above 2000 points, or more than
  16 million pixels.
- **TeX**: `TeXForm` without a front end gets some things wrong, which the kernel fixes before
  sending: text other than ASCII in strings and association keys, reals of at most 10^-5 (printed
  as InputForm text; sent as `ScientificForm`, in parentheses where a power or product needs them),
  `Root` objects (empty; sent as `\operatorname{Root}\left(1-x+x^5,\,1\right)\approx -1.1673`,
  in parentheses inside a sum or product), `RootSum` (sent as `\sum_{\alpha:\,\ldots=0}`),
  `ConditionalExpression` (a box; sent as `a\quad\text{if }c`, in parentheses inside a function),
  lists of matrices and `{values, vectors}` (drawn as one matrix of lists), and `\unicode{...}` for
  private-use characters such as the brackets of associations, which KaTeX does not know. Long
  rows (`Range[1500]`) are split before the conversion to TeX, which otherwise takes seconds.
- **Formatting time**: TeX and pictures are made after the evaluation, under their own time limit
  (`--format-time-limit`, default 20 s, ``WSBridge`$FormatTimeLimit`` in the kernel); the
  server's default `--request-timeout` is the sum of both limits plus 15 s. An export stopped by
  that limit leaves the kernel unable to export again (`Export` returns `Null`, also with a new
  front end), so the kernel sends `restart` before that reply and exits after it; the bridge then
  starts another kernel (about 10 s, during which requests wait).
- Failure types: `Decode`, `Syntax`, `NotAllowed`, `TimeLimit`, `MemoryLimit`, `Aborted`,
  `KernelRestarted` (the kernel stopped answering and was replaced), `ReplyTooLarge` (from the
  server, see `--max-reply`).

## Security

Evaluating expressions from the network is running code on this machine, so:

- **Allowlist**: before anything is evaluated, every symbol in the request must be a `System``
  symbol listed in `kernel/allowlist.txt`, or a `Global`` symbol without definitions (a plain
  variable). Everything else (`Set`, `ToExpression`, `Symbol`, `Get`, `Import`, `Run`, files,
  network, other contexts...) is refused. Add functions to the list with care. The list has a
  graphics section: plotting functions, graphics primitives, colors and the usual plot options;
  their results are pictures (see Protocol). `RandomReal` and `RandomInteger` are allowed for data.
  The check includes the keys of associations, which a WXF request can send as an atom whose keys
  `Cases` does not visit (`Normal` would evaluate them).
- **Box syntax**: the front end reads linear box syntax (`\!\(...\)`, `\(...\)`, `\*`) in the
  strings it draws, such as labels and `Text`. A request with such a string is refused, whether
  typed, written with escapes (`\.5c!`, `\:005c`) or sent as WXF, and a result with one gets no
  TeX or picture; `ToString` cannot make one (`StandardForm` and `TraditionalForm` are not
  allowed). During an evaluation, `Image` takes pixel data only (arrays of numbers, images), so
  that no graphics or text are rasterized there.
- **Limits**: each evaluation runs under `TimeConstrained` and `MemoryConstrained`; the TeX,
  picture and InputForm text of a result under the format time limit and the memory the result
  leaves free. A kernel that still does not answer is killed with its process group (udocker,
  proot, kernel, front end) and replaced. The front end's memory is bounded only by the picture
  limits under Protocol.
- **Access**: the server listens on `127.0.0.1` by default, the WebSocket requires the token, and
  browsers may connect only from the server's own origin (plus `--allow-origin`). Put a TLS proxy
  in front before exposing it beyond localhost.
- **License**: serving other people may need a different Wolfram license than the one for personal
  or development use. The license on this machine expires on 2026-12-10.

## Tests

```sh
tests/run_codec_tests.sh       # kernel writes 62 reference WXF files: decode+re-encode must give
                               # identical bytes; kernel reads files written by the codec (ASan/UBSan)
# with a server running (WSBRIDGE_TOKEN=testtoken); each test takes another URL as its argument,
# e.g. node tests/node_e2e.mjs 'ws://127.0.0.1:18100/ws?token=testtoken':
node tests/node_e2e.mjs        # 300 checks, with wasm32 and wasm64: codec and kernel round trips, a 96 MiB
                               # value, refusals (also in association keys and of box syntax in strings),
                               # picture limits, ordering; both builds must encode to the same bytes;
                               # TeX of 44 varied results must render with the vendored KaTeX
                               # (throwOnError), Range[1500] within 5 s, plots must come back as SVG,
                               # an Image as PNG
.venv/bin/python tests/smoke_ws.py   # 18 requests, text and WXF; replies carry TeX or a picture
node tests/screenshots.mjs     # the test page in headless Chromium ($CHROME or chromium-headless):
                               # 12 evaluations with each build (30 checks): math typeset with KaTeX,
                               # Plot, Plot3D and ContourPlot pictures loaded, KaTeX fonts served by
                               # the bridge, nothing from other origins, no overflow at phone width
                               # (also with a 200-digit message), labelled input and live regions;
                               # screenshots (light, light-full, dark, phone) in build/screenshots/
# with a server started with --time-limit 1 --memory-limit 200000000 --format-time-limit 2:
.venv/bin/python tests/limits_test.py   # limits then a working kernel, ten times; an export that runs
                                        # out of time, then a Plot that comes with a picture (twice)
```

## Not supported

Compressed WXF (`8C:`) is refused, and there is no WSTP: the browser cannot open the raw TCP
connections WSTP needs, and the bridge speaks WXF instead.
