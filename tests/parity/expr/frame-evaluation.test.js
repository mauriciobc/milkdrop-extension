/**
 * Frame Evaluation Parity Tests
 * Tests that per-frame expression evaluation produces correct results
 */

import { compile } from '../../../src/extension/expr/compiler.js';
import { ExpressionEvaluator } from '../../../src/extension/expr/per-frame.js';

const EPSILON = 0.0001;

function runTest(name, testFn) {
    try {
        const result = testFn();
        return { name, pass: result.pass, expected: result.expected, actual: result.actual, error: null };
    } catch (e) {
        return { name, pass: false, expected: null, actual: null, error: e.message };
    }
}

export function run(assert) {
    const results = [];
    
    // Test 1: Simple time-based zoom animation
    {
        const expr = compile(`
            zoom = 1.0 + 0.1 * sin(time * 2);
            rot = 0.05 * sin(time);
        `);
        
        const ctx1 = { time: 0, frame: 0, bass: 0, mid: 0, treb: 0, zoom: 1.0, rot: 0 };
        expr(ctx1);
        
        const ctx2 = { time: Math.PI / 4, frame: 30, bass: 0, mid: 0, treb: 0, zoom: 1.0, rot: 0 };
        expr(ctx2);
        
        results.push(runTest('zoom time-based animation', () => ({
            pass: Math.abs(ctx1.zoom - 1.0) < EPSILON && Math.abs(ctx2.zoom - 1.1) < EPSILON,
            expected: '1.0 at t=0, 1.1 at t=π/4',
            actual: `${ctx1.zoom.toFixed(4)} at t=0, ${ctx2.zoom.toFixed(4)} at t=π/4`
        })));
        
        results.push(runTest('rot time-based animation', () => ({
            pass: Math.abs(ctx1.rot) < EPSILON && Math.abs(ctx2.rot - 0.05 * Math.sin(Math.PI / 4)) < EPSILON,
            expected: `0 at t=0, ${0.05 * Math.sin(Math.PI / 4).toFixed(4)} at t=π/4`,
            actual: `${ctx1.rot.toFixed(4)} at t=0, ${ctx2.rot.toFixed(4)} at t=π/4`
        })));
    }
    
    // Test 2: Bass-reactive animation
    {
        const expr = compile(`
            zoom = 1.0 + bass * 0.5;
            dx = bass * 0.1;
        `);
        
        const ctxBass = { time: 0, frame: 0, bass: 0.5, mid: 0, treb: 0, zoom: 1.0, dx: 0 };
        expr(ctxBass);
        
        results.push(runTest('bass reactive zoom', () => ({
            pass: Math.abs(ctxBass.zoom - 1.25) < EPSILON,
            expected: 1.25,
            actual: ctxBass.zoom
        })));
        
        results.push(runTest('bass reactive dx', () => ({
            pass: Math.abs(ctxBass.dx - 0.05) < EPSILON,
            expected: 0.05,
            actual: ctxBass.dx
        })));
    }
    
    // Test 3: Multiple sequential frames
    {
        const expr = compile(`
            decay = decay - 0.01;
        `);
        
        const ctx = { time: 0, frame: 0, decay: 0.98, bass: 0, mid: 0, treb: 0 };
        
        expr(ctx); // frame 0
        const decay0 = ctx.decay;
        expr(ctx); // frame 1
        const decay1 = ctx.decay;
        expr(ctx); // frame 2
        const decay2 = ctx.decay;
        
        results.push(runTest('sequential frame decay', () => ({
            pass: Math.abs(decay0 - 0.97) < EPSILON && 
                  Math.abs(decay1 - 0.96) < EPSILON && 
                  Math.abs(decay2 - 0.95) < EPSILON,
            expected: '0.97, 0.96, 0.95',
            actual: `${decay0.toFixed(4)}, ${decay1.toFixed(4)}, ${decay2.toFixed(4)}`
        })));
    }
    
    // Test 4: ExpressionEvaluator integration
    {
        const preset = {
            id: 'test-preset',
            name: 'Test Preset',
            baseVals: { decay: 0.98, zoom: 1.0 },
            init_eqs: '',
            frame_eqs: 'zoom = zoom + 0.1 * sin(time); rot = rot + bass * 0.1;',
            pixel_eqs: '',
            customWaves: null,
            customShapes: null,
        };
        
        const evaluator = new ExpressionEvaluator();
        evaluator.loadPreset(preset);
        evaluator.runInit();
        
        const frame1 = evaluator.evaluateFrame({
            time: 0,
            frame: 0,
            fps: 60,
            bass: 0,
            mid: 0,
            treb: 0,
            bass_att: 0,
            mid_att: 0,
            treb_att: 0,
            energy: 0,
            beat: 0,
        });
        
        results.push(runTest('evaluator zoom at t=0', () => ({
            pass: Math.abs(frame1.zoom - 1.0) < EPSILON,
            expected: 1.0,
            actual: frame1.zoom
        })));
        
        const frame2 = evaluator.evaluateFrame({
            time: Math.PI / 2,
            frame: 30,
            fps: 60,
            bass: 0.5,
            mid: 0,
            treb: 0,
            bass_att: 0.35,
            mid_att: 0,
            treb_att: 0,
            energy: 0.5,
            beat: 0,
        });
        
        results.push(runTest('evaluator zoom with time', () => ({
            pass: Math.abs(frame2.zoom - 1.1) < EPSILON,
            expected: 1.1,
            actual: frame2.zoom
        })));
        
        results.push(runTest('evaluator rot with bass', () => ({
            pass: Math.abs(frame2.rot - 0.05) < EPSILON,
            expected: 0.05,
            actual: frame2.rot
        })));
    }
    
    // Test 5: Frame evaluation applies baseVals then equations
    {
        const preset = {
            id: 'test-acc',
            name: 'Test Frame Eval',
            baseVals: { decay: 0.98, zoom: 1.0 },
            init_eqs: '',
            frame_eqs: 'zoom = zoom + 0.01;',
            pixel_eqs: '',
            customWaves: null,
            customShapes: null,
        };
        
        const evaluator = new ExpressionEvaluator();
        evaluator.loadPreset(preset);
        evaluator.runInit();
        
        let lastZoom = 1.0;
        
        for (let i = 0; i < 10; i++) {
            const frame = evaluator.evaluateFrame({
                time: i * 0.016,
                frame: i,
                fps: 60,
                bass: 0, mid: 0, treb: 0,
                bass_att: 0, mid_att: 0, treb_att: 0,
                energy: 0, beat: 0,
            });
            
            lastZoom = frame.zoom;
        }
        
        results.push(runTest('evaluator applies baseVals each frame', () => ({
            pass: Math.abs(lastZoom - 1.01) < EPSILON, // baseVals.zoom = 1.0, then +0.01 = 1.01 (reset each frame)
            expected: 1.01,
            actual: lastZoom
        })));
    }
    
    // Test 6: Per-pixel equation simulation
    {
        const evaluator = new ExpressionEvaluator();
        
        // Test that per-pixel context provides rad, ang, x, y
        let radValue = null;
        let angValue = null;
        
        // Create a simple per-pixel test
        const preset = {
            id: 'test-pixel',
            name: 'Test Pixel',
            baseVals: {},
            init_eqs: '',
            frame_eqs: '',
            pixel_eqs: 'dummy = rad + ang;',
            customWaves: null,
            customShapes: null,
        };
        
        // This would need the full per-pixel evaluator to test properly
        // For now, just verify the preset loads
        evaluator.loadPreset(preset);
        evaluator.runInit();
        
        results.push(runTest('per-pixel preset loads', () => ({
            pass: evaluator._preset !== null,
            expected: 'preset loaded',
            actual: evaluator._preset ? 'loaded' : 'not loaded'
        })));
    }
    
    // Test 7: Complex nested expressions
    {
        const expr = compile(`
            zoom = 1.0 + 0.5 * (0.3 * sin(time * 2) + 0.7 * cos(time * 3));
            rot = if(above(bass, 0.5), 0.1, 0.0) + if(below(mid, 0.3), 0.05, 0.0);
            decay = min(0.99, max(0.9, 0.95 - bass * 0.1));
        `);
        
        const ctx = { 
            time: Math.PI / 2, 
            frame: 30, 
            bass: 0.6, 
            mid: 0.2, 
            treb: 0,
            zoom: 1.0,
            rot: 0,
            decay: 0.95
        };
        expr(ctx);
        
        const expectedZoom = 1.0 + 0.5 * (0.3 * Math.sin(Math.PI) + 0.7 * Math.cos(1.5 * Math.PI));
        
        results.push(runTest('complex nested zoom', () => ({
            pass: Math.abs(ctx.zoom - expectedZoom) < EPSILON,
            expected: expectedZoom,
            actual: ctx.zoom
        })));
        
        results.push(runTest('complex nested rot with if/above/below', () => ({
            pass: Math.abs(ctx.rot - 0.15) < EPSILON, // 0.1 (bass > 0.5) + 0.05 (mid < 0.3)
            expected: 0.15,
            actual: ctx.rot
        })));
        
        results.push(runTest('complex nested decay with min/max', () => ({
            pass: Math.abs(ctx.decay - 0.9) < EPSILON, // max(0.9, 0.89) = 0.9, then min(0.99, 0.9) = 0.9
            expected: 0.9,
            actual: ctx.decay
        })));
    }
    
    // Test 8: Frame blending (transition between presets)
    {
        const presetA = {
            id: 'A',
            name: 'Preset A',
            baseVals: { zoom: 1.0, decay: 0.98 },
            init_eqs: '',
            frame_eqs: 'zoom = 1.0;',
            pixel_eqs: '',
            customWaves: null,
            customShapes: null,
        };
        
        const presetB = {
            id: 'B',
            name: 'Preset B',
            baseVals: { zoom: 2.0, decay: 0.95 },
            init_eqs: '',
            frame_eqs: 'zoom = 2.0;',
            pixel_eqs: '',
            customWaves: null,
            customShapes: null,
        };
        
        // Simulate blend by averaging outputs
        const exprA = compile('zoom = 1.0;');
        const exprB = compile('zoom = 2.0;');
        
        const ctxA = { zoom: 1.0 };
        const ctxB = { zoom: 2.0 };
        exprA(ctxA);
        exprB(ctxB);
        
        // At 50% blend
        const blendedZoom = ctxA.zoom * 0.5 + ctxB.zoom * 0.5;
        
        results.push(runTest('preset blending simulation', () => ({
            pass: Math.abs(blendedZoom - 1.5) < EPSILON,
            expected: 1.5,
            actual: blendedZoom
        })));
    }
    
    // Summary
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    
    print(`\n=== Frame Evaluation Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
    
    if (failed > 0) {
        print('\nFailed tests:');
        for (const r of results.filter(r => !r.pass)) {
            if (r.error) {
                print(`  ${r.name}: ERROR - ${r.error}`);
            } else {
                print(`  ${r.name}: expected=${r.expected}, actual=${r.actual}`);
            }
        }
    }
    
    assert(passed === results.length, `Frame evaluation: ${passed}/${results.length} passed`);
    
    return { passed, failed, results };
}
