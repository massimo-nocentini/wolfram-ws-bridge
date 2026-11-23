// Browser test of the test page: drives headless Chromium over the DevTools protocol, evaluates
// inputs through the page, checks the displayed results and that nothing overflows at phone width,
// and saves screenshots (light, dark, phone) to build/screenshots/.
//   node tests/screenshots.mjs [page URL]     (default http://127.0.0.1:18000/?token=$WSBRIDGE_TOKEN)
// The browser is $CHROME, or chromium-headless from PATH. Needs a running server.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] || `http://127.0.0.1:18000/?token=${process.env.WSBRIDGE_TOKEN || 'testtoken'}`
const outDir = new URL('../build/screenshots/', import.meta.url).pathname
const chrome = process.env.CHROME || 'chromium-headless'

// input, then a check of the newest entry's texts: { out, messages, error }
const CASES = [
  ['Run["rm -rf ~"]', e => e.error.startsWith('NotAllowed') && e.error.includes('System`Run')],
  ['Series[Exp[x] Sin[x], {x, 0, 6}]', e => e.out === 'SeriesData[x, 0, {1, 1, 1/3, 0, -1/30, -1/90}, 1, 7, 1]'],
  ['1/0', e => e.out === 'ComplexInfinity' && e.messages.length === 1 && e.messages[0].startsWith('Power::infy')],
  ['N[Pi, 50]', e => e.out.startsWith('3.14159265358979323846264338327950288419716939937510')],
  ['Solve[x^3 - 6 x^2 + 11 x - 6 == 0, x]', e => e.out === '{{x -> 1}, {x -> 2}, {x -> 3}}'],
  ["DSolve[y''[t] + y[t] == 0, y[t], t]", e => e.out === '{{y[t] -> C[1]*Cos[t] + C[2]*Sin[t]}}'],
  ['Integrate[x^2 Sin[x], x]', e => e.out === '-((-2 + x^2)*Cos[x]) + 2*x*Sin[x]'],
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
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  }

  await mkdir(outDir, { recursive: true })
  await send('Page.enable')
  await send('Runtime.enable')
  await view(1100, 900, false)
  await send('Page.navigate', { url })
  let status = ''
  for (let i = 0; i < 200 && !status.startsWith('Connected'); i++) {
    await sleep(100)
    status = (await js(`document.getElementById('status')?.textContent`)) || ''
  }
  check(status.startsWith('Connected'), 'page connects to the bridge', status)
  if (!status.startsWith('Connected')) throw new Error('not connected')

  for (const [input, test] of CASES) {
    const before = await js(`document.querySelectorAll('.entry').length`)
    await js(`(() => { document.getElementById('input').value = ${JSON.stringify(input)}; document.getElementById('go').click() })()`)
    for (let i = 0; i < 600 && (await js(`document.querySelectorAll('.entry').length`)) === before; i++) await sleep(50)
    const entry = await js(`(() => {
      const e = document.querySelector('.entry'), text = s => e.querySelector(s)?.textContent || ''
      return { input: text('.in'), out: text('.out:not(.err)'), error: text('.err'),
               messages: [...e.querySelectorAll('.msg')].map(m => m.textContent) }
    })()`)
    check(entry.input === input && test(entry), input, JSON.stringify(entry))
  }

  await shot('light')
  await view(1100, 900, true)
  await shot('dark')
  await view(390, 844, false)
  // compare with clientWidth (the 390 px layout width): a mobile viewport zooms out to fit
  // overflowing content, so innerWidth grows with the page and would hide the overflow
  const width = await js(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`)
  check(width[0] <= width[1], 'no horizontal scrolling at 390 px', `page is ${width[0]} px wide in a ${width[1]} px viewport`)
  await shot('phone')
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
