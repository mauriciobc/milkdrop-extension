/**
 * MilkDrop 2 built-in function table.
 * Each function takes numeric arguments and returns a number.
 * Safety: no NaN or Infinity escapes — all edge cases return 0.
 * Pure JS — no GI imports.
 */

const EPSILON = 0.00001;

function safe(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export const builtins = Object.freeze({
    // 1-arg math
    sin:     (x) => Math.sin(x),
    cos:     (x) => Math.cos(x),
    tan:     (x) => safe(Math.tan(x)),
    asin:    (x) => Math.asin(clamp(x, -1, 1)),
    acos:    (x) => Math.acos(clamp(x, -1, 1)),
    atan:    (x) => Math.atan(x),
    log:     (x) => x > 0 ? Math.log(x) : 0,
    log10:   (x) => x > 0 ? Math.log10(x) : 0,
    exp:     (x) => safe(Math.exp(x)),
    sqrt:    (x) => Math.sqrt(Math.abs(x)),
    abs:     (x) => Math.abs(x),
    sign:    (x) => x > 0 ? 1 : x < 0 ? -1 : 0,
    floor:   (x) => Math.floor(x),
    ceil:    (x) => Math.ceil(x),
    int:     (x) => Math.floor(x),
    sqr:     (x) => x * x,
    bnot:    (x) => Math.abs(x) < EPSILON ? 1 : 0,
    invsqrt: (x) => { const v = Math.sqrt(Math.abs(x)); return v > 0 ? 1 / v : 0; },

    // 2-arg math
    atan2:  (y, x) => Math.atan2(y, x),
    pow:    (x, y) => safe(Math.pow(x, y)),
    min:    (x, y) => Math.min(x, y),
    max:    (x, y) => Math.max(x, y),
    mod:    (x, y) => y !== 0 ? x % y : 0,
    div:    (x, y) => y !== 0 ? x / y : 0,

    // Logic / comparison (2-arg)
    equal:  (x, y) => Math.abs(x - y) < EPSILON ? 1 : 0,
    above:  (x, y) => x > y ? 1 : 0,
    below:  (x, y) => x < y ? 1 : 0,
    bor:    (x, y) => (Math.abs(x) > EPSILON || Math.abs(y) > EPSILON) ? 1 : 0,
    band:   (x, y) => (Math.abs(x) > EPSILON && Math.abs(y) > EPSILON) ? 1 : 0,

    // Bitwise (2-arg)
    bitor:  (x, y) => Math.floor(x) | Math.floor(y),
    bitand: (x, y) => Math.floor(x) & Math.floor(y),

    // 2-arg special
    sigmoid: (x, y) => { const t = 1 + Math.exp(-x * y); return Math.abs(t) > EPSILON ? 1 / t : 0; },

    // 3-arg
    if: (x, y, z) => Math.abs(x) > EPSILON ? y : z,

    // Random
    rand: (x) => x < 1 ? Math.random() : Math.random() * Math.floor(x),
});

export { EPSILON };
