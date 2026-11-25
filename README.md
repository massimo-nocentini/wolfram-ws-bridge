# wolfram-ws-bridge

Talk to a Wolfram kernel from a browser: expressions travel as **WXF** (Wolfram's documented
binary expression format) over a **WebSocket**, encoded and decoded by a small C library compiled
to WebAssembly.

```
browser: your JS ── wolfram-socket.js ── wxf.js ── wxf.wasm (C codec)
            │  binary WebSocket messages, one WXF expression each
server:  server/bridge.py (Python, websockets + pyzmq)
            │  local ZMQ socket per kernel
kernel:  WolframKernel running kernel/WSBridge.wl (evaluation, TeX and pictures)
```

Nothing in this repository is derived from Wolfram code: the codec is written from the public
WXF description, and the server uses only documented kernel functionality. The kernel itself
needs its normal Wolfram Engine license.

## Layout

| Path | What it is |
|---|---|
| `wxf/wxf.h`, `wxf/wxf.c` | WXF encoder/decoder in C, no libc, no allocation of its own (WSTP-like put calls; token reader) |
| `wasm/wasm_api.c` | wasm exports and a bump arena for the codec |
| `web/wxf.wasm` | the built module, wasm32 (7 KB, no imports); rebuild with `make` |
| `web/wxf.js` | JS expressions ⇄ WXF bytes through the wasm module; `toInputForm(expr, limit)`: Wolfram Language text for display and templates |
| `web/wolfram-socket.js` | WebSocket client: `evaluate(expr or string)` → Promise of the reply, `evaluateWXF(bytes)` for encoded requests; `toReply` for decoded reply bytes; `imageURL` for pictures |
| `web/js-helpers.js` | helpers for JavaScript code: `W` (expressions such as `W.Sin(W.x)`), Wolfram Language text from templates, `toJS`, display text of any value; pure, also for Node |
| `web/js-runner.js` | module worker that runs the code of the test page's JavaScript mode (and of the examples page) |
| `web/page.js` | what both pages share: connecting, showing a reply (KaTeX, pictures, text), JavaScript runs in a worker |
| `web/index.html` | test page served by the bridge, with Wolfram Language and JavaScript input: math typeset with KaTeX, plots and images as pictures |
| `web/examples.html`, `web/examples.js` | examples page for the JavaScript mode (`/examples.html`): 14 examples to run in place or open in the test page's editor |
| `web/vendor/katex/` | KaTeX 0.19.1 (MIT), vendored from the npm package: script, CSS, woff2 fonts (see its README) |
| `server/bridge.py` | WebSocket + static HTTP server, kernel pool that replaces kernels that exit |
| `kernel/WSBridge.wl` | kernel side: decode, evaluation, TeX and pictures of results, request loop |
| `kernel/wolframkernel-udocker` | runs the kernel inside the `wlengine` udocker container |
| `Dockerfile`, `.github/workflows/docker.yml` | server image on top of the official Wolfram Engine image, built and published to GHCR by GitHub Actions |
| `Dockerfile.raspberrypi` | arm64 server image for a Raspberry Pi, with the Wolfram Engine for Raspberry Pi; built locally on the Pi, never published |
| `tests/` | codec tests against the kernel, Python, Node and browser end-to-end tests |

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # or requirements.txt without tests
make            # only needed after changing the C code: clang + wasm-ld (or rustup's rust-lld);
                # builds web/wxf.wasm (wasm32); make wasm64 checks that the C code
                # also builds for wasm64 (build/wxf64.wasm, not used by the page)
```

The kernel wrapper binds `~/.WolframEngine` (license) into the container. Settings through the
environment: `WOLFRAM_CONTAINER` (default `wlengine`), `WOLFRAM_KERNEL`, `WOLFRAM_LICENSE_DIR`,
`WOLFRAM_CONTAINER_HOME`. With a native Wolfram install, pass `--kernel /path/to/WolframKernel`.

## Run

```sh
.venv/bin/python server/bridge.py            # prints: ready: open http://127.0.0.1:18000/?token=...
```

Open the printed URL for the test page. Options: `--port`, `--host` (default `127.0.0.1`),
`--kernels N` (definitions live in one kernel, and a request goes to any idle one),
`--allow-origin URL`. Set `WSBRIDGE_TOKEN` to fix the
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

- Arguments after the image name go to `server/bridge.py` (`--kernels`, ...). The
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
// failures: { success: false, failure: "Syntax" | "Aborted" | "KernelRestarted" | ..., message, symbols: [] }
// every reply also has raw (the decoded reply) and bytes (its WXF)
```

