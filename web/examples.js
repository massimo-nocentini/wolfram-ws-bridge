// The examples of examples.html: JavaScript-mode code (see README, "JavaScript mode of the test
// page"), grouped in sections. Each runs as it is on the test page, in a fresh worker. The browser
// test (tests/screenshots.mjs) runs every one of them by id and checks its output.

export const SECTIONS = [
  {
    title: 'Building expressions',
    text: 'Two ways to write what the kernel evaluates: expressions built with W, and Wolfram Language text with JavaScript values in it.',
    examples: [
      {
        id: 'expressions',
        title: 'Expressions with W',
        text: 'W.Sin(W.x) is the expression Sin[x]: plain JavaScript values that print as InputForm before anything is evaluated. ' +
          'A result of the run can be returned as it is, and is typeset from its reply without another evaluation.',
        code: `// W.name is a symbol, W.name(...) the expression name[...]
const x = W.x
const f = W.Times(W.Exp(W.Times(-1, x)), W.Sin(W.Times(3, x)))
console.log('f =', f)                    // not evaluated yet: just an expression
const F = await wl(W.Integrate(f, x))    // the kernel integrates
// check: the derivative of the antiderivative is f again
console.log("F' - f =", await wl(W.Simplify(W.Subtract(W.D(F, x), f))))
return F`,
      },
      {
        id: 'templates',
        title: 'Templates with JavaScript values',
        text: 'The wl`...` tag reads Wolfram Language text, so formulas stay readable, and inserts each ${value} as its InputForm in parentheses: ' +
          'numbers, arrays (as lists) and results of earlier requests. toJS turns a list of integers into a JavaScript array.',
        code: `const n = 6
const p = await wl\`Expand[(1 + x)^\${n}]\`
console.log('p =', p)
// a list of integers as a plain JS array
const c = toJS(await wl\`CoefficientList[\${p}, x]\`)
console.log('coefficients', c, 'sum', c.reduce((s, k) => s + k))
return wl\`Factor[\${p} - \${2 ** n}]\`    // (1 + x)^6 - 64`,
      },
    ],
  },
  {
    title: 'Symbolic and numeric together',
    text: 'The kernel does the exact mathematics; loops, bookkeeping and floating-point checks are ordinary JavaScript.',
    examples: [
      {
        id: 'factor-table',
        title: 'A table from a loop',
        text: 'One request per n, and the rows collected in a JavaScript array. A returned list of lists is typeset as a matrix: ' +
          'each n next to the factors of xⁿ − 1, the cyclotomic polynomials.',
        code: `const rows = []
for (let n = 2; n <= 9; n++) {
  const factors = await wl\`Factor[x^\${n} - 1]\`
  rows.push([n, factors])
}
return rows`,
      },
      {
        id: 'roots',
        title: 'Exact roots, checked in JavaScript',
        text: 'Solve gives the four roots of x⁴ − 10x² + 1 exactly, as nested radicals. N turns them into machine reals, ' +
          'toJS into JavaScript numbers, and a plain JavaScript function confirms they are roots.',
        code: `const p = x => x ** 4 - 10 * x ** 2 + 1
const roots = await show('x /. Solve[x^4 - 10 x^2 + 1 == 0, x]')
for (const r of toJS(await wl(W.N(roots)))) {
  console.log(\`x = \${r.toFixed(12).padStart(16)}   p(x) = \${p(r).toExponential(1)}\`)
}`,
      },
      {
        id: 'newton',
        title: "Newton's method",
        text: 'The kernel differentiates f(x) = cos x − x³ once; JavaScript runs the iteration, asking the kernel for f and f′ at each point. ' +
          'The steps shrink quadratically, and FindRoot agrees.',
        code: `const f = W.Subtract(W.Cos(W.x), W.Power(W.x, 3))
const df = await wl(W.D(f, W.x))
console.log("f'(x) =", df)
// f and f' at a JS number, as JS numbers
const at = async x => toJS(await wl(W.N(W.ReplaceAll([f, df], W.Rule(W.x, x)))))
let x = 1
for (let i = 1; i <= 6; i++) {
  const [fx, dfx] = await at(x)
  x -= fx / dfx
  console.log(\`x\${i} = \${x.toPrecision(16)}   step \${Math.abs(fx / dfx).toExponential(1)}\`)
}
return wl\`FindRoot[\${f}, {x, 1}]\``,
      },
      {
        id: 'matrices',
        title: 'Matrices from JavaScript arrays',
        text: 'An array of arrays is a matrix. Here the 4 × 4 Hilbert matrix with exact fractions: its inverse has integer entries, ' +
          'and its eigenvalues, as JavaScript numbers, show how badly conditioned it is.',
        code: `const n = 4
const h = Array.from({ length: n }, (_, i) =>
  Array.from({ length: n }, (_, j) => W.Rational(1, i + j + 1)))
await show(h)
await show(W.Inverse(h))
console.log('1 / det =', await wl(W.Divide(1, W.Det(h))))
const ev = toJS(await wl(W.Eigenvalues(W.N(h))))
console.log('eigenvalues', ev.map(v => v.toExponential(3)).join(', '))
console.log('condition number', Math.round(Math.max(...ev) / Math.min(...ev)))`,
      },
    ],
  },
  {
    title: 'Plots built with W',
    text: 'Plotting functions are allowlisted, and their results come back as pictures. JavaScript builds the list of curves or the options.',
    examples: [
      {
        id: 'bessel',
        title: 'A family of curves',
        text: 'Destructuring W gives names that read like Wolfram Language. Array.from builds the Bessel functions J₀ to J₄ for one Plot, ' +
          'and JavaScript strings label them in the legend.',
        code: `const { Plot, BesselJ, Rule, PlotLegends, x } = W
const curves = Array.from({ length: 5 }, (_, n) => BesselJ(n, x))
const labels = curves.map((_, n) => \`J\${n}(x)\`)
return Plot(curves, [x, 0, 20], Rule(PlotLegends, labels))`,
      },
      {
        id: 'surfaces',
        title: 'Curves and surfaces',
        text: 'A Lissajous curve with ParametricPlot, then a surface with Plot3D, whose picture comes as an SVG with a raster image inside.',
        code: `const { ParametricPlot, Plot3D, Sin, Cos, Times, Rule, Pi, t, x, y } = W
await show(ParametricPlot([Sin(Times(3, t)), Sin(Times(4, t))], [t, 0, Times(2, Pi)],
  Rule(W.PlotStyle, W.Thick)))
return Plot3D(Times(Sin(x), Cos(y)), [x, -3, 3], [y, -3, 3],
  Rule(W.ColorFunction, 'Rainbow'), Rule(W.Mesh, W.None))`,
      },
    ],
  },
  {
    title: 'Data from JavaScript, pictures from the kernel',
    text: 'Tight numeric loops are fast in JavaScript; the kernel turns the numbers into a picture.',
    examples: [
      {
        id: 'logistic',
        title: 'The logistic map',
        text: 'x ↦ r x (1 − x) iterated in JavaScript for 400 values of r, keeping the points where it settles: ' +
          'period doubling, then chaos. ListPlot draws the 32 000 points.',
        code: `const points = []
for (let i = 0; i < 400; i++) {
  const r = 2.8 + 1.2 * i / 400
  let x = 0.5
  for (let k = 0; k < 300; k++) x = r * x * (1 - x)   // let it settle
  for (let k = 0; k < 80; k++) {
    x = r * x * (1 - x)
    points.push([r, x])
  }
}
console.log(points.length, 'points')
return W.ListPlot(points, W.Rule(W.PlotStyle, W.Directive(W.PointSize(0.002), W.Opacity(0.4))),
  W.Rule(W.AxesLabel, ['r', 'x']))`,
      },
      {
        id: 'ulam',
        title: 'The Ulam spiral',
        text: 'JavaScript walks the integers along a square spiral and darkens the pixel of each prime; one PrimeQ request on Range[n] says which are. ' +
          'Image turns the array of pixels into a picture, where the primes crowd along diagonals.',
        code: `const size = 201, n = size * size
const prime = toJS(await wl\`PrimeQ[Range[\${n}]]\`)   // true or false for 1 ... n
const pixels = Array.from({ length: size }, () => Array(size).fill(1))
let x = 100, y = 100, dx = 1, dy = 0, k = 1
for (let len = 1; k <= n; len++) {
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < len && k <= n; i++, k++) {
      if (prime[k - 1]) pixels[y][x] = 0
      x += dx; y += dy
    }
    const turn = dx; dx = -dy; dy = turn
  }
}
console.log(prime.filter(Boolean).length, 'primes up to', n)
// twice the size: each number a 2 × 2 block of pixels
return W.Image(pixels.flatMap(row => { const r = row.flatMap(v => [v, v]); return [r, r] }))`,
      },
    ],
  },
  {
    title: 'Numbers',
    text: 'Integers beyond 2⁵³ arrive as BigInt and smaller ones as numbers; a BigInt goes to the kernel as an exact integer of any size.',
    examples: [
      {
        id: 'fibonacci',
        title: 'Big integers both ways',
        text: 'F(200) computed with JavaScript BigInt equals the kernel\'s Fibonacci[200]; ' +
          'the BigInt goes back into a template, where FactorInteger splits it into primes.',
        code: `let a = 0n, b = 1n
for (let i = 0; i < 200; i++) [a, b] = [b, a + b]
console.log(\`F(200) = \${a}\`)
const k = await wl(W.Fibonacci(200))
console.log('the kernel agrees:', BigInt(k) === a)   // a number below 2^53, a BigInt above
return wl\`FactorInteger[\${a}]\``,
      },
      {
        id: 'contfrac',
        title: 'Continued fractions of π',
        text: 'The kernel gives the continued fraction of π; JavaScript builds the convergents p/q with BigInt; ' +
          'one more request measures how close each is, and a log plot shows the error falling.',
        code: `const cf = toJS(await wl('ContinuedFraction[Pi, 12]')).map(BigInt)
console.log('π = [' + cf[0] + '; ' + cf.slice(1).join(', ') + ']')
// convergents p/q from the recurrence, exact with BigInt
const p = [1n, cf[0]], q = [0n, 1n]
for (const a of cf.slice(1)) {
  p.push(a * p.at(-1) + p.at(-2))
  q.push(a * q.at(-1) + q.at(-2))
}
const convergents = p.slice(1).map((pk, i) => W.Rational(pk, q[i + 1]))
const errors = toJS(await wl(W.N(W.Abs(W.Subtract(W.Pi, convergents)))))
errors.forEach((e, i) => console.log(\`\${p[i + 1]}/\${q[i + 1]}\`.padEnd(24), e.toExponential(1)))
return W.ListLogPlot(errors, W.Rule(W.PlotStyle, W.PointSize(W.Large)))`,
      },
    ],
  },
  {
    title: 'Errors and Stop',
    text: 'What the kernel refuses reaches the code as a rejection; code that never ends is stopped from the page.',
    examples: [
      {
        id: 'errors',
        title: 'Refusals, syntax errors and messages',
        text: 'Functions outside the allowlist and text that does not parse reject with a WolframError, which try/catch handles like any other error. ' +
          'Kernel messages come with a successful reply.',
        code: `for (const input of ['Run["ls"]', 'Integrate[x^2, x', 'Import["/etc/passwd"]']) {
  try {
    await wl(input)
  } catch (err) {
    console.warn(err.message)
  }
}
const r = await wl.reply('{1/0, Log[0]}')
console.log(r.inputForm)
for (const m of r.messages) console.log(m)`,
      },
      {
        id: 'stop',
        title: 'A search that never ends',
        text: 'A plain JavaScript loop that never returns: it prints each n whose Collatz sequence (n ↦ n/2 or 3n + 1) takes more steps to reach 1 ' +
          'than any smaller one. It runs in a worker, so the page stays responsive; press Stop to end it.',
        code: `let best = 0
for (let n = 1; ; n++) {
  let steps = 0
  for (let m = n; m !== 1; steps++) m = m % 2 ? 3 * m + 1 : m / 2
  if (steps > best) {
    best = steps
    console.log(\`steps(\${n}) = \${steps}\`)   // a new record
  }
}`,
      },
    ],
  },
]
