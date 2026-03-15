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
        const audio = new AudioEngine(logger, null);
        
        assert(audio !== null && audio !== undefined, 'AudioEngine can be instantiated');
        assert(typeof audio.getFeatures === 'function', 'AudioEngine has getFeatures method');
        assert(typeof audio.enabled === 'boolean', 'AudioEngine has enabled property');
    }
    
    // Test 2: getFeatures returns expected structure including PCM fields
    {
        const logs = [];
        const logger = buildLogger(logs);
        const audio = new AudioEngine(logger, null);
        
        // Enable the audio engine
        audio._enabled = true;
        
        // Get features
        const features = audio.getFeatures();
        
        // Check that expected fields exist
        assert('source' in features, 'getFeatures returns source');
        assert('active' in features, 'getFeatures returns active');
        assert('energy' in features, 'getFeatures returns energy');
        assert('bass' in features, 'getFeatures returns bass');
        assert('mid' in features, 'getFeatures returns mid');
        assert('high' in features, 'getFeatures returns high');
        assert('treb' in features, 'getFeatures returns treb');
        assert('bass_att' in features, 'getFeatures returns bass_att');
        assert('mid_att' in features, 'getFeatures returns mid_att');
        assert('treb_att' in features, 'getFeatures returns treb_att');
        assert('beat' in features, 'getFeatures returns beat');
        assert('decay' in features, 'getFeatures returns decay');
        assert('waveData' in features, 'getFeatures returns waveData');
        assert('pcmLeft' in features, 'getFeatures returns pcmLeft');
        assert('pcmRight' in features, 'getFeatures returns pcmRight');
        
        // Check that PCM fields are array-like (Array or Float32Array), length 576
        const isPcmArray = (v) => (Array.isArray(v) || v instanceof Float32Array) && v.length === 576;
        assert(isPcmArray(features.pcmLeft), 'pcmLeft is array-like length 576');
        assert(isPcmArray(features.pcmRight), 'pcmRight is array-like length 576');
    }
    
    console.log("Audio PCM contract test completed");
}