A symbol name without a context is a `System`` symbol in WXF: write variables as `sym('Global`x')`
(`sym('x')` is `System`x`, another symbol, and the one that a typed `x` then means). `socket.evaluateWXF(bytes)` sends a request that is already
WXF (`evaluate(Uint8Array)` sends a `ByteArray`), and `toReply(wxf.decode(reply.bytes))` turns
reply bytes back into the reply object, e.g. in a worker that got them from the page.

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
else if (r.tex !== undefined) katex.render(r.tex, element, { displayMode: true, throwOnError: false, trust: false })
else element.textContent = r.inputForm
```

Neither field is there when the result is not typeset (more than 20000 leaves, or characters of
TeX) or an export failed; the InputForm text is always there, in full. The test page does exactly this, with the KaTeX copy in `web/vendor/katex/`
(no CDN; `trust: false`, and a wider `\arraystretch` so that
matrices of fractions do not touch), pictures on a white card so that black axes stay readable in
dark mode, and the InputForm under each formula to copy.

### JavaScript mode of the test page

The switch above the input chooses between Wolfram Language and JavaScript input (remembered per
browser; each mode keeps its own text; the button says Evaluate or Run, and Ctrl/Cmd+Enter runs
either). JavaScript code is the body of an async function, so `await` works and a returned value
is shown:

```js
const p = await wl('Expand[(x - 1) (x - 2) (x - 3)]')      // a string is Wolfram Language text
console.log('p =', p)                                       // a line under the code: p = Plus[-6, Times[11, x], ...]
await show(W.Plot(W.Sin(W.x), [W.x, 0, 6]))                 // shown like a Wolfram-mode result
return wl`Solve[${p} == 0, x]`                              // typeset: {{x -> 1}, {x -> 2}, {x -> 3}}
```

- `W.name` is a symbol that can also be called as a head: `W.Sin(W.x)` is `Sin[x]`,
  `W.Integrate(W.Power(W.x, 2), W.x)` is `Integrate[x^2, x]`, `W.f(1)` is `f[1]`. Names that start
  with a capital letter or `$` are `System`` symbols (`W.Pi`, `W.C`); others are variables in
  `Global`` (`W.x` is `Global`x`); `W['Global`A']` is a variable with a capital letter. Do not
  write `W.A` for it: that is `System`A`, which the kernel creates and a typed `A` then means.
  Symbols are `WSymbol`s (`instanceof WSymbol`), so they encode and print like `sym(...)`.
- `wl(expr)` evaluates and resolves to the decoded result; a failure (`Syntax`,
  `Aborted`...) rejects with a `WolframError` that has `failure` and `reply`.
  `wl.reply(expr)` resolves to the whole reply (`success`, `result`, `inputForm`, `messages`,
  `timing`, `tex`, `image`, `format`). As a tagged template, ``wl`Solve[${p} == 0, x]` `` is
  Wolfram Language text: the raw strings (so `\[Pi]` stays) with each value inserted as
  `(InputForm)`: numbers as Wolfram numbers (`1.*^-7`), strings as Wolfram strings (control
  characters as `\:0001`), expressions as their InputForm (a rule on the left of a rule in
  parentheses: `(1 -> 2) -> 3`). A value that cannot be sent (a function, `NaN`) rejects.
- `show(expr)` evaluates and shows the result in the run's entry exactly like the Wolfram mode
  (KaTeX, a picture, kernel messages, the meta line) and resolves to the result. A result of the
  same run that the code has not changed is shown from its reply without another evaluation;
  one changed in place (`r.push(W.z)`) is evaluated as it is now.
- `console.log`, `info`, `debug`, `warn`, `error` write lines (warnings and errors in red);
  values are shown JSON-like (`2n`, `[Circular]`), Wolfram expressions as InputForm.
- Also there: `sym`, `fn`, `real`, `toInputForm`, `WSymbol`, `WFunction`, `WReal`, `WBigReal`,
  `WAssociation`, `WArray`, and `toJS(result)`: reals as numbers, `True`/`False`/`Null` as
  `true`/`false`/`null`, associations as objects (a `Map` when a key is not a string), packed
  arrays as nested arrays, lists element by element; other expressions unchanged.
- The returned value: nothing for `undefined`; a Wolfram expression (or an array holding one), or
  a result of the run, is shown like `show`, once (`return show(...)` does not show it twice);
  anything else as text. A failure of `show` (also of a returned value) is shown where the result would be, and not again as an uncaught error;
  code that catches it gets the `WolframError` as usual. An uncaught exception is shown as an error line with the line of the
  code when the browser's stack trace gives it.
- There is no translation of JavaScript operators: `W.x * 2` is `NaN` and `W.x + 1` a string.
  Write `W.Times(W.x, 2)`, or Wolfram Language text.

Each run has a fresh module worker (`web/js-runner.js`), which the Stop button terminates: an
endless loop never blocks the page, and only one run goes at a time. The worker loads its own
WXF codec and sends WXF bytes; the page evaluates them on its socket and sends the reply bytes
back, and shows a result when the worker names the request it came from. Not awaited calls are
lost when the code returns: the worker ends with the run.

- Stop does not interrupt the kernel: requests already sent finish there (their replies are
  dropped), and a later run's requests wait behind them (its meta line says `waiting for n
  evaluations of earlier runs`). At most 8 requests of all runs are sent at once and the others wait; a run's
  requests that were not sent yet are dropped with it, so Run and Stop again cannot pile up work.
- The worker runs in the page's process: code that uses up memory
  (`for (;;) a.push(new Array(1e6))`) crashes the whole tab within seconds, with its entries and
  drafts, and Stop cannot prevent that.
- Nothing limits what a run prints, shows or sends: an endless loop of `console.log` uses up the
  tab's memory, and Stop may come too late.

### Examples page

`/examples.html` (with the same `?token=…`; linked from the test
page's header and after its JavaScript examples; the links between the two pages keep the query)
has 14 short examples of the JavaScript mode in six sections: expressions built with `W` and with
templates, a table from a loop, exact roots checked numerically, Newton's method with the
kernel's `D`, matrices from arrays, plots built with `W`, data computed in JavaScript and drawn by
the kernel (logistic map, Ulam spiral), big integers as `BigInt`, continued fractions, error
handling, and a loop that only Stop ends. The code lives in `web/examples.js`.

- Run shows the output under the example, exactly as the test page would (each run in a fresh
  worker: `web/page.js` holds that code for both pages). One run
  at a time: the other Run buttons are disabled until it ends; running an example again replaces
  its output.
- Open in editor goes to `index.html?…#js=<code>`: the test page switches to JavaScript mode and
  puts the code in its editor without running it, then removes the fragment (a fragment is never
  sent to the server). A fragment that does not decode is not loaded and a notice
  says so. Code from a link is never run by itself: read it before you press Run.

