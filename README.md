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
| `wasm/wasm_api.c` | wasm exports and a bump arena for the codec |
| `web/wxf.wasm` | the built module, wasm32 (7 KB, no imports); rebuild with `make` |
| `web/wxf.js` | JS expressions ⇄ WXF bytes through the wasm module; `toInputForm(expr, limit)`: Wolfram Language text for display and templates |
| `web/wolfram-socket.js` | WebSocket client: `evaluate(expr or string)` → Promise of the reply, `evaluateWXF(bytes)` for encoded requests; `toReply` for decoded reply bytes; `imageURL` for pictures |
| `web/js-helpers.js` | helpers for JavaScript code: `W` (expressions such as `W.Sin(W.x)`), Wolfram Language text from templates, `toJS`, display text of any value; pure, also for Node |
| `web/js-runner.js` | module worker that runs the code of the test page's JavaScript mode (and of the examples page) |
| `web/page.js` | what both pages share: connecting, showing a reply (KaTeX, pictures, text), JavaScript runs in a worker with their checks and limits |
| `web/index.html` | test page served by the bridge, with Wolfram Language and JavaScript input: math typeset with KaTeX, plots and images as pictures |
| `web/examples.html`, `web/examples.js` | examples page for the JavaScript mode (`/examples.html`): 14 examples to run in place or open in the test page's editor |
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
// every reply also has raw (the decoded reply) and bytes (its WXF)
```

A symbol name without a context is a `System`` symbol in WXF: write variables as `sym('Global`x')`
(`sym('x')` is `System`x`, which the kernel does not have, so the request is refused as
`NotAllowed`; nothing stays behind, see Security). `socket.evaluateWXF(bytes)` sends a request that is already
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
  `Global`` (`W.x` is `Global`x`); `W['Global`A']` is a variable with a capital letter. `W.A` is
  `System`A`, which does not exist, so a request with it is refused (`NotAllowed`, with
  `System`A` in `symbols`) and leaves nothing behind: later requests with `A` work as before.
  Symbols are `WSymbol`s (`instanceof WSymbol`), so they encode and print like `sym(...)`.
- `wl(expr)` evaluates and resolves to the decoded result; a failure (`NotAllowed`, `Syntax`,
  `TimeLimit`...) rejects with a `WolframError` that has `failure`, `symbols` and `reply`.
  `wl.reply(expr)` resolves to the whole reply (`success`, `result`, `inputForm`, `messages`,
  `timing`, `tex`, `image`, `format`). As a tagged template, ``wl`Solve[${p} == 0, x]` `` is
  Wolfram Language text: the raw strings (so `\[Pi]` stays) with each value inserted as
  `(InputForm)`: numbers as Wolfram numbers (`1.*^-7`), strings as Wolfram strings (control
  characters as `\:0001`), expressions as their InputForm (a rule on the left of a rule in
  parentheses: `(1 -> 2) -> 3`). A value that cannot be sent (a function, `NaN`) rejects.
- `show(expr)` evaluates and shows the result in the run's entry exactly like the Wolfram mode
  (KaTeX, a picture, kernel messages, the meta line) and resolves to the result. A result of the
  same run that the code has not changed is shown from its reply without another evaluation (a
  plot's `Graphics` could not be sent back: it holds options outside the allowlist); one changed
  in place (`r.push(W.z)`) is evaluated as it is now.
- `console.log`, `info`, `debug`, `warn`, `error` write lines (warnings and errors in red);
  values are shown JSON-like (`2n`, `[Circular]`), Wolfram expressions as InputForm.
- Also there: `sym`, `fn`, `real`, `toInputForm`, `WSymbol`, `WFunction`, `WReal`, `WBigReal`,
  `WAssociation`, `WArray`, and `toJS(result)`: reals as numbers, `True`/`False`/`Null` as
  `true`/`false`/`null`, associations as objects (a `Map` when a key is not a string), packed
  arrays as nested arrays, lists element by element; other expressions unchanged.
- The returned value: nothing for `undefined`; a Wolfram expression (or an array holding one), or
  a result of the run, is shown like `show`, once (`return show(...)` does not show it twice);
  anything else as text. A failure of `show` (also of a returned value the kernel refuses, such as
  `return W.Grid(rows)`) is shown where the result would be, and not again as an uncaught error;
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
  evaluations of earlier runs`). At most 8 requests of all runs are in the kernel; a run's
  requests that were not sent yet are dropped with it, so Run and Stop again cannot pile up work.
- The worker runs in the page's process: code that uses up memory
  (`for (;;) a.push(new Array(1e6))`) crashes the whole tab within seconds, with its entries and
  drafts, and Stop cannot prevent that.
- Code that bypasses the helpers and posts messages to the page itself (`self.postMessage`) has
  its run ended when it sends too many or malformed ones (see Security).

### Examples page

`/examples.html` (with the same `?token=…`; linked from the test
page's header and after its JavaScript examples; the links between the two pages keep the query)
has 14 short examples of the JavaScript mode in six sections: expressions built with `W` and with
templates, a table from a loop, exact roots checked numerically, Newton's method with the
kernel's `D`, matrices from arrays, plots built with `W`, data computed in JavaScript and drawn by
the kernel (logistic map, Ulam spiral), big integers as `BigInt`, continued fractions, error
handling, and a loop that only Stop ends. The code lives in `web/examples.js`.

- Run shows the output under the example, exactly as the test page would (each run in a fresh
  worker, with the same checks and limits: `web/page.js` holds that code for both pages). One run
  at a time: the other Run buttons are disabled until it ends; running an example again replaces
  its output.
- Open in editor goes to `index.html?…#js=<code>`: the test page switches to JavaScript mode and
  puts the code in its editor without running it, then removes the fragment (a fragment is never
  sent to the server). A fragment that does not decode, or code longer than 20000 characters, is
  not loaded and a notice says so. Code from a link is never run by itself.

### The wasm module

`WXF.load()` loads `wxf.wasm`, the codec built for wasm32. It runs in every current browser and in
Node, and its 4 GiB of memory is far more than the bridge's limits need (8 MiB requests, 64 MiB
replies). The C code also builds for wasm64 (`make wasm64`, checked by `make test`), but `wxf.js`
loads only the wasm32 build and refuses another.

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
- **Symbols made by requests**: reading a request creates the symbols it names that do not exist
  yet. WXF reads a name without a context as a `System`` symbol (`sym('x')` is `System`x`, not
  the variable `x`) and takes any name in any context, even ones typed input cannot form
  (`a b`, `*`); typed input creates its symbols too (`System`foo`, `Foo`bar`). Left behind, a
  new `System`x` would change every later request on that kernel: typed `x` would mean the
  refused `System`x`, and `Global`x` would no longer decode. So the kernel collects the symbols
  created while a request is read (`$NewSymbol`): a request that created one outside `Global``
  is refused (`NotAllowed`, with the symbol in `Symbols`: a `System`` name the kernel does not
  have is not a variable), and every symbol created by a request that is refused or cannot be
  read is removed again, so the next request finds the kernel as it was. The new `Global``
  variables of a request that is evaluated are removed once its reply has been sent, so that
  distinct names do not pile up in the kernel's memory (which `MemoryConstrained` does not count);
  a symbol that has been given anything (attributes, values, messages) in the meantime is never
  removed. Reading stops at the 10001st new symbol of a request, which is then refused
  (`NotAllowed`): this bounds the work done outside the time limit, also for cleaning up.
  Context-less names are not reinterpreted as `Global``: that is not what WXF means, and keys of
  a WXF association cannot be rewritten without evaluating them. `Global`` symbols cannot shadow
  `System`` ones, which typed input finds first.
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
- **JavaScript mode**: the code runs in a module worker, without the DOM, the page, the socket or
  the token: the page sends it only the code and the wasm module's URL (neither the worker's nor
  the module's URL has the page's query), and the code's requests go through the allowlist like
  any other. The page takes every message of the worker as untrusted: types and sizes are
  checked, text is shown only as text, and the only results shown are replies that the page got
  from the kernel for that run (the worker names them by request id; the page keeps the last 64,
  up to 64 MiB beyond the newest 16), so TeX and pictures always come from the server, through
  KaTeX with the options above or as `<img>`. A run shows at most 1000 console lines (then a
  count of the dropped ones) and 50 results. Its requests are at most 8 MiB and 8 in flight (the
  worker queues the others), and at most 8 requests of all runs are in the kernel at once (Stop
  does not cancel those already sent). A run that sends a request beyond these limits, a
  malformed one, or more than 5000 other messages at once or 2000 a second is ended. The page
  terminates the worker on Stop and when the run ends, and drops its later messages and the
  replies to its requests. The worker shares the page's process: code that exhausts memory
  crashes the tab.
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
node tests/node_e2e.mjs        # 192 checks: codec and kernel round trips, a 96 MiB
                               # value, refusals (also in association keys and of box syntax in strings),
                               # picture limits, ordering;
                               # TeX of 44 varied results must render with the vendored KaTeX
                               # (throwOnError), Range[1500] within 5 s, plots must come back as SVG,
                               # an Image as PNG; js-helpers.js (W, templates with control characters
                               # and nested rules, toJS, value display, bounded InputForm) and
                               # expressions built with W (a refused W.A leaves the variable A
                               # working), evaluateWXF and toReply; the code of the examples page compiles
.venv/bin/python tests/smoke_ws.py   # 38 requests, text and WXF; replies carry TeX or a picture;
                                     # symbols that refused requests create are removed again
                                     # (context-less, odd and empty names, a cut-short WXF, the
                                     # 10000-symbol limit)
node tests/screenshots.mjs     # the test page in headless Chromium ($CHROME or chromium-headless):
                               # 12 evaluations, 36 JavaScript runs and the 14 examples of the examples
                               # page (85 checks): math
                               # typeset with KaTeX, Plot, Plot3D and ContourPlot pictures loaded, KaTeX
                               # fonts served by the bridge, nothing from other origins, no overflow at
                               # phone width (also with a 200-digit message), labelled input and live
                               # regions; JavaScript mode: wl, show, return values, console lines and
                               # their cap, errors with line numbers, refusals as rejections, templates,
                               # results changed in place, the cap of shown results, no DOM or token
                               # in the worker, which loads the codec itself, an endless loop stopped with the
                               # page responsive and the worker gone, Stop during kernel work, floods
                               # and malformed requests posted around the helpers (run ended, page
                               # responsive), drafts and remembered mode, a refused returned value shown
                               # once; examples page: every example run with its output checked (text,
                               # KaTeX, pictures), one run at a time, Stop of the endless one, Copy, Open
                               # in editor (code in the editor, not run; malformed and too long #js=
                               # links refused), no overflow at phone width; screenshots (light,
                               # light-full, dark, phone, js-light, js-dark, js-phone, examples-light,
                               # examples-full, examples-dark, examples-phone, examples-phone-results)
                               # in build/screenshots/
# with a server started with --time-limit 1 --memory-limit 200000000 --format-time-limit 2:
.venv/bin/python tests/limits_test.py   # limits then a working kernel, ten times (the memory cases pass
                                        # 200 MB in well under 0.1 s, before the time limit); an export
                                        # that runs out of time, then a Plot that comes with a picture
                                        # (twice; a Plot that runs out of format time on a loaded
                                        # machine is asked again, up to three times); each reply
                                        # may take 300 s, which covers a new kernel that does not
                                        # start and is replaced by the bridge
```

## Not supported

Compressed WXF (`8C:`) is refused, and there is no WSTP: the browser cannot open the raw TCP
connections WSTP needs, and the bridge speaks WXF instead.
