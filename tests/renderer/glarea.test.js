import {MilkdropGLArea} from '../../src/renderer/glarea.js';

function createMethodState() {
    let nextTickId = 1;
    const state = {
        _running: true,
        _tickCallbackId: 0,
        _helperReady: false,
        _helperFrame: null,
        _helperTexture: null,
        _helperTextureSerial: 0,
        _invalidHelperFrameSerial: 0,
        _frameState: null,
        _onBridgeMessage: null,
        _loggerWarnings: [],
        _logger: {
            warn(message) {
                state._loggerWarnings.push(message);
            },
        },
        _glSubmitFramePayload: null,
        _queueDrawCalls: 0,
        _removedTickIds: [],
        add_tick_callback(callback) {
            this._tickCallback = callback;
            return nextTickId++;
        },
        remove_tick_callback(id) {
            this._removedTickIds.push(id);
        },
        queue_draw() {
            this._queueDrawCalls += 1;
        },
        _glBridge: {
            submitFrame(payload) {
                state._glSubmitFramePayload = payload;
            },
            changePreset(_path) {},
        },
    };
    state._ensureFallbackTick = MilkdropGLArea.prototype._ensureFallbackTick;
    state._disableFallbackTick = MilkdropGLArea.prototype._disableFallbackTick;
    return state;
}

export function run(assert) {
    // fallback tick is created once and removed on helper-ready.
    {
        const state = createMethodState();
        MilkdropGLArea.prototype._ensureFallbackTick.call(state);
        const firstTickId = state._tickCallbackId;
        MilkdropGLArea.prototype._ensureFallbackTick.call(state);
        assert(firstTickId > 0, '_ensureFallbackTick creates initial tick callback');
        assert(state._tickCallbackId === firstTickId, '_ensureFallbackTick does not create duplicate ticks');

        MilkdropGLArea.prototype._handleBridgeMessage.call(state, {type: 'helper-ready', ok: true});
        assert(state._tickCallbackId !== 0, 'helper-ready keeps fallback tick alive until first frame arrives');
        assert(state._removedTickIds.length === 0, 'helper-ready does not remove tick when no frame yet');

        // First frame-pixels with helper ready disables the tick.
        const tickBeforeFrame = state._tickCallbackId;
        MilkdropGLArea.prototype._handleBridgeMessage.call(state, {
            type: 'frame-pixels', serial: 1, width: 1, height: 1, stride: 4,
            bytes: {get_size() { return 4; }},
        });
        assert(state._tickCallbackId === 0, 'frame-pixels disables fallback tick when helper is ready');
        assert(state._removedTickIds.length === 1 && state._removedTickIds[0] === tickBeforeFrame,
            'frame-pixels removes the active tick callback id when helper is ready');
    }

    // helper-crashed and shader_error re-enable fallback tick and clear helper frame state.
    {
        const state = createMethodState();
        state._helperReady = true;
        state._helperFrame = {frame: 33};
        state._helperTexture = {};
        state._helperTextureSerial = 99;
        MilkdropGLArea.prototype._ensureFallbackTick.call(state);
        const activeTickId = state._tickCallbackId;

        MilkdropGLArea.prototype._handleBridgeMessage.call(state, {type: 'helper-ready', ok: true});
        assert(state._tickCallbackId === 0, 'helper-ready clears active tick before crash recovery path');

        MilkdropGLArea.prototype._handleBridgeMessage.call(state, {type: 'helper-crashed'});
        const crashTickId = state._tickCallbackId;
        assert(crashTickId > 0 && crashTickId !== activeTickId, 'helper-crashed re-enables fallback tick callback');
        assert(state._helperReady === false, 'helper-crashed marks helper as not ready');
        assert(state._helperFrame === null, 'helper-crashed clears cached helper frame');
        assert(state._helperTexture === null && state._helperTextureSerial === 0,
            'helper-crashed clears helper texture cache');

        const beforeShaderErrorTickId = state._tickCallbackId;
        MilkdropGLArea.prototype._handleBridgeMessage.call(state, {type: 'shader_error'});
        assert(state._tickCallbackId === beforeShaderErrorTickId,
            'shader_error keeps single fallback tick without duplicate registration');
    }

    // setFrameState submits frame payload and only queue_draws while helper is not ready.
    {
        const state = createMethodState();
        const inputFrame = {frame: 7, t: 1.0};
        MilkdropGLArea.prototype.setFrameState.call(state, inputFrame);
        assert(state._glSubmitFramePayload === inputFrame, 'setFrameState forwards frame payload to bridge');
        assert(state._queueDrawCalls === 1, 'setFrameState queue_draws while helper is not ready');

        state._helperReady = true;
        MilkdropGLArea.prototype.setFrameState.call(state, {frame: 8, t: 2.0});
        assert(state._queueDrawCalls === 1, 'setFrameState does not queue_draw when helper is ready');
    }

    // _getHelperTexture drops invalid helper frame payloads before creating MemoryTexture.
    {
        const state = createMethodState();
        state._helperFrame = {
            serial: 11,
            width: 2,
            height: 1,
            stride: 8,
            bytes: {
                get_size() {
                    return 4;
                },
            },
        };

        const texture = MilkdropGLArea.prototype._getHelperTexture.call(state);
        assert(texture === null, '_getHelperTexture returns null for invalid frame payload size');
        assert(state._helperFrame === null, '_getHelperTexture clears invalid cached helper frame');
        assert(state._loggerWarnings.length === 1, '_getHelperTexture logs warning for invalid frame payload');
    }

    // _getHelperTexture nulls stale _helperTexture before allocating a new one (GC pressure fix).
    {
        const state = createMethodState();
        const assignments = [];
        let helperTextureValue = {stale: true};

        Object.defineProperty(state, '_helperTexture', {
            get() { return helperTextureValue; },
            set(v) {
                assignments.push(v === null ? 'null' : 'value');
                helperTextureValue = v;
            },
            configurable: true,
        });

        state._helperTextureSerial = 5;
        state._helperFrame = {
            serial: 6,
            width: 2,
            height: 2,
            stride: 8,
            bytes: {get_size: () => 16},
        };

        try {
            MilkdropGLArea.prototype._getHelperTexture.call(state);
        } catch (_e) {
            // creation failure is fine; the null step must still have happened first
        }

        assert(assignments.length >= 1 && assignments[0] === 'null',
            '_getHelperTexture nulls stale _helperTexture before allocating new GdkMemoryTexture');
    }

    // changePreset delegates to bridge.
    {
        const state = createMethodState();
        const paths = [];
        state._glBridge = {
            submitFrame() {},
            changePreset(p) { paths.push(p); },
        };
        MilkdropGLArea.prototype.changePreset.call(state, '/test/preset.milk');
        assert(paths.length === 1 && paths[0] === '/test/preset.milk',
            'changePreset delegates to bridge changePreset');
    }
}
