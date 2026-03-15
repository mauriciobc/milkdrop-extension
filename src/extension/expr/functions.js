const EPSILON = 0.00001;

function safe(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export const builtins = Object.freeze({
  // 1-arg math
  sin: (x) => safe(Math.sin(x)),
  cos: (x) => safe(Math.cos(x)),
  tan: (x) => safe(Math.tan(x)),
  asin: (x) => Math.asin(clamp(x, -1, 1)),
  acos: (x) => Math.acos(clamp(x, -1, 1)),
  atan: (x) => safe(Math.atan(x)),
  log: (x) => x > 0 ? Math.log(x) : 0,
  log10: (x) => x > 0 ? Math.log10(x) : 0,
  exp: (x) => safe(Math.exp(x)),
  sqrt: (x) => safe(Math.sqrt(Math.abs(x))),
  abs: (x) => safe(Math.abs(x)),
  floor: (x) => safe(Math.floor(x)),
  ceil: (x) => safe(Math.ceil(x)),
  int: (x) => safe(Math.floor(x)),
  sqr: (x) => safe(x * x),
  sign: (x) => x > 0 ? 1 : (x < 0 ? -1 : 0),
  bnot: (x) => {
    const v = Math.abs(x) < EPSILON ? 1 : 0;
    return safe(v); // Added safe() wrapper
  },
  invsqrt: (x) => {
    const v = Math.sqrt(Math.abs(x));
    return v > 0 ? 1 / v : 0;
  },
  // 2-arg math
  atan2: (y, x) => Number.isFinite(y) && Number.isFinite(x) ? Math.atan2(y, x) : 0,
  pow: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? safe(Math.pow(x, y)) : 0,
  min: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? Math.min(x, y) : 0,
  max: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? Math.max(x, y) : 0,
  mod: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? (y !== 0 ? x % y : 0) : 0,
  div: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? (y !== 0 ? x / y : 0) : 0,
  // Logic / comparison (2-arg)
  equal: (x, y) => Math.abs(x - y) < EPSILON ? 1 : 0,
  above: (x, y) => x > y ? 1 : 0,
  below: (x, y) => x < y ? 1 : 0,
  bor: (x, y) => (Math.abs(x) > EPSILON || Math.abs(y) > EPSILON) ? 1 : 0,
  band: (x, y) => (Math.abs(x) > EPSILON && Math.abs(y) > EPSILON) ? 1 : 0,
  // Bitwise (2-arg)
  bitor: (x, y) => Math.floor(x) | Math.floor(y),
  bitand: (x, y) => Math.floor(x) & Math.floor(y),

  // 2-arg special
  sigmoid: (x, y) => {
    const t = 1 + Math.exp(-x * y);
    return Math.abs(t) > EPSILON ? 1 / t : 0;
  },
  // 3-arg
  if: (x, y, z) => Math.abs(x) > EPSILON ? y : z,
  // Random
  rand: (x) => x < 1 ? safe(Math.random()) : Math.random() * safe(Math.floor(x)),
});

export { EPSILON };