### The wasm module

`WXF.load()` loads `wxf.wasm`, the codec built for wasm32. It runs in every current browser and in
Node, with at most 4 GiB of memory for one message. The C code also builds for wasm64 (`make wasm64`, checked by `make test`), but `wxf.js`
loads only the wasm32 build and refuses another.

Expression mapping (see the top of `web/wxf.js`): integers ⇄ `number`/`BigInt`, reals ⇄ `WReal`
(non-integer numbers also encode as reals), strings ⇄ `string`, `List` ⇄ `Array`, symbols ⇄
`WSymbol`, other heads ⇄ `WFunction`, `Association` ⇄ `WAssociation` (plain objects encode as
associations), `ByteArray` ⇄ `Uint8Array`, packed/numeric arrays ⇄ `WArray` (typed array + dims),
arbitrary-precision reals ⇄ `WBigReal`.

## Protocol

- **Request**: one binary message holding uncompressed WXF (`8:` header) of one expression. A WXF
  `String` (or a text message) is Wolfram Language input that the kernel parses in
  the session's contexts; several expressions are evaluated in turn and the last one is the result.
  Definitions, loaded packages and `$Context` stay for later requests (``ClearAll["Global`*"]``
  clears the definitions). What `Print` writes goes to the kernel's log in `run/port-<port>/`.
