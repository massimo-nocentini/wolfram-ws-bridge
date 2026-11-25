// Browser test of the test page: drives headless Chromium over the DevTools protocol, evaluates
// inputs through the page, checks the displayed results (math typeset with KaTeX, plots as loaded
// pictures) and that nothing overflows at phone width,
// and saves screenshots (light, light-full, dark, phone) to build/screenshots/; then runs JavaScript-mode
// code (results, pictures, console lines, errors, Stop, the worker) and saves screenshots of that mode (js-light, js-dark, js-phone). The examples page
// (examples.html): every example run with its output checked, Stop, "Open in editor" (the code
// in the test page's editor, not run; bad #js= links refused), screenshots (examples-light,
// examples-full, examples-dark, examples-phone).
//   node tests/screenshots.mjs [page URL]     (default http://127.0.0.1:18000/?token=$WSBRIDGE_TOKEN)
// The browser is $CHROME, or chromium-headless from PATH. Needs a running server.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECTIONS } from '../web/examples.js'

const url = process.argv[2] || `http://127.0.0.1:18000/?token=${process.env.WSBRIDGE_TOKEN || 'testtoken'}`
const outDir = new URL('../build/screenshots/', import.meta.url).pathname
const chrome = process.env.CHROME || 'chromium-headless'

// input, then a check of the newest entry: { out (the InputForm text), katex (typeset math shown),
// img (natural width of the picture, 0 if none or not loaded), messages, error }
const math = (text, more = () => true) => e => e.katex && e.out === text && !e.img && more(e)
const picture = () => e => e.img > 0 && e.out === '' && e.alt === `Picture: ${e.input}` && !e.katex
const CASES = [
  ['Integrate[', e => e.error.startsWith('Syntax:') && !e.katex],
  ['Series[Exp[x] Sin[x], {x, 0, 6}]', math('SeriesData[x, 0, {1, 1, 1/3, 0, -1/30, -1/90}, 1, 7, 1]')],
  ['1/0', math('ComplexInfinity', e => e.messages.length === 1 && e.messages[0].startsWith('Power::infy'))],
  // a message with a 200-digit number must wrap, not widen the page (checked at 390 px below)
  ['0^(-10^200)', math('ComplexInfinity', e => e.messages.length === 1 && e.messages[0].length > 200)],
  ['N[Pi, 50]', e => e.katex && e.out.startsWith('3.14159265358979323846264338327950288419716939937510')],
  ['Solve[x^3 - 6 x^2 + 11 x - 6 == 0, x]', math('{{x -> 1}, {x -> 2}, {x -> 3}}')],
  ["DSolve[y''[t] + y[t] == 0, y[t], t]", math('{{y[t] -> C[1]*Cos[t] + C[2]*Sin[t]}}')],
  ['Expand[(x + y)^25]', e => e.katex && e.out.startsWith('x^25 + 25*x^24*y')],   // wider than a phone
  ['Integrate[x^2 Sin[x], x]', math('-((-2 + x^2)*Cos[x]) + 2*x*Sin[x]')],
  ['ContourPlot[Sin[x y], {x, 0, 3}, {y, 0, 3}]', picture()],   // a PNG inside an SVG
  ['Plot[Sin[x], {x, 0, 6}]', picture()],
  ['Plot3D[Sin[x y], {x, 0, 3}, {y, 0, 3}]', picture()],
]

