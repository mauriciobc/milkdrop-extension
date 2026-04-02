import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';

import {AudioEngine} from '../../src/extension/audio.js';

function buildLogger(logs) {
    return {
        info: message => logs.push({level: 'info', message}),
        warn: message => logs.push({level: 'warn', message}),
        debug: message => logs.push({level: 'debug', message}),
    };
}

export function run(assert) {
    console.log("Running audio PCM contract test...");
    
    // Test 1: AudioEngine class exists and can be instantiated
    {
        const logs = [];
        const logger = buildLogger(logs);
        const audio = new AudioEngine({logger, onFallback: null});
        
        assert(audio !== null && audio !== undefined, 'AudioEngine can be instantiated');
        assert(typeof audio.getFeatures === 'function', 'AudioEngine has getFeatures method');
        assert(typeof audio.enabled === 'boolean', 'AudioEngine has enabled property');
    }
    
    // Test 2: getFeatures returns expected PCM-only structure
    {
        const logs = [];
        const logger = buildLogger(logs);
        const audio = new AudioEngine({logger, onFallback: null});
        
        // Enable the audio engine
        audio._enabled = true;
        
        // Get features
        const features = audio.getFeatures();
        
        // Check that expected fields exist
        assert('source' in features, 'getFeatures returns source');
        assert('active' in features, 'getFeatures returns active');
        assert('pcmLeft' in features, 'getFeatures returns pcmLeft');
        assert('pcmRight' in features, 'getFeatures returns pcmRight');
        
        // Check that PCM fields are array-like (Float32Array), length 576
        const isPcmArray = (v) => (v instanceof Float32Array) && v.length === 576;
        assert(isPcmArray(features.pcmLeft), 'pcmLeft is Float32Array length 576');
        assert(isPcmArray(features.pcmRight), 'pcmRight is Float32Array length 576');
    }
    
    console.log("Audio PCM contract test completed");
}