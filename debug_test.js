console.log("Debug test starting");

const {AudioEngine} = require('./src/extension/audio.js');

console.log("AudioEngine imported:", !!AudioEngine);

const logger = {
    info: (msg) => console.log("INFO:", msg),
    warn: (msg) => console.log("WARN:", msg),
    debug: (msg) => console.log("DEBUG:", msg)
};

const audio = new AudioEngine(logger, null);
console.log("AudioEngine instance created:", !!audio);

audio._enabled = true;
console.log("Audio enabled set");

try {
    audio._startPipeline();
    console.log("Pipeline started");
} catch (e) {
    console.log("Error starting pipeline:", e.message);
}

console.log("Debug test ending");