/**
 * Audio processing micro-benchmarks.
 *
 * Benchmarks spectrum parsing (regex path) and beat detection logic
 * without requiring a live GStreamer pipeline.
 */

// Re-implement the pure-computation functions from audio.js in isolation
// to benchmark them without needing Gst init or a pipeline.

const SPECTRUM_THRESHOLD_DB = -80;
const SPECTRUM_BANDS = 24;
const BEAT_NOISE_FLOOR = 0.02;
const BEAT_THRESHOLD_LOW = 1.2;
const BEAT_THRESHOLD_HIGH = 1.55;
const BEAT_THRESHOLD_VARIANCE_SLOPE = -15;
const FEATURE_SMOOTHING = 0.35;
const FEATURE_DECAY = 0.82;
const MAGNITUDE_REGEX = /magnitude=\((?:float|double)\)\{([^}]*)\}/;

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function normalizeDecibels(value, thresholdDb) {
    if (!Number.isFinite(value))
        return 0;
    return clamp01((value - thresholdDb) / Math.abs(thresholdDb));
}

function averageRange(values, start, end) {
    if (!values || values.length === 0 || end <= start)
        return 0;
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
        sum += values[i];
        count += 1;
    }
    return count > 0 ? sum / count : 0;
}

function average(values) {
    if (!values || values.length === 0)
        return 0;
    let sum = 0;
    for (let i = 0; i < values.length; i++)
        sum += values[i];
    return sum / values.length;
}

function parseSpectrumBandsFromString(structureString) {
    const match = MAGNITUDE_REGEX.exec(structureString);
    if (!match)
        return [];

    const values = [];
    const payload = match[1];
    let start = 0;
    for (let i = 0; i <= payload.length; i++) {
        if (i !== payload.length && payload[i] !== ',')
            continue;
        const parsed = Number.parseFloat(payload.slice(start, i));
        const normalized = normalizeDecibels(parsed, SPECTRUM_THRESHOLD_DB);
        if (Number.isFinite(normalized))
            values.push(normalized);
        start = i + 1;
    }
    return values;
}

// Generate a realistic GstStructure string with 24 bands
function makeSyntheticSpectrumString() {
    const bands = [];
    for (let i = 0; i < SPECTRUM_BANDS; i++)
        bands.push((-30 - Math.random() * 40).toFixed(1));
    return `spectrum, endtime=(guint64)50000000, timestamp=(guint64)100000000, stream-time=(guint64)100000000, magnitude=(float){${bands.join(', ')}}`;
}

// Simulate beat detection state
class BeatDetector {
    constructor(historySize = 20, cooldownFrames = 2) {
        this._historySize = historySize;
        this._cooldownFrames = cooldownFrames;
        this._energyHistory = new Float64Array(historySize);
        this._bassHistory = new Float64Array(historySize);
        this._historyCount = 0;
        this._historyIndex = 0;
        this._beatCooldown = 0;
    }

    detect(energy, bass) {
        // Append to ring buffer
        this._energyHistory[this._historyIndex] = energy;
        this._bassHistory[this._historyIndex] = bass;
        this._historyIndex = (this._historyIndex + 1) % this._historySize;
        if (this._historyCount < this._historySize)
            this._historyCount++;

        if (this._beatCooldown > 0) {
            this._beatCooldown -= 1;
            return 0;
        }

        if (this._historyCount < 5)
            return 0;

        const avgE = this._avg(this._energyHistory);
        const avgB = this._avg(this._bassHistory);
        const varE = this._variance(this._energyHistory, avgE);
        const varB = this._variance(this._bassHistory, avgB);
        const threshE = Math.max(BEAT_THRESHOLD_LOW, Math.min(BEAT_THRESHOLD_HIGH, BEAT_THRESHOLD_VARIANCE_SLOPE * varE + BEAT_THRESHOLD_HIGH));
        const threshB = Math.max(BEAT_THRESHOLD_LOW, Math.min(BEAT_THRESHOLD_HIGH, BEAT_THRESHOLD_VARIANCE_SLOPE * varB + BEAT_THRESHOLD_HIGH));
        const needE = threshE * avgE;
        const needB = threshB * avgB;
        const energyBeat = (energy - BEAT_NOISE_FLOOR) > needE && avgE > BEAT_NOISE_FLOOR;
        const bassBeat = (bass - BEAT_NOISE_FLOOR) > needB && avgB > BEAT_NOISE_FLOOR;

        if (energyBeat || bassBeat) {
            this._beatCooldown = this._cooldownFrames;
            return 1;
        }
        return 0;
    }

    _avg(arr) {
        let sum = 0;
        const count = Math.min(this._historyCount, arr.length);
        for (let i = 0; i < count; i++)
            sum += arr[i];
        return count > 0 ? sum / count : 0;
    }

    _variance(arr, mean) {
        let sum = 0;
        const count = Math.min(this._historyCount, arr.length);
        for (let i = 0; i < count; i++) {
            const d = arr[i] - mean;
            sum += d * d;
        }
        return count > 1 ? sum / (count - 1) : 0;
    }
}

export function run(bench) {
    // Pre-generate test data
    const spectrumStrings = [];
    for (let i = 0; i < 100; i++)
        spectrumStrings.push(makeSyntheticSpectrumString());

    // Regex spectrum parsing
    {
        let idx = 0;
        bench('audio: regex spectrum parse (24 bands)', () => {
            parseSpectrumBandsFromString(spectrumStrings[idx % spectrumStrings.length]);
            idx++;
        });
    }

    // Band averaging (bass/mid/high split)
    {
        const bands = parseSpectrumBandsFromString(spectrumStrings[0]);
        const third = Math.floor(bands.length / 3);
        bench('audio: band averaging (bass/mid/high)', () => {
            averageRange(bands, 0, third);
            averageRange(bands, third, third * 2);
            averageRange(bands, third * 2, bands.length);
            average(bands);
        });
    }

    // Beat detection (full cycle: parse + bands + detect)
    {
        const detector = new BeatDetector(20, 2);
        let idx = 0;
        bench('audio: beat detection cycle', () => {
            const bands = parseSpectrumBandsFromString(spectrumStrings[idx % spectrumStrings.length]);
            const third = Math.floor(bands.length / 3);
            const bass = averageRange(bands, 0, third);
            const energy = average(bands);
            detector.detect(energy, bass);
            idx++;
        });
    }

    // Feature smoothing (exponential moving average)
    {
        let prev = 0.5;
        let val = 0.4;
        bench('audio: feature smoothing', () => {
            prev = prev * FEATURE_SMOOTHING + val * (1 - FEATURE_SMOOTHING);
            val = Math.sin(prev * 3.14);
        });
    }
}