- **Reply**: exactly one binary message per request, in request order: the WXF of
  `<|"Success" -> True, "Result" -> expr, "InputForm" -> "...", "Messages" -> {...}, "Timing" -> t, display|>`
  or `<|"Success" -> False, "Failure" -> type, "Message" -> "..."|>`.
  `display` is at most one of `"TeX" -> "..."` (the result's `TeXForm`) and
  `"Image" -> <|"Format" -> "SVG" | "PNG", "Data" -> svgString | pngByteArray|>`; none if the
  result cannot be shown that way, plus `"Format" -> "Aborted"` when making it was
  aborted. `Timing` is the evaluation alone.
- **Pictures**: a result that is or contains `Graphics`, `Graphics3D`, `Legended` (plots with
  `PlotLegends`), `GraphicsRow`/`Column`/`Grid` or `Image` is exported as SVG (a list of plots as
  one SVG); a lone `Image` as PNG. An SVG of more than 500 kB (dense contour or density plots,
  whose polygon mesh also shows hairline seams) is replaced by a PNG at 144 dpi wrapped in an SVG
  of the same size. 3D graphics come as SVG with an embedded raster image, as the kernel exports them.
- **TeX**: `TeXForm` without a front end gets some things wrong, which the kernel fixes before
  sending: text other than ASCII in strings and association keys, reals of at most 10^-5 (printed
  as InputForm text; sent as `ScientificForm`, in parentheses where a power or product needs them),
  `Root` objects (empty; sent as `\operatorname{Root}\left(1-x+x^5,\,1\right)\approx -1.1673`,
  in parentheses inside a sum or product), `RootSum` (sent as `\sum_{\alpha:\,\ldots=0}`),
  `ConditionalExpression` (a box; sent as `a\quad\text{if }c`, in parentheses inside a function),
  lists of matrices and `{values, vectors}` (drawn as one matrix of lists), and `\unicode{...}` for
  private-use characters such as the brackets of associations, which KaTeX does not know. Long
  rows (`Range[1500]`) are split before the conversion to TeX, which otherwise takes seconds.
- **Exports**: an export that is aborted (by `TimeConstrained` in the input, say) leaves the kernel
  unable to export again (`Export` returns `Null`, also with a new front end), so the kernel sends
  `restart` before that reply and exits after it; the bridge then starts another kernel (about
  10 s, during which requests wait).
- **No limits**: evaluations have no time or memory limit, and messages no size limit. An endless
  evaluation ends when its client disconnects: reload the page, and the kernel is killed with its
  process group (udocker, proot, kernel, front end) and replaced, without its definitions. The same
  happens when a kernel exits (`Quit[]`, a crash), with the failure `KernelRestarted`.
- Failure types: `Decode`, `Syntax`, `Aborted`, `KernelRestarted`. An uncaught `Throw`, `Break`,
  `Goto`... comes back as the result, in `Hold`.

## Security

The bridge is for one person on their own machine. **Whoever has the token can run any program and
read or change any file that the kernel can**: there is no list of allowed functions and no limit
on time or memory (`Run`, `Import`, `DeleteFile`... all work, and an evaluation can use up the
machine's memory). Use a long random token (the server makes one unless `WSBRIDGE_TOKEN` is set),
and do not expose the port.

- **JavaScript mode**: code runs in a worker without the DOM or the token, but through `wl` it can
  evaluate anything. Run only code that you would run in a terminal.
- **Access**: the server listens on `127.0.0.1` by default, the WebSocket requires the token, and
  browsers may connect only from the server's own origin (plus `--allow-origin`). Do not
  expose it beyond localhost.
- **License**: serving other people may need a different Wolfram license than the one for personal
  or development use. The license on this machine expires on 2026-12-10.

## Tests

```sh
tests/run_codec_tests.sh       # kernel writes 62 reference WXF files: decode+re-encode must give
                               # identical bytes; kernel reads files written by the codec (ASan/UBSan)
# with a server running (WSBRIDGE_TOKEN=testtoken); each test takes another URL as its argument,
# e.g. node tests/node_e2e.mjs 'ws://127.0.0.1:18100/ws?token=testtoken':
node tests/node_e2e.mjs        # 214 checks: codec and kernel round trips, a 96 MiB value, any function,
                               # definitions that stay, control flow that must not end the kernel, large
                               # requests and results, Quit[] and a client that leaves (the kernel is
                               # replaced: run it on a server without definitions you need), ordering;
                               # TeX of 44 varied results must render with the vendored KaTeX
                               # (throwOnError), Range[1500] within 5 s, plots must come back as SVG,
                               # an Image as PNG; js-helpers.js (W, templates with control characters
                               # and nested rules, toJS, value display) and expressions built with W,
                               # evaluateWXF and toReply; the code of the examples page compiles
.venv/bin/python tests/smoke_ws.py   # 16 requests, text and WXF; replies carry TeX or a picture
node tests/screenshots.mjs     # the test page in headless Chromium ($CHROME or chromium-headless):
                               # 12 evaluations, JavaScript runs and the 14 examples of the examples
                               # page (80 checks): math
                               # typeset with KaTeX, Plot, Plot3D and ContourPlot pictures loaded, KaTeX
                               # fonts served by the bridge, nothing from other origins, no overflow at
                               # phone width (also with a 200-digit message), labelled input and live
                               # regions; JavaScript mode: wl, show, return values, console lines,
                               # errors with line numbers, failures as rejections, templates, results
                               # changed in place, no DOM or token in the worker, an endless loop
                               # stopped with the page responsive and the worker gone, Stop during
                               # kernel work, drafts and remembered mode, a failed returned value shown
                               # once; examples page: every example run with its output checked (text,
                               # KaTeX, pictures), one run at a time, Stop of the endless one, Copy, Open
                               # in editor (code in the editor, not run; a malformed #js= link
                               # refused), no overflow at phone width; screenshots (light,
                               # light-full, dark, phone, js-light, js-dark, js-phone, examples-light,
                               # examples-full, examples-dark, examples-phone, examples-phone-results)
                               # in build/screenshots/
```

## Not supported

Compressed WXF (`8C:`) is refused, and there is no WSTP: the browser cannot open the raw TCP
connections WSTP needs, and the bridge speaks WXF instead.
