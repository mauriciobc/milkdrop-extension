import { compile } from '../../../src/extension/expr/compiler.js';

export function run(assert) {
    // Helper: compile + run, return context
    function evalExpr(src, ctx = {}) {
        const fn = compile(src);
        fn(ctx);
        return ctx;
    }

    // Helper: approximate equality
    function approx(a, b, eps = 1e-6) {
        return Math.abs(a - b) < eps;
    }

    // --- Basic arithmetic ---
    {
        const ctx = evalExpr('x = 3 + 4');
        assert(ctx.x === 7, 'arith: 3 + 4 = 7');
    }
    {
        const ctx = evalExpr('x = 10 - 3');
        assert(ctx.x === 7, 'arith: 10 - 3 = 7');
    }
    {
        const ctx = evalExpr('x = 6 * 7');
        assert(ctx.x === 42, 'arith: 6 * 7 = 42');
    }
    {
        const ctx = evalExpr('x = 15 / 3');
        assert(ctx.x === 5, 'arith: 15 / 3 = 5');
    }
    {
        const ctx = evalExpr('x = 7 % 3');
        assert(ctx.x === 1, 'arith: 7 % 3 = 1');
    }
    {
        const ctx = evalExpr('x = 2 ^ 10');
        assert(ctx.x === 1024, 'arith: 2 ^ 10 = 1024');
    }

    // --- Variable read/write ---
    {
        const ctx = evalExpr('y = x * 2', { x: 5 });
        assert(ctx.y === 10, 'var: y = x * 2 where x=5 → y=10');
        assert(ctx.x === 5, 'var: x unchanged');
    }

    // --- Multi-statement with state ---
    {
        const ctx = { q1: 0 };
        evalExpr('q1 = q1 + 1; q2 = q1 * 2', ctx);
        assert(ctx.q1 === 1, 'multi: q1 = 1');
        assert(ctx.q2 === 2, 'multi: q2 = 2');
    }

    // --- Assignment to same var (accumulator) ---
    {
        const ctx = { x: 0 };
        const fn = compile('x = x + 1');
        fn(ctx); fn(ctx); fn(ctx);
        assert(ctx.x === 3, 'accum: x + 1 three times = 3');
    }

    // --- Unary negation ---
    {
        const ctx = evalExpr('x = -5');
        assert(ctx.x === -5, 'unary neg: -5');
    }
    {
        const ctx = evalExpr('x = -(3 + 4)');
        assert(ctx.x === -7, 'unary neg group: -(3+4) = -7');
    }

    // --- Comparison operators ---
    {
        const ctx = evalExpr('a = 3 == 3; b = 3 == 4');
        assert(ctx.a === 1, 'cmp: 3 == 3 → 1');
        assert(ctx.b === 0, 'cmp: 3 == 4 → 0');
    }
    {
        const ctx = evalExpr('a = 3 != 4; b = 3 != 3');
        assert(ctx.a === 1, 'cmp: 3 != 4 → 1');
        assert(ctx.b === 0, 'cmp: 3 != 3 → 0');
    }
    {
        const ctx = evalExpr('a = 5 > 3; b = 3 > 5');
        assert(ctx.a === 1, 'cmp: 5 > 3 → 1');
        assert(ctx.b === 0, 'cmp: 3 > 5 → 0');
    }
    {
        const ctx = evalExpr('a = 3 < 5; b = 5 < 3');
        assert(ctx.a === 1, 'cmp: 3 < 5 → 1');
        assert(ctx.b === 0, 'cmp: 5 < 3 → 0');
    }
    {
        const ctx = evalExpr('a = 3 >= 3; b = 3 <= 3');
        assert(ctx.a === 1, 'cmp: 3 >= 3 → 1');
        assert(ctx.b === 1, 'cmp: 3 <= 3 → 1');
    }

    // --- Logic operators ---
    {
        const ctx = evalExpr('a = 1 & 1; b = 1 & 0; c = 0 & 0');
        assert(ctx.a === 1, 'logic: 1 & 1 → 1');
        assert(ctx.b === 0, 'logic: 1 & 0 → 0');
        assert(ctx.c === 0, 'logic: 0 & 0 → 0');
    }
    {
        const ctx = evalExpr('a = 1 | 0; b = 0 | 0');
        assert(ctx.a === 1, 'logic: 1 | 0 → 1');
        assert(ctx.b === 0, 'logic: 0 | 0 → 0');
    }
    {
        const ctx = evalExpr('a = !0; b = !1; c = !0.5');
        assert(ctx.a === 1, 'logic: !0 → 1');
        assert(ctx.b === 0, 'logic: !1 → 0');
        assert(ctx.c === 0, 'logic: !0.5 → 0');
    }

    // ===== Built-in Functions =====

    // --- sin, cos, tan ---
    {
        const ctx = evalExpr('y = sin(0)');
        assert(approx(ctx.y, 0), 'fn: sin(0) ≈ 0');
    }
    {
        const ctx = evalExpr('y = cos(0)');
        assert(approx(ctx.y, 1), 'fn: cos(0) ≈ 1');
    }
    {
        const ctx = evalExpr('y = tan(0)');
        assert(approx(ctx.y, 0), 'fn: tan(0) ≈ 0');
    }

    // --- asin, acos, atan ---
    {
        const ctx = evalExpr('y = asin(1)');
        assert(approx(ctx.y, Math.PI / 2), 'fn: asin(1) ≈ π/2');
    }
    {
        const ctx = evalExpr('y = acos(1)');
        assert(approx(ctx.y, 0), 'fn: acos(1) ≈ 0');
    }
    {
        const ctx = evalExpr('y = atan(0)');
        assert(approx(ctx.y, 0), 'fn: atan(0) ≈ 0');
    }
    // asin/acos clamped to [-1, 1]
    {
        const ctx = evalExpr('y = asin(2)');
        assert(approx(ctx.y, Math.PI / 2), 'fn: asin(2) clamped → asin(1)');
    }
    {
        const ctx = evalExpr('y = acos(-2)');
        assert(approx(ctx.y, Math.PI), 'fn: acos(-2) clamped → acos(-1)');
    }

    // --- atan2 ---
    {
        const ctx = evalExpr('y = atan2(1, 0)');
        assert(approx(ctx.y, Math.PI / 2), 'fn: atan2(1,0) ≈ π/2');
    }

    // --- log, log10 ---
    {
        const ctx = evalExpr('y = log(1)');
        assert(approx(ctx.y, 0), 'fn: log(1) = 0');
    }
    {
        const ctx = evalExpr('y = log(0)');
        assert(ctx.y === 0, 'fn: log(0) = 0 (safe)');
    }
    {
        const ctx = evalExpr('y = log(-5)');
        assert(ctx.y === 0, 'fn: log(-5) = 0 (safe)');
    }
    {
        const ctx = evalExpr('y = log10(100)');
        assert(approx(ctx.y, 2), 'fn: log10(100) ≈ 2');
    }
    {
        const ctx = evalExpr('y = log10(0)');
        assert(ctx.y === 0, 'fn: log10(0) = 0 (safe)');
    }

    // --- exp ---
    {
        const ctx = evalExpr('y = exp(0)');
        assert(approx(ctx.y, 1), 'fn: exp(0) = 1');
    }
    {
        const ctx = evalExpr('y = exp(1)');
        assert(approx(ctx.y, Math.E), 'fn: exp(1) ≈ e');
    }

    // --- sqrt ---
    {
        const ctx = evalExpr('y = sqrt(9)');
        assert(approx(ctx.y, 3), 'fn: sqrt(9) = 3');
    }
    {
        const ctx = evalExpr('y = sqrt(-4)');
        assert(approx(ctx.y, 2), 'fn: sqrt(-4) = sqrt(abs(-4)) = 2');
    }

    // --- abs ---
    {
        const ctx = evalExpr('y = abs(-5)');
        assert(ctx.y === 5, 'fn: abs(-5) = 5');
    }
    {
        const ctx = evalExpr('y = abs(5)');
        assert(ctx.y === 5, 'fn: abs(5) = 5');
    }

    // --- sign ---
    {
        const ctx = evalExpr('a = sign(5); b = sign(-3); c = sign(0)');
        assert(ctx.a === 1, 'fn: sign(5) = 1');
        assert(ctx.b === -1, 'fn: sign(-3) = -1');
        assert(ctx.c === 0, 'fn: sign(0) = 0');
    }

    // --- floor, ceil, int ---
    {
        const ctx = evalExpr('a = floor(3.7); b = ceil(3.2); c = int(3.9)');
        assert(ctx.a === 3, 'fn: floor(3.7) = 3');
        assert(ctx.b === 4, 'fn: ceil(3.2) = 4');
        assert(ctx.c === 3, 'fn: int(3.9) = 3');
    }

    // --- sqr ---
    {
        const ctx = evalExpr('y = sqr(5)');
        assert(ctx.y === 25, 'fn: sqr(5) = 25');
    }
    {
        const ctx = evalExpr('y = sqr(-3)');
        assert(ctx.y === 9, 'fn: sqr(-3) = 9');
    }

    // --- bnot ---
    {
        const ctx = evalExpr('a = bnot(0); b = bnot(1); c = bnot(0.000005)');
        assert(ctx.a === 1, 'fn: bnot(0) = 1');
        assert(ctx.b === 0, 'fn: bnot(1) = 0');
        assert(ctx.c === 1, 'fn: bnot(tiny) = 1 (< EPSILON)');
    }

    // --- invsqrt ---
    {
        const ctx = evalExpr('y = invsqrt(4)');
        assert(approx(ctx.y, 0.5), 'fn: invsqrt(4) = 0.5');
    }

    // --- pow ---
    {
        const ctx = evalExpr('y = pow(2, 3)');
        assert(ctx.y === 8, 'fn: pow(2,3) = 8');
    }
    {
        // pow producing NaN → 0
        const ctx = evalExpr('y = pow(-1, 0.5)');
        assert(ctx.y === 0, 'fn: pow(-1,0.5) → NaN → 0');
    }

    // --- min, max ---
    {
        const ctx = evalExpr('a = min(3, 7); b = max(3, 7)');
        assert(ctx.a === 3, 'fn: min(3,7) = 3');
        assert(ctx.b === 7, 'fn: max(3,7) = 7');
    }

    // --- equal, above, below ---
    {
        const ctx = evalExpr('a = equal(5, 5); b = equal(5, 6)');
        assert(ctx.a === 1, 'fn: equal(5,5) = 1');
        assert(ctx.b === 0, 'fn: equal(5,6) = 0');
    }
    {
        const ctx = evalExpr('a = above(5, 3); b = above(3, 5)');
        assert(ctx.a === 1, 'fn: above(5,3) = 1');
        assert(ctx.b === 0, 'fn: above(3,5) = 0');
    }
    {
        const ctx = evalExpr('a = below(3, 5); b = below(5, 3)');
        assert(ctx.a === 1, 'fn: below(3,5) = 1');
        assert(ctx.b === 0, 'fn: below(5,3) = 0');
    }

    // --- bor, band ---
    {
        const ctx = evalExpr('a = bor(1, 0); b = bor(0, 0)');
        assert(ctx.a === 1, 'fn: bor(1,0) = 1');
        assert(ctx.b === 0, 'fn: bor(0,0) = 0');
    }
    {
        const ctx = evalExpr('a = band(1, 1); b = band(1, 0)');
        assert(ctx.a === 1, 'fn: band(1,1) = 1');
        assert(ctx.b === 0, 'fn: band(1,0) = 0');
    }

    // --- bitor, bitand ---
    {
        const ctx = evalExpr('a = bitor(5, 3)');
        assert(ctx.a === (5 | 3), 'fn: bitor(5,3) = 7');
    }
    {
        const ctx = evalExpr('a = bitand(5, 3)');
        assert(ctx.a === (5 & 3), 'fn: bitand(5,3) = 1');
    }

    // --- sigmoid ---
    {
        const ctx = evalExpr('y = sigmoid(0, 1)');
        assert(approx(ctx.y, 0.5), 'fn: sigmoid(0,1) ≈ 0.5');
    }

    // --- if (conditional) ---
    {
        const ctx = evalExpr('a = if(1, 10, 20); b = if(0, 10, 20)');
        assert(ctx.a === 10, 'fn: if(1, 10, 20) = 10');
        assert(ctx.b === 20, 'fn: if(0, 10, 20) = 20');
    }
    {
        // if with expression condition: equivalent to abs
        const ctx = evalExpr('y = if(above(x, 0), x, -x)', { x: -7 });
        assert(ctx.y === 7, 'fn: if(above(x,0), x, -x) with x=-7 → 7');
    }

    // --- rand ---
    {
        const ctx = evalExpr('y = rand(100)');
        assert(ctx.y >= 0 && ctx.y < 100, 'fn: rand(100) in [0,100)');
    }
    {
        const ctx = evalExpr('y = rand(0)');
        assert(ctx.y >= 0 && ctx.y < 1, 'fn: rand(0) in [0,1)');
    }

    // --- mod (as function and operator) ---
    {
        const ctx = evalExpr('y = mod(7, 3)');
        assert(approx(ctx.y, 1), 'fn: mod(7,3) = 1');
    }

    // --- div (as function) ---
    {
        const ctx = evalExpr('y = div(10, 3)');
        assert(approx(ctx.y, 10 / 3), 'fn: div(10,3) ≈ 3.33');
    }
    {
        const ctx = evalExpr('y = div(5, 0)');
        assert(ctx.y === 0, 'fn: div(5,0) = 0 (safe)');
    }

    // ===== Safety semantics =====

    // --- Division by zero → 0 ---
    {
        const ctx = evalExpr('x = 5 / 0');
        assert(ctx.x === 0, 'safe: 5 / 0 = 0');
    }

    // --- Modulo by zero → 0 ---
    {
        const ctx = evalExpr('x = 5 % 0');
        assert(ctx.x === 0, 'safe: 5 % 0 = 0');
    }

    // --- NaN protection ---
    {
        const ctx = evalExpr('x = 0 / 0');
        assert(ctx.x === 0, 'safe: 0 / 0 = 0');
    }

    // --- Undefined variable reads as 0 ---
    {
        const ctx = evalExpr('y = x + 1');
        assert(ctx.y === 1, 'undef: undefined x reads as 0, y = 0 + 1 = 1');
    }

    // --- Complex preset expression ---
    {
        const ctx = { wave_r: 0.5, time: 1.0 };
        evalExpr('wave_r = wave_r + 0.400 * (0.60 * sin(0.900 * time) + 0.40 * sin(0.963 * time))', ctx);
        const expected = 0.5 + 0.400 * (0.60 * Math.sin(0.900) + 0.40 * Math.sin(0.963));
        assert(approx(ctx.wave_r, expected), 'preset expr: wave_r computation');
    }

    // --- Empty expression is safe ---
    {
        const fn = compile('');
        const ctx = {};
        fn(ctx);
        assert(true, 'empty: no crash');
    }

    // --- megabuf ---
    {
        const ctx = {};
        evalExpr('megabuf(0) = 42; y = megabuf(0)', ctx);
        assert(ctx.y === 42, 'megabuf: write and read index 0');
    }
    {
        const ctx = {};
        evalExpr('y = megabuf(5)', ctx);
        assert(ctx.y === 0, 'megabuf: uninitialized reads as 0');
    }

    // --- gmegabuf ---
    {
        const ctx = {};
        evalExpr('gmegabuf(10) = 99; y = gmegabuf(10)', ctx);
        assert(ctx.y === 99, 'gmegabuf: write and read');
    }
}
