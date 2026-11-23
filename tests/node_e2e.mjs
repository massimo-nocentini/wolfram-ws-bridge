// End-to-end test of web/wxf.js + web/wxf.wasm + web/wolfram-socket.js against a running bridge.
//   node tests/node_e2e.mjs [ws://127.0.0.1:18000/ws?token=...]   (token defaults to $WSBRIDGE_TOKEN)
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { WXF, WArray, WAssociation, WBigReal, fn, real, sym, toInputForm } from '../web/wxf.js'
import { WolframSocket } from '../web/wolfram-socket.js'

const url = process.argv[2] || `ws://127.0.0.1:18000/ws?token=${process.env.WSBRIDGE_TOKEN || 'testtoken'}`
const wxf = await WXF.load(await readFile(new URL('../web/wxf.wasm', import.meta.url)))
let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', label, detail)
}

// 1. local round trips through the wasm codec
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
for (const v of values) {
  const back = wxf.decode(wxf.encode(v))
  check(isDeepStrictEqual(back, v), `local round trip ${toInputForm(v).slice(0, 60)}`)
}
for (const [bytes, label] of [[[0x38, 0x3a, 0x66, 5], 'truncated'], [[0x38, 0x43, 0x3a], 'compressed'], [[0x31, 0x3a], 'bad header'], [[0x38, 0x3a, 0x43, 1, 0x43, 2], 'trailing data']]) {
  let threw = false
  try { wxf.decode(new Uint8Array(bytes)) } catch { threw = true }
  check(threw, `rejects ${label} input`)
}

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
// several requests in flight at once come back in order
const many = await Promise.all([1, 2, 3, 4, 5].map(n => socket.evaluate(`${n}^${n}`)))
check(isDeepStrictEqual(many.map(r => r.result), [1, 4, 27, 256, 3125]), 'pipelined requests answered in order')
socket.close()

// 4. a wrong token is refused
let refused = false
try { await WolframSocket.open(url.replace(/token=[^&]*/, 'token=wrong'), wxf) } catch { refused = true }
check(refused, 'wrong token refused')

console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
