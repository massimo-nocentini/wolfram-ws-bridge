// End-to-end test of web/wxf.js + web/wolfram-socket.js against a running bridge, run once with
// web/wxf.wasm (wasm32) and once with web/wxf64.wasm (wasm64). The TeX of results must render with
// the vendored KaTeX (web/vendor/katex), and graphics must come back as pictures.
//   node tests/node_e2e.mjs [ws://127.0.0.1:18000/ws?token=...]   (token defaults to $WSBRIDGE_TOKEN)
import { resolveObjectURL } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { WXF, WArray, WAssociation, WBigReal, fn, real, sym, toInputForm } from '../web/wxf.js'
import { WolframSocket, imageURL } from '../web/wolfram-socket.js'

const katex = createRequire(import.meta.url)('../web/vendor/katex/katex.min.js')

const url = process.argv[2] || `ws://127.0.0.1:18000/ws?token=${process.env.WSBRIDGE_TOKEN || 'testtoken'}`
let failed = 0, prefix = ''
const check = (ok, label, detail = '') => {
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', prefix + label, detail)
}

const values = [
  0, -1, 127, 128, -129, 40000, 2 ** 31, -(2 ** 53), 2n ** 63n - 1n, -(2n ** 63n), 10n ** 40n, -(10n ** 40n),
  real(0.1), real(-2.5e300), real(3), new WBigReal('3.14159265358979323846264338327950288`35.'),
  '', 'héllo ∫ 😀', 'x'.repeat(1000), sym('Pi'), sym('Global`x'), [], [1, [2, [3]]],
  fn('Integrate', fn('Sin', sym('Global`x')), sym('Global`x')), fn(fn('Derivative', 1), sym('Sin')),
  new Uint8Array([0, 1, 255]), new WAssociation([['a', 1, false], [sym('Global`b'), [2], true]]),
  new WArray(false, 'Real64', [2, 3], new Float64Array([1, 2, 3, 4, 5, 6])),
  new WArray(false, 'Integer64', [2], new BigInt64Array([-(2n ** 40n), 5n])),
  new WArray(true, 'UnsignedInteger8', [3], new Uint8Array([1, 2, 250])),
  new WArray(false, 'ComplexReal64', [2], new Float64Array([1, 2, 3, -4])),
]

