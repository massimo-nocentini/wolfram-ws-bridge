// Browser test of the test page: drives headless Chromium over the DevTools protocol, evaluates
// inputs through the page, checks the displayed results (math typeset with KaTeX, plots as loaded
// pictures) and that nothing overflows at phone width,
// and saves screenshots (light, light-full, dark, phone) to build/screenshots/; then repeats the evaluations
// with the wasm64 build (?wasm=64).
//   node tests/screenshots.mjs [page URL]     (default http://127.0.0.1:18000/?token=$WSBRIDGE_TOKEN)
// The browser is $CHROME, or chromium-headless from PATH. Needs a running server.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] || `http://127.0.0.1:18000/?token=${process.env.WSBRIDGE_TOKEN || 'testtoken'}`
const outDir = new URL('../build/screenshots/', import.meta.url).pathname
const chrome = process.env.CHROME || 'chromium-headless'

// input, then a check of the newest entry: { out (the InputForm text), katex (typeset math shown),
// img (natural width of the picture, 0 if none or not loaded), messages, error }
const math = (text, more = () => true) => e => e.katex && e.out === text && !e.img && more(e)
const picture = () => e => e.img > 0 && e.out === '' && e.alt === `Picture: ${e.input}` && !e.katex
const CASES = [
  ['Run["rm -rf ~"]', e => e.error.startsWith('NotAllowed') && e.error.includes('System`Run') && !e.katex],
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
    check(status.startsWith('Connected') && status.includes(`(${build})`), `${build}: page connects to the bridge`, status)
    if (!status.startsWith('Connected')) throw new Error('not connected')
  }
  const evaluateCases = async build => {
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

  await view(1100, 900, false)
  await open(url + (url.includes('?') ? '&' : '?') + 'wasm=64', 'wasm64')
  await evaluateCases('wasm64')
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
