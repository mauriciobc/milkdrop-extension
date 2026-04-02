const EPSILON = 0.00001;
/** Threshold for "zero" in logic (bor, band, if, bnot). Values with |x| <= this are false. */
const ZERO_THRESHOLD = 1e-6;

function safe(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

export const builtins = Object.freeze({
  // 1-arg math
  sin: (x) => safe(Math.sin(x)),
  cos: (x) => safe(Math.cos(x)),
  tan: (x) => safe(Math.tan(x)),
  asin: (x) => (x < -1 || x > 1) ? 0 : safe(Math.asin(x)),
  acos: (x) => (x < -1 || x > 1) ? 0 : safe(Math.acos(x)),
  atan: (x) => safe(Math.atan(x)),
  log: (x) => x > 0 ? Math.log(x) : 0,
  log10: (x) => x > 0 ? Math.log10(x) : 0,
  exp: (x) => safe(Math.exp(x)),
  sqrt: (x) => safe(Math.sqrt(Math.abs(x))),
  abs: (x) => safe(Math.abs(x)),
  floor: (x) => safe(Math.floor(x)),
  ceil: (x) => safe(Math.ceil(x)),
  int: (x) => safe(x >= 0 ? Math.floor(x) : Math.ceil(x)),
  sqr: (x) => safe(x * x),
  sign: (x) => x > 0 ? 1 : (x < 0 ? -1 : 0),
  bnot: (x) => {
    const v = Math.abs(x) <= ZERO_THRESHOLD ? 1 : 0;
    return safe(v);
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
  equal: (x, y) => (x === y) ? 1 : 0,
  above: (x, y) => x > y ? 1 : 0,
  below: (x, y) => x < y ? 1 : 0,
  bor: (x, y) => (Math.abs(x) > ZERO_THRESHOLD || Math.abs(y) > ZERO_THRESHOLD) ? 1 : 0,
  band: (x, y) => (Math.abs(x) > ZERO_THRESHOLD && Math.abs(y) > ZERO_THRESHOLD) ? 1 : 0,
  // Bitwise (2-arg)
  bitor: (x, y) => Math.floor(x) | Math.floor(y),
  bitand: (x, y) => Math.floor(x) & Math.floor(y),

  // 2-arg special
  sigmoid: (x, y) => {
    const t = 1 + Math.exp(-x * y);
    return Math.abs(t) > EPSILON ? 1 / t : 0;
  },
  // 3-arg
  if: (x, y, z) => Math.abs(x) > ZERO_THRESHOLD ? y : z,
  // Random
  rand: (x) => x < 1 ? safe(Math.random()) : Math.random() * safe(Math.floor(x)),
});

export { EPSILON, ZERO_THRESHOLD };