async function suite(file) {
prefix = file.replace('.wasm', '') + ': '
const wxf = await WXF.load(await readFile(new URL(`../web/${file}`, import.meta.url)))
check(wxf.wasm64 === file.includes('64'), `module is ${wxf.wasm64 ? 'wasm64' : 'wasm32'}`)

// 1. local round trips through the wasm codec
for (const v of values) {
  const back = wxf.decode(wxf.encode(v))
  check(isDeepStrictEqual(back, v), `local round trip ${toInputForm(v).slice(0, 60)}`)
}
for (const [bytes, label] of [[[0x38, 0x3a, 0x66, 5], 'truncated'], [[0x38, 0x43, 0x3a], 'compressed'], [[0x31, 0x3a], 'bad header'], [[0x38, 0x3a, 0x43, 1, 0x43, 2], 'trailing data']]) {
  let threw = false
  try { wxf.decode(new Uint8Array(bytes)) } catch { threw = true }
  check(threw, `rejects ${label} input`)
}
// a large value makes the memory grow well past its initial size
const big = new Uint8Array(96 * 1024 * 1024).map((_, i) => i * 7)
check(isDeepStrictEqual(wxf.decode(wxf.encode(big)), big), 'local round trip of a 96 MiB ByteArray')

// 2. the same values sent to the kernel inside Hold[...] must come back unchanged
const socket = await WolframSocket.open(url, wxf)
for (const v of values) {
  const reply = await socket.evaluate(fn('Hold', v))
  const same = reply.success && isDeepStrictEqual(reply.result, fn('Hold', v))
  check(same, `kernel round trip ${toInputForm(v).slice(0, 60)}`,
    same ? '' : JSON.stringify(reply, (k, x) => typeof x === 'bigint' ? x.toString() : x).slice(0, 300))
}

// 3. evaluation, messages and refusals
const expect = async (input, test, label) => {
  const reply = await socket.evaluate(input)
  check(test(reply), label || (typeof input === 'string' ? input : toInputForm(input)),
    reply.success ? `-> ${reply.inputForm}` : `-> ${reply.failure}: ${reply.message} ${reply.symbols.join(' ')}`)
}
await expect('D[Sin[x]^2, x]', r => r.success && r.inputForm === '2*Cos[x]*Sin[x]')
await expect(fn('Factor', fn('Plus', fn('Power', sym('Global`x'), 4), -1)), r => r.success && r.inputForm === '(-1 + x)*(1 + x)*(1 + x^2)')
for (let i = 0; i < 5; i++) await expect('1/0', r => r.success && r.messages.length === 1 && r.messages[0].startsWith('Power::infy'), `1/0 message still shown (${i + 1})`)
await expect('Eigenvalues[{{2, 1}, {1, 2}}]', r => r.success && isDeepStrictEqual(r.result, [3, 1]))
await expect('N[Pi, 30]', r => r.success && r.result instanceof WBigReal)
await expect(fn('Run', 'id'), r => !r.success && r.failure === 'NotAllowed' && r.symbols.includes('System`Run'))
await expect('ReadList["/etc/passwd"]', r => !r.success && r.failure === 'NotAllowed')
await expect('Symbol["Ru" <> "n"]["id"]', r => !r.success && r.failure === 'NotAllowed')
await expect(fn('Plus', 1, sym('Developer`ToPackedArray')), r => !r.success && r.failure === 'NotAllowed', 'symbols outside System`/Global` are refused')
await expect('f[x_] := x', r => !r.success && r.failure === 'NotAllowed')
await expect('Integrate[', r => !r.success && r.failure === 'Syntax')
// symbols in the keys of a WXF association, which is an atom in the kernel; Normal would run them
const runKey = new WAssociation([[fn('Run', 'id'), 1, false]])
await expect(runKey, r => !r.success && r.failure === 'NotAllowed' && r.symbols.includes('System`Run'), 'Run in an association key is refused')
await expect(fn('Normal', runKey), r => !r.success && r.failure === 'NotAllowed' && r.symbols.includes('System`Run'), 'Normal of an association with a Run key is refused')
await expect(fn('Normal', new WAssociation([['a', new WAssociation([[fn('Run', 'id'), 2, false]]), false]])),
  r => !r.success && r.failure === 'NotAllowed' && r.symbols.includes('System`Run'), 'Run in a key of an inner association is refused')
// box syntax in strings, which the front end would read when it draws a label: as WXF, through
// escapes in typed input, and in association keys
const boxes = r => !r.success && r.failure === 'NotAllowed' && !r.image
await expect(fn('Graphics', fn('Text', '\\!\\(x\\)')), boxes, 'WXF string with box syntax is refused')
await expect('Graphics[Text["\\.5c!\\.5c(x\\.5c)"]]', boxes)
await expect('Graphics[{}, PlotLabel -> "\\:005c(x\\:005c)"]', boxes)
await expect(fn('Graphics', fn('Text', new WAssociation([['\\*RowBox[{}]', 1, false]]))), boxes, 'box syntax in an association key is refused')
await expect('ToString[x^2, StandardForm]', r => !r.success && r.failure === 'NotAllowed')
// the front end draws no graphics or text for Image during an evaluation, and no huge pictures
await expect('Image[Graphics[Disk[]]]', r => r.success && !r.image && r.messages.length === 1 && r.messages[0].startsWith('Image::wsbimage'))
await expect('Graphics[Disk[], ImageSize -> 10^5]', r => r.success && !r.image && r.inputForm === '-Graphics-')
await expect('{Graphics[], Range[10^5]}', r => r.success && !r.image && r.tex === undefined)
// a large result comes without the expression
await expect('RandomReal[1, {1500, 1500}]', r => r.success && r.result === undefined && r.inputForm === '-LargeResult-')
// 4. results for the page: TeX for math, which the vendored KaTeX must render without errors, and
// without traces of TeXForm's own failures (InputForm text, \unicode, contexts, placeholders)
const TEX = [
  ['1/3 + x/(y + 1)', '\\frac'],
  ['Sqrt[2] + CubeRoot[5] + Surd[x, 5]', '\\sqrt[5]{x}'],
  ['Inverse[{{a, b}, {c, d}}]', '\\begin{array}'],
  ['MatrixExp[{{0, 1}, {-1, 0}}]', '\\begin{array}'],
  ['Eigensystem[{{1, 2}, {3, 4}}]', '\\sqrt{33}'],
  ['Series[Exp[x] Sin[x], {x, 0, 6}]', 'O\\left(x^7\\right)'],
  ['Series[Sin[x]/x^3, {x, 0, 4}]', '\\frac{1}{x^2}'],
  ['BesselJ[n, x] + Gamma[z] + Zeta[s] + PolyGamma[1, x] + Hypergeometric2F1[a, b, c, x]', 'J_n(x)'],
  ['EllipticK[m] + LegendreP[n, x] + ProductLog[x] + Erf[x] + StirlingS1[n, k] + Binomial[n, k]', '\\binom{n}{k}'],
  ['Solve[x^5 - x + 1 == 0, x]', '\\operatorname{Root}\\left(1-x+x^5,\\,5\\right)'],
  ['Reduce[x^3 + x + 1 == 0, x]', '\\operatorname{Root}'],
  ['Root[#^3 - 2 &, 2]', '\\approx -0.629961-1.09112 i'],
  ['N[Pi, 50]', '3.1415926535897932384626433832795028841971693993751'],
  ['N[Exp[100], 40]', '\\times 10^{43}'],
  ['N[10^-30, 20]', '1.0000000000000000000\\times 10^{-30}'],
  ['{1 + 2 I, 3.5 - I, -1.5*^-7, 2.5*^-8 x}', '-1.5\\times 10^{-7}'],
  ['Piecewise[{{x^2, x < 0}, {Sin[x], x >= 0}}]', '\\begin{cases}'],
  ['Integrate[x^n, {x, 0, 1}]', '\\quad\\text{if }'],
  ['Integrate[1/(x^3 + 1), x]', '\\tan ^{-1}'],
  ["DSolve[y''[t] + y[t] == 0, y[t], t]", 'c_1'],
  ['Sum[1/n^2, {n, 1, Infinity}]', '\\frac{\\pi ^2}{6}'],
  ['D[f[x, y], x, y] + Derivative[2][g][x]', "g''(x)"],
  ['50!', '30414093201713378043612608166064768844377641568960512000000000000'],
  ['<|"a" -> 1, b -> {2, 3}|>', '\\langle|'],
  ['"50% & $5 # {x_1} ~ ^ \\\\ αβ∫ 😀"', '{\\char"222b}'],
  ['Function[x, x^2]', '\\mapsto'],
  ['Hold[Integrate[1/x, {x, 1.*^-10, 1}]]', '10^{-10}'],
  ['x \\[Element] Reals && a != b', '\\mathbb{R}'],
  ['1/0', '\\text{ComplexInfinity}'],
  // TeXForm's own output of these needed fixing: precedence around \approx and small reals,
  // arbitrary-precision 1e-5, lists of matrices, ConditionalExpression inside a function, RootSum
  ['Root[#^5 - # + 1 &, 1]^2 + 1', '1+(\\operatorname{Root}\\left(1-x+x^5,\\,1\\right)\\approx -1.1673)^2'],
  ['2 Root[#^5 - # + 1 &, 1]', '2 (\\operatorname{Root}'],
  ['(1.*^-7)^x', '\\left(1.\\times 10^{-7}\\right)^x'],
  ['2 x Complex[1.*^-7, 0.5]', '\\left(2.\\times 10^{-7}+1. i\\right) x'],
  ['x^2 /. x -> 1.*^-7 y', '\\left(1.\\times 10^{-14}\\right) y^2'],
  ['1.`20*^-5', '1.000000000000000000\\times 10^{-5}'],
  ['1.`5*^-5', '1.0000\\times 10^{-5}'],
  ['x + 1.`25*^-5', '\\times 10^{-5}+x'],
  ['Eigensystem[{{2, 1}, {1, 2}}]', '\\left\\{\\{3,1\\},\\left('],
  ['{IdentityMatrix[2], IdentityMatrix[2]}', '\\right),\\left('],
  ['f[Integrate[x^a, {x, 0, 1}]]', 'f(\\left(\\frac{1}{1+a}\\quad\\text{if }'],
  ['Integrate[1/(x^5 - x + 1), x]', '\\sum_{\\alpha:\\,1-\\alpha +\\alpha ^5=0}'],
  ['Piecewise[{{x^2, x < 0}, {Sin[x], 0 <= x < Pi}}, 0]', '0\\leq x<\\pi'],
  ['Interval[{1, 2}]', '\\text{Interval}'],
  ['<|"}\\\\rule{9em}{9em}\\\\text{" -> 1|>', '\\text{\\}\\textbackslash{}rule'],
]
for (const [input, part] of TEX) {
  const r = await socket.evaluate(input)
  let error = ''
  if (r.success && typeof r.tex === 'string') {
    try { katex.renderToString(r.tex, { displayMode: true, throwOnError: true, strict: 'ignore', trust: false, maxSize: 50, maxExpand: 1000 }) } catch (err) { error = err.message }
  }
  const clean = typeof r.tex === 'string' && !/\\unicode|\\grave|wsb-tex|`/.test(r.tex)
  const ok = r.success && clean && !error && r.tex.includes(part) && !r.image
  check(ok, `TeX of ${input}`, ok ? '' : error || (r.success ? `${r.tex}` : `${r.failure}: ${r.message}`))
}
// a long row is fast to typeset (TeXForm alone takes over 20 s for Range[1500])
const started = performance.now()
const long = await socket.evaluate('Range[1500]')
const took = performance.now() - started
check(long.success && long.tex?.startsWith('\\{1,2,3,') && took < 5000, 'TeX of Range[1500] within 5 s', `${Math.round(took)} ms`)

// pictures: graphics as SVG, raster images as PNG; imageURL makes a Blob of the right type
const picture = async (input, format, text, test = () => true) => {
  const r = await socket.evaluate(input)
  const data = r.image?.data
  const ok = r.success && r.tex === undefined && r.inputForm === text && r.image?.format === format &&
    (format === 'SVG' ? typeof data === 'string' && /^(<\?xml[^>]*>\s*)?<svg[\s>]/.test(data)
                      : data instanceof Uint8Array && isDeepStrictEqual([...data.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    test(r)
  check(ok, `${format} picture of ${input}`, ok ? `-> ${r.inputForm}, ${data.length} bytes` :
    r.success ? `${r.inputForm} ${r.image?.format} ${String(data).slice(0, 80)} tex=${r.tex}` : `${r.failure}: ${r.message}`)
  return r
}
const plot = await picture('Plot[Sin[x], {x, 0, 6}]', 'SVG', '-Graphics-', r => r.result.head.name === 'Graphics')
await picture('Plot3D[Sin[x y], {x, 0, 3}, {y, 0, 3}]', 'SVG', '-Graphics3D-')
await picture('ContourPlot[Sin[x y], {x, 0, 3}, {y, 0, 3}]', 'SVG', '-Graphics-',
  r => r.image.data.length < 1e6 && r.image.data.includes('data:image/png;base64,'))   // a dense mesh is sent as a PNG inside the SVG
await picture('Plot[{Sin[x], Cos[x]}, {x, 0, 6}, PlotLegends -> "Expressions"]', 'SVG', '-Graphics-', r => r.result.head.name === 'Legended')
await picture('{Plot[x, {x, 0, 1}], Plot[x^2, {x, 0, 1}]}', 'SVG', '{-Graphics-, -Graphics-}')
const image = await picture('Image[RandomReal[1, {20, 20}]]', 'PNG', '-Image-')
for (const r of [plot, image]) {
  const blob = r.image && resolveObjectURL(imageURL(r.image))
  const type = r.image?.format === 'SVG' ? 'image/svg+xml' : 'image/png'
  check(blob?.type === type && blob.size === new Blob([r.image.data]).size, `imageURL gives a ${type} Blob`)
}

// several requests in flight at once come back in order
const many = await Promise.all([1, 2, 3, 4, 5].map(n => socket.evaluate(`${n}^${n}`)))
check(isDeepStrictEqual(many.map(r => r.result), [1, 4, 27, 256, 3125]), 'pipelined requests answered in order')
socket.close()
return values.map(v => wxf.encode(v))
}

const bytes32 = await suite('wxf.wasm')
const bytes64 = await suite('wxf64.wasm')
prefix = ''
check(isDeepStrictEqual(bytes32, bytes64), 'wasm32 and wasm64 encode every value to the same bytes')
const wxf = await WXF.load(await readFile(new URL('../web/wxf.wasm', import.meta.url)))

// 4. a wrong token is refused
let refused = false
try { await WolframSocket.open(url.replace(/token=[^&]*/, 'token=wrong'), wxf) } catch { refused = true }
check(refused, 'wrong token refused')

console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
