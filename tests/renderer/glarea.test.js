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
        _warpParams: null,
        _useShaderWarp: false,
        _frameState: null,
        _onBridgeMessage: null,
        _loggerWarnings: [],
        _logger: {
            warn(message) {
                state._loggerWarnings.push(message);
            },
        },
        _uploadPresetMeshCalls: 0,
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
        _uploadPresetMesh() {
            this._uploadPresetMeshCalls += 1;
        },
        _glBridgeUploadMeshCalls: 0,
        _glBridge: {
            submitFrame(payload) {
                state._glSubmitFramePayload = payload;
            },
            uploadMesh(_mesh) {
                state._glBridgeUploadMeshCalls += 1;
            },
        },
        _baseMesh: {columns: 4, rows: 3},
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
        assert(state._tickCallbackId === 0, 'helper-ready disables fallback tick callback');
        assert(state._removedTickIds.length === 1 && state._removedTickIds[0] === firstTickId,
            'helper-ready removes the active tick callback id');
        assert(state._uploadPresetMeshCalls === 1, 'helper-ready uploads preset mesh when helper becomes ready');
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
        const inputFrame = {frame: 7, zoom: 1.1, rot: 0.1};
        MilkdropGLArea.prototype.setFrameState.call(state, inputFrame);
        assert(state._glSubmitFramePayload?.frame === 7, 'setFrameState forwards frame payload to bridge');
        assert(state._queueDrawCalls === 1, 'setFrameState queue_draws while helper is not ready');

        state._helperReady = true;
        MilkdropGLArea.prototype.setFrameState.call(state, {frame: 8});
        assert(state._queueDrawCalls === 1, 'setFrameState does not queue_draw when helper is ready');

        state._useShaderWarp = true;
        state._warpParams = {warpAmount: 0.5, warpSpeed: 0.25, warpScale: 1.2, warpType: 1};
        MilkdropGLArea.prototype.setFrameState.call(state, {frame: 9});
        assert(state._glSubmitFramePayload?.warpInShader === true,
            'setFrameState adds warpInShader flag when shader warp is active');
        assert(state._glSubmitFramePayload?.warpAmount === 0.5,
            'setFrameState merges shader warp parameters in bridge payload');
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
    // Without this, the previous 230KB GLib.Bytes-backed texture stays referenced until overwritten,
    // preventing prompt collection by SpiderMonkey which cannot see the C-heap cost.
    {
        const state = createMethodState();
        const assignments = [];
        let helperTextureValue = {stale: true};  // simulate existing old texture

        Object.defineProperty(state, '_helperTexture', {
            get() { return helperTextureValue; },
            set(v) {
                assignments.push(v === null ? 'null' : 'value');
                helperTextureValue = v;
            },
            configurable: true,
        });

        // Serial mismatch forces _getHelperTexture to rebuild the texture.
        state._helperTextureSerial = 5;
        state._helperFrame = {
            serial: 6,
            width: 2,
            height: 2,
            stride: 8,  // 2px * 4 bytes
            bytes: {get_size: () => 16},  // 2*2*4 = 16 bytes
        };

        // The function must null the old texture BEFORE it tries to create a new one.
        // If Gdk.MemoryTexture.new throws (e.g. no display), the null assignment is still
        // the first thing to happen — we only assert the ordering is correct regardless.
        try {
            MilkdropGLArea.prototype._getHelperTexture.call(state);
        } catch (_e) {
            // creation failure is fine; the null step must still have happened first
        }

        assert(assignments.length >= 1 && assignments[0] === 'null',
            '_getHelperTexture nulls stale _helperTexture before allocating new GdkMemoryTexture');
    }

    // helper-ready with shader warp active uploads identity mesh via bridge instead of vertex-warped mesh.
    {
        const state = createMethodState();
        state._useShaderWarp = true;
        state._warpParams = {warpAmount: 0.5, warpSpeed: 1.0, warpScale: 1.0, warpType: 1};

        MilkdropGLArea.prototype._handleBridgeMessage.call(state, {type: 'helper-ready', ok: true});
        assert(state._uploadPresetMeshCalls === 0,
            'helper-ready with shader warp does not call _uploadPresetMesh');
        assert(state._glBridgeUploadMeshCalls === 1,
            'helper-ready with shader warp uploads identity mesh via bridge');
    }

    // loadPresetVertex switches between shader warp and CPU warp deterministically.
    {
        const state = createMethodState();
        state._helperReady = true;
        state._vertexEval = {
            _compiled: null,
            compile(source) {
                if (source && typeof source === 'object') {
                    this._compiled = {
                        warpAmount: source.warpAmount ?? 0,
                        warpSpeed: source.warpSpeed ?? 1,
                        warpScale: source.warpScale ?? 1,
                        warpType: source.warpType ?? 'radial',
                    };
                    return;
                }
                this._compiled = null;
            },
        };

        MilkdropGLArea.prototype.loadPresetVertex.call(state, {
            warpAmount: 0.3,
            warpSpeed: 1.2,
            warpScale: 0.8,
            warpType: 'radial',
        });
        assert(state._useShaderWarp === true,
            'loadPresetVertex enables shader warp for supported built-in warp specs');
        assert(state._warpParams?.warpType === 0,
            'loadPresetVertex maps built-in warp type to shader helper index');
        assert(state._glBridgeUploadMeshCalls === 1,
            'loadPresetVertex uploads identity mesh immediately when helper-ready shader warp is enabled');

        MilkdropGLArea.prototype.loadPresetVertex.call(state, 'dx = 0.02;');
        assert(state._useShaderWarp === false,
            'loadPresetVertex disables shader warp for expression-based vertex sources');
        assert(state._warpParams === null,
            'loadPresetVertex clears stale shader warp params when switching to expression source');
        assert(state._uploadPresetMeshCalls === 1,
            'loadPresetVertex re-uploads CPU warp mesh when shader warp path is disabled');
    }

    // setFrameState must not emit warpInShader after switching away from shader warp mode.
    {
        const state = createMethodState();
        state._helperReady = true;
        state._vertexEval = {
            _compiled: null,
            compile(source) {
                if (source && typeof source === 'object') {
                    this._compiled = {
                        warpAmount: source.warpAmount ?? 0,
                        warpSpeed: source.warpSpeed ?? 1,
                        warpScale: source.warpScale ?? 1,
                        warpType: source.warpType ?? 'radial',
                    };
                    return;
                }
                this._compiled = null;
            },
        };

        MilkdropGLArea.prototype.loadPresetVertex.call(state, {
            warpAmount: 0.25,
            warpType: 'wave',
        });
        MilkdropGLArea.prototype.setFrameState.call(state, {frame: 31});
        assert(state._glSubmitFramePayload?.warpInShader === true,
            'setFrameState emits warpInShader while shader warp mode is active');

        MilkdropGLArea.prototype.loadPresetVertex.call(state, null);
        MilkdropGLArea.prototype.setFrameState.call(state, {frame: 32});
        assert(!Object.prototype.hasOwnProperty.call(state._glSubmitFramePayload, 'warpInShader'),
            'setFrameState omits warpInShader after shader warp mode is disabled');
    }
}