// JavaScript mode: code, then a check of the run's entry: { state ('done', 'stopped'...), lines
// ([class, text] of its output lines), katex (typeset results), shown (their InputForm text),
// imgs (natural widths of its pictures), alts, meta }
const lines = (...expected) => e => JSON.stringify(e.lines) === JSON.stringify(expected)
const JS_CASES = [
  // wl, then a returned expression: evaluated and typeset like a Wolfram-mode result
  ["const r = await wl('Integrate[x^2 Sin[x], x]')\nreturn W.Simplify(W.D(r, W.x))",
    e => e.katex === 1 && e.shown[0] === 'x^2*Sin[x]' && e.lines.length === 0 && e.meta.startsWith('2 kernel evaluations ·')],
  // a result of the run is returned as it came, without another evaluation
  ["return wl('Expand[(x + 1)^2]')", e => e.katex === 1 && e.shown[0] === '1 + 2*x + x^2' && e.meta.startsWith('1 kernel evaluation ·')],
  ["const p = await show('Plot[Sin[x], {x, 0, 6}]')\nreturn p.head.name",
    e => e.imgs.length === 1 && e.imgs[0] > 0 && e.alts[0] === 'Picture: Plot[Sin[x], {x, 0, 6}]' && lines(['out result', 'Graphics'])(e)],
  ["console.log('a', 1, [2n, { b: W.x }])\nconsole.info(W.Sin(W.Times(2, W.x)))\nconsole.warn('careful')\nconsole.error(new Error('bad'))",
    lines(['out', 'a 1 [2n, {b: x}]'], ['out', 'Sin[Times[2, x]]'], ['msg', 'careful'], ['msg', 'Error: bad'])],
  ["await wl('1 + 1')\nthrow new TypeError('nope')", lines(['out err', 'Uncaught TypeError: nope (line 2)'])],
  ["await Promise.resolve()\nnull.x", e => e.lines.length === 1 && e.lines[0][0] === 'out err' && e.lines[0][1].startsWith('Uncaught TypeError:') && e.lines[0][1].endsWith('(line 2)')],
  ["return (", e => e.lines.length === 1 && e.lines[0][0] === 'out err' && e.lines[0][1].startsWith('Uncaught SyntaxError:')],
  // a rejection that the code does not wait for is shown, and the run goes on
  ["wl('Integrate[')\nreturn await wl('1 + 1')", lines(['msg', 'Uncaught (in promise) WolframError: Syntax: The input could not be parsed. (line 1)'], ['out result', '2'])],
  // a failure reaches the code as a rejection
  ["try {\n  await wl('Integrate[')\n} catch (err) {\n  return [err.name, err.failure].join(' ')\n}", lines(['out result', 'WolframError Syntax'])],
  ["const ok = await wl('2 + 2')\nawait wl(W.Abort())", lines(['out err', 'Uncaught WolframError: Aborted: The evaluation was aborted. (line 2)'])],
  // the template tag: raw text (\\[Pi] stays), values inserted as InputForm in parentheses
  ["const p = W.Power(W.x, 2)\nconsole.log(await wl`Solve[${p} == ${4}, x]`)\nreturn wl`N[\\[Pi], ${20}]`",
    e => e.katex === 1 && e.shown[0].startsWith('3.14159265358979323846') && e.shown[0].endsWith('`20.') && JSON.stringify(e.lines[0]) === '["out","{{x -> -2}, {x -> 2}}"]'],
  ["return toJS(await wl('{1, 2.5, True, <|\"a\" -> Null|>, N[{{1, 2}, {3, 4}}]}'))", lines(['out result', '[1, 2.5, true, {a: null}, [[1, 2], [3, 4]]]'])],
  ["return [typeof (W.x * 2), typeof (W.x + 1)]", lines(['out result', '["number", "string"]'])],   // no operator translation
  // every console line, and long and nested values, are shown whole
  ["for (let i = 0; i < 5000; i++) console.log(i)", e => e.lines.length === 5000 && e.lines[4999][1] === '4999'],
  ["console.log('z'.repeat(50000))\nreturn Array(500).fill(7)", e => e.lines[0][1].length === 50000 && e.lines[1][1] === JSON.stringify(Array(500).fill(7)).replaceAll(',', ', ')],
  // a result changed in place is evaluated again; one that did not change is shown from its reply
  ["const r = await wl('{x, y}')\nr.push(W.z)\nreturn r", e => e.shown.length === 1 && e.shown[0] === '{x, y, z}' && e.meta.startsWith('2 kernel evaluations ·')],
  ["const r = await wl('{x, y}')\nr.reverse()\nawait show(r)", e => e.shown.length === 1 && e.shown[0] === '{y, x}' && e.meta.startsWith('2 kernel evaluations ·')],
  ["const p = await wl('Plot[Sin[x], {x, 0, 6}]')\nreturn p", e => e.imgs.length === 1 && e.imgs[0] > 0 && e.meta.startsWith('1 kernel evaluation ·')],
  // return show(...) shows the result once
  ["return show`Expand[(a + b)^${2}]`", e => e.katex === 1 && e.shown.length === 1 && e.shown[0] === 'a^2 + 2*a*b + b^2' && e.meta.startsWith('1 kernel evaluation ·')],
  // wl.reply rejects (does not throw) for a value without a WXF form
  ["const p = wl.reply(Symbol('s'))\nreturn await p.then(() => 'resolved', err => 'rejected: ' + err.message)",
    e => e.lines.length === 1 && e.lines[0][0] === 'out result' && e.lines[0][1].startsWith('rejected: ')],
  // templates: a rule on a rule's left side keeps its parentheses; control characters reach the kernel
  ["return [await wl`Part[${W.Rule(W.Rule(1, 2), 3)}, 1]`, (await wl`${'a\\u0001b'}`).length]", e => e.shown[0] === '{1 -> 2, 3}'],
  // a large request, and many results
  ["return (await wl(W.Length(new Uint8Array(9 * 1024 ** 2))))", lines(['out result', '9437184'])],
  ["const r = await wl('x^2')\nfor (let i = 0; i < 60; i++) await show(r)", e => e.katex === 60 && e.lines.length === 0 && e.meta.startsWith('1 kernel evaluation ·')],
  ["return await Promise.all(Array.from({ length: 40 }, (_, i) => wl(W.Plus(i, 1)))).then(a => a.at(-1))", e => lines(['out result', '40'])(e) && e.meta.startsWith('40 kernel evaluations ·')],
  // a returned value that fails: the failure shown once, where the result would be
  ["return W.Abort()", e => e.lines.length === 0 && e.shown.length === 1 && e.shown[0].startsWith('Aborted:')],
  ["await show(W.Abort())\nreturn 'not reached'", e => e.lines.length === 0 && e.shown.length === 1 && e.shown[0].startsWith('Aborted:')],
  // ... and a caught one is still an error for the code
  ["try {\n  await show(W.Abort())\n} catch (err) {\n  return err.failure\n}", e => lines(['out result', 'Aborted'])(e) && e.shown.length === 1],
  ["return W.Grid([[1, 2]])", e => e.shown.length === 1 && e.shown[0] === 'Grid[{{1, 2}}]'],
  // the page shows only replies it got from the kernel for the run, never bytes from the worker
  ["return await new Promise(resolve => {\n  self.addEventListener('message', e => { if (e.data.type === 'rendered' && e.data.id === -1) resolve(e.data.ok) })\n  self.postMessage({ type: 'render', id: -1, of: 1e6, bytes: new Uint8Array(64), label: 'fake' })\n})",
    e => lines(['out result', 'false'])(e) && e.shown.length === 0],
]

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', label, ok ? '' : detail)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const profile = await mkdtemp(join(tmpdir(), 'wsbridge-chrome-'))
const proc = spawn(chrome, ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] })
try {
  const browserUrl = await new Promise((resolve, reject) => {
    let log = ''
    proc.on('error', err => reject(new Error(`cannot run ${chrome}: ${err.message} (set CHROME)`)))
    proc.stderr.on('data', d => {
      log += d
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) resolve(m[1])
    })
    setTimeout(() => reject(new Error(`${chrome} did not start:\n${log}`)), 20000)
  })
  const targets = await (await fetch(`http://127.0.0.1:${new URL(browserUrl).port}/json`)).json()
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let lastId = 0
  const waiting = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++lastId
    waiting.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const js = async expression =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
  const view = async (width, height, dark) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 500 })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    await sleep(300)
  }
  const shot = async (name, fullPage = false) => {
    const size = fullPage && (await send('Page.getLayoutMetrics')).result.cssContentSize
    const r = await send('Page.captureScreenshot', fullPage
      ? { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } }
      : { format: 'png' })
    await writeFile(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  }

  await mkdir(outDir, { recursive: true })
  await send('Page.enable')
  await send('Runtime.enable')
  await view(1100, 900, false)
  const open = async (pageUrl, build) => {
    await send('Page.navigate', { url: pageUrl })
    let status = ''
    for (let i = 0; i < 200 && !status.startsWith('Connected'); i++) {
      await sleep(100)
      status = (await js(`document.getElementById('status')?.textContent`)) || ''
    }
    check(status.startsWith('Connected'), `${build}: page connects to the bridge`, status)
    if (!status.startsWith('Connected')) throw new Error('not connected')
  }
  const setMode = name => js(`document.querySelector('#modes [data-mode="${name}"]').click()`)
  const evaluateCases = async build => {
  await setMode('wl')
  for (const [input, test] of CASES) {
    const before = await js(`document.querySelectorAll('.entry').length`)
    await js(`(() => { document.getElementById('input').value = ${JSON.stringify(input)}; document.getElementById('go').click() })()`)
    for (let i = 0; i < 600 && (await js(`document.querySelectorAll('.entry').length`)) === before; i++) await sleep(50)
    // a picture loads asynchronously from its object URL
    for (let i = 0; i < 100 && (await js(`(() => { const i = document.querySelector('.entry img'); return !!i && !i.complete })()`)); i++) await sleep(50)
    const entry = await js(`(() => {
      const e = document.querySelector('.entry'), text = s => e.querySelector(s)?.textContent || ''
      const img = e.querySelector('.picture img')
      return { input: text('.in'), out: text('.code') || text('.out:not(.err)'), error: text('.err'),
               katex: !!e.querySelector('.math .katex'), img: img ? img.naturalWidth : 0, alt: img ? img.alt : '',
               messages: [...e.querySelectorAll('.msg')].map(m => m.textContent) }
    })()`)
    check(entry.input === input && test(entry), `${build}: ${input}`, JSON.stringify(entry))
  }
  }

  // a JavaScript run: waits until the newest entry is no longer running (or `wait` is false)
  const startJS = async code => {
    const before = await js(`document.querySelectorAll('.entry').length`)
    await js(`(() => { document.getElementById('input').value = ${JSON.stringify(code)}; document.getElementById('go').click() })()`)
    for (let i = 0; i < 100 && (await js(`document.querySelectorAll('.entry').length`)) === before; i++) await sleep(50)
  }
  const jsEntry = async () => {
    for (let i = 0; i < 1200 && (await js(`document.querySelector('.entry')?.dataset.state`)) === 'running'; i++) await sleep(50)
    for (let i = 0; i < 100 && (await js(`[...document.querySelectorAll('.entry:first-child img')].some(i => !i.complete)`)); i++) await sleep(50)
    return js(`(() => {
      const e = document.querySelector('.entry'), out = e.children[1]
      return { state: e.dataset.state, code: e.querySelector('.in').textContent,
               lines: [...out.children].filter(c => !c.classList.contains('shown')).map(c => [c.className, c.textContent]),
               katex: e.querySelectorAll('.shown .math .katex').length,
               shown: [...e.querySelectorAll('.shown .code, .shown .out')].map(c => c.textContent),
               imgs: [...e.querySelectorAll('.picture img')].map(i => i.naturalWidth), alts: [...e.querySelectorAll('.picture img')].map(i => i.alt),
               meta: e.lastElementChild.textContent }
    })()`)
  }
  const token = new URL(url).searchParams.get('token')
  const workers = async () => (await send('Target.getTargets')).result.targetInfos.filter(t => t.type === 'worker').length
  // a terminated worker's target goes away shortly after (about 2 s after a flood of messages)
  const workersLeft = async () => {
    let n = await workers()
    for (let i = 0; i < 100 && n; i++) { await sleep(50); n = await workers() }
    return n
  }
  const runCases = async build => {
    await setMode('js')
    for (const [code, test] of JS_CASES) {
      await startJS(code)
      const entry = await jsEntry()
      check(entry.code === code && entry.state === 'done' && test(entry), `${build}: JavaScript ${JSON.stringify(code).slice(1, 70)}`, JSON.stringify(entry).slice(0, 600))
    }
    // the code runs in a worker: no DOM, and nothing it can reach holds the token
    await startJS(`return JSON.stringify([typeof document, typeof window, location.href, self.name,
  performance.getEntriesByType('resource').map(r => r.name), Object.keys(self), typeof WebSocket])`)
    const isolated = await jsEntry()
    const seen = isolated.lines[0]?.[1] || ''
    // ... and loads the codec itself, from the page's relative URL
    const module = 'wxf.wasm'
    check(isolated.state === 'done' && seen.startsWith('["undefined","undefined","http') && seen.includes('js-runner.js') &&
      seen.includes(`/${module}"`) && !seen.includes(token),
      `${build}: JavaScript runs in a worker without the DOM or the token, with ${module}`, seen.slice(0, 400))
    // an endless loop: the page stays responsive, Stop ends the run, the next run works
    await startJS('let i = 0\nwhile (true) i++')
    await sleep(500)
    const started = performance.now()
    const during = await js(`[document.querySelector('.entry').dataset.state, document.getElementById('go').disabled, document.getElementById('stop').disabled]`)
    const responsive = performance.now() - started
    const running = await workers()
    check(JSON.stringify(during) === '["running",true,false]' && responsive < 1000 && running === 1,
      `${build}: page responsive during an endless loop, Evaluate disabled, Stop enabled`, `${JSON.stringify(during)} in ${Math.round(responsive)} ms, ${running} workers`)
    await js(`document.getElementById('stop').click()`)
    const stopped = await jsEntry()
    const after = await js(`[document.getElementById('go').disabled, document.getElementById('stop').disabled, document.activeElement.id]`)
    const left = await workersLeft()   // the worker is terminated, not left spinning
    check(stopped.state === 'stopped' && stopped.meta.startsWith('Stopped · 0 kernel evaluations') && JSON.stringify(after) === '[false,true,"input"]' && left === 0,
      `${build}: Stop ends the run and terminates its worker`, JSON.stringify([stopped, after, left]))
    await startJS('return 6 * 7')
    const next = await jsEntry()
    check(next.state === 'done' && lines(['out result', '42'])(next), `${build}: a run after Stop works`, JSON.stringify(next))
    // Stop during slow kernel requests: they finish in the kernel, but their replies do not reach
    // later runs; a later run waits for them, and the requests of a run stopped while waiting are
    // never sent (Run and Stop again cannot pile up work in the kernel)
    // (one slow request ahead of seven quick ones: the eight stay in the kernel for about a second)
    await startJS("await Promise.all([wl('Total[Table[Sin[N[i]], {i, 8 10^6}]]'), ...Array.from({ length: 7 }, () => wl('1'))])")
    await sleep(300)
    await js(`document.getElementById('stop').click()`)
    await jsEntry()
    await startJS("return await wl('1 + 1')")
    await sleep(100)
    const waitingMeta = await js(`document.querySelector('.entry').lastElementChild.textContent`)
    await js(`document.getElementById('stop').click()`)
    const dropped = await jsEntry()
    await startJS("return await wl('2 + 2')")
    const own = await jsEntry()
    check(/^Running… \(waiting for [1-8] evaluations? of earlier runs\)$/.test(waitingMeta) && dropped.meta.startsWith('Stopped · 0 kernel evaluations') &&
      own.state === 'done' && lines(['out result', '4'])(own) && own.meta.startsWith('1 kernel evaluation ·'),
      `${build}: after Stop, kernel replies go to no other run; requests not sent yet are dropped`, JSON.stringify([waitingMeta, dropped.meta, own]))
  }

  // ---- the examples page ----
  const examplesUrl = build => {
    const u = new URL('examples.html', url)
    u.search = new URL(url).search
    return u.href
  }
  // a card's run: like jsEntry, in the card's .result element
  const exampleRun = async id => {
    const sel = JSON.stringify(`#ex-${id} .result`)
    for (let i = 0; i < 1200 && (await js(`document.querySelector(${sel}).dataset.state`)) === 'running'; i++) await sleep(50)
    for (let i = 0; i < 100 && (await js(`[...document.querySelectorAll(${sel} + ' img')].some(i => !i.complete)`)); i++) await sleep(50)
    return js(`(() => {
      const e = document.querySelector(${sel}), out = e.firstElementChild
      return { state: e.dataset.state,
               lines: [...out.children].filter(c => !c.classList.contains('shown')).map(c => [c.className, c.textContent]),
               katex: e.querySelectorAll('.shown .math .katex').length,
               shown: [...e.querySelectorAll('.shown .code, .shown .out')].map(c => c.textContent),
               imgs: [...e.querySelectorAll('.picture img')].map(i => i.naturalWidth), alts: [...e.querySelectorAll('.picture img')].map(i => i.alt),
               meta: e.lastElementChild.textContent }
    })()`)
  }
  const EXAMPLES = SECTIONS.flatMap(s => s.examples)
  const runExamples = async build => {
    await open(examplesUrl(build), build)
    const layout = await js(`[document.querySelectorAll('.card').length, document.querySelectorAll('section h2').length,
      [...document.querySelectorAll('.card')].every(c => ['h3', 'p', 'pre code', '.copy', '.run', '.open'].every(q => c.querySelector(q))), document.querySelector('#back').getAttribute('href'),
      [...document.querySelectorAll('.run')].filter(b => !b.disabled).length]`)
    check(layout[0] === EXAMPLES.length && layout[0] >= 10 && layout[0] <= 14 && layout[1] === SECTIONS.length && layout[2] &&
      layout[3] === `index.html${new URL(examplesUrl(build)).search}` && layout[4] === layout[0],
      `${build}: examples page: ${EXAMPLES.length} cards in ${SECTIONS.length} sections, each with code, Copy, Run, Open in editor; link back keeps the query`, JSON.stringify(layout))
    // Copy: to the clipboard, or (without clipboard access) the code selected to copy by hand
    await js(`document.querySelector('#ex-roots .copy').click()`)
    await sleep(200)
    const copied = await js(`[document.querySelector('#ex-roots .copy').textContent, getSelection().toString()]`)
    const rootsCode = EXAMPLES.find(e => e.id === 'roots').code
    check(copied[0] === 'Copied' || (copied[0] === 'Selected' && copied[1].trim() === rootsCode), `${build}: Copy copies or selects the code`, JSON.stringify(copied).slice(0, 200))
    for (const example of EXAMPLES) {
      if (example.id === 'stop') continue
      await js(`document.querySelector('#ex-${example.id} .run').click()`)
      const run = await exampleRun(example.id)
      const errors = run.lines.filter(([cls]) => cls.includes('err'))
      check(run.state === 'done' && errors.length === 0 && EXAMPLE_CHECKS[example.id](run), `${build}: example ${example.id}`, JSON.stringify(run).slice(0, 700))
    }
    // the endless search: other Run buttons wait, the page stays responsive, Stop ends it
    await js(`document.querySelector('#ex-stop .run').click()`)
    await sleep(1500)
    const started = performance.now()
    const during = await js(`[document.querySelector('#ex-stop .result').dataset.state, document.querySelectorAll('#ex-stop .result .out').length,
      [...document.querySelectorAll('.run')].every(b => b.disabled), document.querySelector('#ex-stop .stop').hidden]`)
    const responsive = performance.now() - started
    await js(`document.querySelector('#ex-stop .stop').click()`)
    const stopped = await exampleRun('stop')
    const left = await workersLeft()
    const after = await js(`[[...document.querySelectorAll('.run')].every(b => !b.disabled), document.querySelector('#ex-stop .stop').hidden]`)
    check(during[0] === 'running' && during[1] >= 5 && during[2] && during[3] === false && responsive < 1000 &&
      stopped.state === 'stopped' && stopped.lines[1][1] === 'steps(3) = 7' && stopped.meta.startsWith('Stopped · 0 kernel evaluations') &&
      left === 0 && JSON.stringify(after) === '[true,true]',
      `${build}: example stop: Run buttons wait during the run, page responsive, Stop ends it and its worker`,
      JSON.stringify([during, Math.round(responsive), stopped.state, stopped.lines.slice(0, 3), stopped.meta, left, after]))
    // a run again replaces the card's output
    await js(`document.querySelector('#ex-templates .run').click()`)
    const again = await exampleRun('templates')
    check(again.state === 'done' && again.katex === 1 && again.lines.length === 2, `${build}: an example run again replaces its output`, JSON.stringify(again))

    // Open in editor: the test page in JavaScript mode with the code, not run
    const example = EXAMPLES.find(e => e.id === 'newton')
    const href = await js(`document.querySelector('#ex-newton .open').href`)
    const link = new URL(href)
    check(link.pathname === '/index.html' && link.search === new URL(examplesUrl(build)).search && link.hash === `#js=${encodeURIComponent(example.code)}`,
      `${build}: Open in editor links to the test page with the query and the code in the fragment`, href.slice(0, 200))
    await send('Page.navigate', { url: 'about:blank' })
    await open(href, build)
    await sleep(300)
    const editor = await js(`[document.querySelector('#modes [aria-pressed="true"]').dataset.mode, document.getElementById('input').value,
      document.querySelectorAll('.entry').length, location.hash, document.getElementById('notice').hidden, document.getElementById('go').textContent,
      document.getElementById('go').disabled]`)
    check(editor[0] === 'js' && editor[1] === example.code && editor[2] === 0 && editor[3] === '' && editor[4] && editor[5] === 'Run' && editor[6] === false,
      `${build}: Open in editor fills the JavaScript editor without running it, and drops the fragment`, JSON.stringify(editor).slice(0, 300))
    // a malformed link is refused with a notice; the editor keeps its text
    const base = `${new URL('index.html', url).href}${new URL(examplesUrl(build)).search}`
    for (const [fragment, expected, what] of [['#js=%E0%A4%A', 'malformed', 'that does not decode']]) {
      await send('Page.navigate', { url: 'about:blank' })
      await open(base + fragment, build)
      await sleep(300)
      const refused = await js(`[document.getElementById('notice').hidden, document.getElementById('notice').textContent, document.getElementById('input').value,
        document.querySelectorAll('.entry').length, location.hash]`)
      check(refused[0] === false && refused[1].includes(expected) && refused[3] === 0 && refused[4] === '',
        `${build}: a #js= link ${what} is refused with a notice`, JSON.stringify(refused).slice(0, 300))
    }
  }

  const EXAMPLE_CHECKS = {
    expressions: e => lines(['out', 'f = Times[Exp[Times[-1, x]], Sin[Times[3, x]]]'], ['out', "F' - f = 0"])(e) && e.katex === 1 &&
      e.shown[0] === '-1/10*(3*Cos[3*x] + Sin[3*x])/E^x' && e.meta.startsWith('2 kernel evaluations ·'),   // F shown from its reply
    templates: e => e.lines[0][1].startsWith('p = Plus[1, Times[6, x]') && e.lines[1][1] === 'coefficients [1, 6, 15, 20, 15, 6, 1] sum 64' &&
      e.katex === 1 && e.shown[0] === '(-1 + x)*(3 + x)*(3 + x^2)*(7 + 4*x + x^2)',
    'factor-table': e => e.lines.length === 0 && e.katex === 1 && e.shown[0].startsWith('{{2, (-1 + x)*(1 + x)}, {3, ') && e.shown[0].includes('{9, (-1 + x)*(1 + x + x^2)*(1 + x^3 + x^6)}'),
    roots: e => e.katex === 1 && e.shown[0] === '{-Sqrt[5 - 2*Sqrt[6]], Sqrt[5 - 2*Sqrt[6]], -Sqrt[5 + 2*Sqrt[6]], Sqrt[5 + 2*Sqrt[6]]}' &&
      e.lines.length === 4 && e.lines.every(([, t]) => /^x = +-?[03]\.\d{12} {3}p\(x\) = /.test(t) && Math.abs(Number(t.split('p(x) = ')[1])) < 1e-12),
    newton: e => e.lines[0][1] === "f'(x) = Plus[Times[-3, Power[x, 2]], Times[-1, Sin[x]]]" && e.lines.length === 7 && e.lines[5][1].startsWith('x5 = 0.865474033101614') &&
      e.katex === 1 && e.shown[0].startsWith('{x -> 0.86547403310161'),
    matrices: e => e.katex === 2 && e.shown[0] === '{{1, 1/2, 1/3, 1/4}, {1/2, 1/3, 1/4, 1/5}, {1/3, 1/4, 1/5, 1/6}, {1/4, 1/5, 1/6, 1/7}}' &&
      e.shown[1] === '{{16, -120, 240, -140}, {-120, 1200, -2700, 1680}, {240, -2700, 6480, -4200}, {-140, 1680, -4200, 2800}}' &&
      JSON.stringify(e.lines.map(l => l[1])) === '["1 / det = 6048000","eigenvalues 1.500e+0, 1.691e-1, 6.738e-3, 9.670e-5","condition number 15514"]',
    bessel: e => e.lines.length === 0 && e.imgs.length === 1 && e.imgs[0] > 0 && e.alts[0].startsWith('Picture: Plot[{BesselJ[0, x], BesselJ[1, x]'),
    surfaces: e => e.lines.length === 0 && e.imgs.length === 2 && e.imgs.every(w => w > 0) && e.alts[0].startsWith('Picture: ParametricPlot[') && e.alts[1].startsWith('Picture: Plot3D['),
    logistic: e => lines(['out', '32000 points'])(e) && e.imgs.length === 1 && e.imgs[0] > 0,
    ulam: e => lines(['out', '4236 primes up to 40401'])(e) && e.imgs.length === 1 && e.imgs[0] === 402 && e.alts[0].startsWith('Picture: Image[{{1, 1, '),
    fibonacci: e => lines(['out', 'F(200) = 280571172992510140037611932413038677189525'], ['out', 'the kernel agrees: true'])(e) &&
      e.katex === 1 && e.shown[0].startsWith('{{3, 1}, {5, 2}, {7, 1}, {11, 1}') && e.shown[0].endsWith('{5738108801, 1}}'),
    contfrac: e => e.lines.length === 13 && e.lines[0][1] === 'π = [3; 7, 15, 1, 292, 1, 1, 1, 2, 1, 3, 1]' && /^355\/113 +2\.7e-7$/.test(e.lines[4][1]) &&
      e.imgs.length === 1 && e.imgs[0] > 0,
    errors: e => e.lines.length === 4 && e.lines.slice(0, 2).every(([cls]) => cls === 'msg') && e.lines[0][1].startsWith('Syntax:') &&
      e.lines[1][1].startsWith('Aborted:') && e.lines[2][1] === '{ComplexInfinity, -Infinity}' && e.lines[3][1].startsWith('Power::infy'),
  }

  const examplesShots = async () => {
    await view(1100, 900, false)
    await open(examplesUrl('wasm32'), 'wasm32')
    for (const example of EXAMPLES) {
      if (example.id === 'stop') continue
      await js(`document.querySelector('#ex-${example.id} .run').click()`)
      await exampleRun(example.id)
    }
    await js('scrollTo(0, 0)')
    await shot('examples-light')
    await shot('examples-full', true)
    await view(1100, 900, true)
    await js(`document.getElementById('ex-bessel').scrollIntoView()`)
    await shot('examples-dark')
    await view(390, 844, false)
    await js('scrollTo(0, 0)')
    const width = await js(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`)
    check(width[0] <= width[1], 'examples page: no horizontal scrolling at 390 px (all examples run)', `page is ${width[0]} px wide in a ${width[1]} px viewport`)
    await shot('examples-phone')
    await js(`document.getElementById('ex-matrices').scrollIntoView()`)
    await shot('examples-phone-results')
    await view(1100, 900, false)
  }

  await open(url, 'wasm32')
  await evaluateCases('wasm32')
  // KaTeX and its fonts come from web/vendor/katex, not from a CDN
  const fonts = await js(`document.fonts.ready.then(() => [...document.fonts].filter(f => f.family.replace(/"/g, '') === 'KaTeX_Main' && f.status === 'loaded').length)`)
  check(fonts > 0, 'KaTeX fonts loaded from the bridge', `${fonts} KaTeX_Main faces loaded`)
  const external = await js(`performance.getEntriesByType('resource').map(r => r.name).filter(n => !n.startsWith(location.origin) && !n.startsWith('blob:'))`)
  check(external.length === 0, 'the page loads nothing from other origins', external.join(' '))
  // screen readers: a named input, announced status and results
  const a11y = await js(`[document.getElementById('input').getAttribute('aria-label'), document.getElementById('status').getAttribute('role'),
    document.getElementById('log').getAttribute('aria-live')]`)
  check(a11y[0] && a11y[1] === 'status' && a11y[2] === 'polite', 'input labelled, status and results announced', JSON.stringify(a11y))

  await shot('light')
  await shot('light-full', true)   // every entry, math included
  await view(1100, 900, true)
  await shot('dark')
  await view(390, 844, false)
  // compare with clientWidth (the 390 px layout width): a mobile viewport zooms out to fit
  // overflowing content, so innerWidth grows with the page and would hide the overflow
  const width = await js(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`)
  check(width[0] <= width[1], 'no horizontal scrolling at 390 px', `page is ${width[0]} px wide in a ${width[1]} px viewport`)
  await shot('phone')

  // the JavaScript mode: its own text, label, hint and examples; Stop shown only there
  await view(1100, 900, false)
  await js(`document.getElementById('input').value = 'Wolfram draft'`)
  await setMode('js')
  const jsMode = await js(`[document.getElementById('input').value, document.getElementById('input').getAttribute('aria-label'),
    document.querySelector('#modes [data-mode="js"]').getAttribute('aria-pressed'), document.querySelector('#modes [data-mode="wl"]').getAttribute('aria-pressed'),
    document.getElementById('stop').hidden, document.getElementById('hint').textContent, document.getElementById('examples').textContent,
    document.getElementById('go').textContent, document.getElementById('more-examples').getAttribute('href')]`)
  check(jsMode[0].startsWith('const x = W.x') && jsMode[1] === 'JavaScript input' && jsMode[2] === 'true' && jsMode[3] === 'false' &&
    jsMode[4] === false && jsMode[5].includes('wl(expr)') && jsMode[6].includes('endless loop') && jsMode[7] === 'Run' &&
    jsMode[8] === `examples.html${new URL(url).search}`,
    'JavaScript mode: own text, label, pressed state, Run and Stop, hint, examples and a link to more', JSON.stringify(jsMode))
  await runCases('wasm32')
  // each mode keeps its draft; the mode is remembered across a reload
  await js(`document.getElementById('input').value = 'return 1'`)
  await setMode('wl')
  const wlText = await js(`[document.getElementById('input').value, document.getElementById('stop').hidden, document.getElementById('input').getAttribute('aria-label'),
    document.getElementById('go').textContent]`)
  await setMode('js')
  const jsText = await js(`document.getElementById('input').value`)
  await open(url, 'wasm32')
  const remembered = await js(`[document.querySelector('#modes [aria-pressed="true"]').dataset.mode, document.getElementById('input').value.startsWith('const x = W.x')]`)
  check(JSON.stringify(wlText) === '["Wolfram draft",true,"Wolfram Language input","Evaluate"]' && jsText === 'return 1' && JSON.stringify(remembered) === '["js",true]',
    'modes keep their drafts (Evaluate in Wolfram mode), the mode is remembered', JSON.stringify([wlText, jsText, remembered]))
  // screenshots of the JavaScript mode, with a run of each kind
  for (const code of ["for (const n of [1, 2]) await show(`Plot[Sin[${n} x], {x, 0, 2 Pi}]`)\nreturn 'two plots'", JS_CASES[6][0], JS_CASES[4][0], JS_CASES[3][0], JS_CASES[0][0]]) {
    await startJS(code)
    await jsEntry()
  }
  await shot('js-light')
  await view(1100, 900, true)
  await shot('js-dark')
  await view(390, 844, false)
  const jsWidth = await js(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`)
  check(jsWidth[0] <= jsWidth[1], 'JavaScript mode: no horizontal scrolling at 390 px', `page is ${jsWidth[0]} px wide in a ${jsWidth[1]} px viewport`)
  await shot('js-phone')
  await runExamples('wasm32')
  await examplesShots()
  ws.close()
  console.log(`screenshots in ${outDir}`)
} catch (err) {
  failed++
  console.log('FAIL', err.message)
} finally {
  proc.kill('SIGKILL')
  await rm(profile, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
