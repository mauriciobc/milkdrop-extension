import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk?version=4.0';

import {GlBridge} from './gl-bridge.js';
import {createDefaultMesh, applyWarpToMesh} from './mesh.js';
import {VertexEvaluator} from './vertex-eval.js';

const FALLBACK_STRIPE_COUNT = 12;
const FALLBACK_ORB_MIN_SIZE = 28;
const FALLBACK_ORB_SIZE_FACTOR = 0.08;

export const MilkdropGLArea = GObject.registerClass(
class MilkdropGLArea extends Gtk.Widget {
    constructor({standalone = false, strictRenderPath = false, logger = console, onBridgeMessage = null} = {}) {
        super({
            hexpand: true,
            vexpand: true,
        });

        this._standalone = standalone;
        this._logger = logger;
        this._onBridgeMessage = onBridgeMessage;
        this._frameState = null;
        this._running = true;
        this._tickCallbackId = 0;
        this._bridgeStarted = false;
        this._helperReady = false;
        this._helperFrame = null;
        this._helperTexture = null;
        this._helperTextureSerial = 0;
        this._invalidHelperFrameSerial = 0;
        this._baseMesh = createDefaultMesh();
        this._vertexEval = new VertexEvaluator();
        this._useShaderWarp = false;
        this._warpParams = null;
        this._scratchRect = new Graphene.Rect();
        this._scratchColor = new Gdk.RGBA();
        this._glBridge = new GlBridge({
            strictRenderPath,
            logger: this._logger,
            onMessage: message => this._handleBridgeMessage(message),
        });

        this.connect('realize', () => {
            try {
                this._startBridge();
            } catch (error) {
                this._logger.warn?.(`milkdrop glarea realize failed: ${error.message}`);
            }
        });

        this.connect('unrealize', () => this._stopRendering());
        this.connect('destroy', () => this._stopRendering());
        this._ensureFallbackTick();

        if (this._standalone)
            this.set_tooltip_text('Milkdrop GLArea visual proof');
    }

    setFrameState(frameState) {
        if (!this._running)
            return;

        this._frameState = frameState;
        const payload = {...frameState};
        if (this._useShaderWarp && this._warpParams) {
            payload.warpInShader = true;
            Object.assign(payload, this._warpParams);
        }
        this._glBridge.submitFrame(payload);
        if (!this._helperReady)
            this.queue_draw();
    }

    loadPresetVertex(vertexSpec) {
        this._vertexEval.compile(vertexSpec ?? null);
        const c = this._vertexEval._compiled;
        const builtInTypes = ['radial', 'angular', 'wave'];
        if (c && builtInTypes.includes(c.warpType) && c.warpAmount !== 0) {
            this._useShaderWarp = true;
            this._warpParams = {
                warpAmount: c.warpAmount,
                warpSpeed: c.warpSpeed,
                warpScale: c.warpScale,
                warpType: builtInTypes.indexOf(c.warpType),
            };
        } else {
            this._useShaderWarp = false;
            this._warpParams = null;
        }
        if (this._useShaderWarp && this._helperReady) {
            const mesh = createDefaultMesh(this._baseMesh.columns, this._baseMesh.rows);
            applyWarpToMesh(mesh.vertices, mesh.vertexCount, {}, (u, v) => [u, v]);
            this._glBridge.uploadMesh(mesh);
        } else if (!this._useShaderWarp) {
            this._uploadPresetMesh();
        }
    }

    loadPresetShaders(shaders) {
        if (!shaders)
            return;

        this._glBridge.compileShaders(shaders);
    }

    _uploadPresetMesh() {
        if (!this._helperReady || !this._baseMesh)
            return;

        const mesh = createDefaultMesh(this._baseMesh.columns, this._baseMesh.rows);
        const frame = this._frameState ?? {zoom: 1.0, rot: 0.0, dx: 0.0, dy: 0.0, t: 0};
        applyWarpToMesh(
            mesh.vertices,
            mesh.vertexCount,
            frame,
            (u, v, f) => this._vertexEval.evaluate(u, v, f)
        );
        this._glBridge.uploadMesh(mesh);
    }

    _stopRendering() {
        this._running = false;
        this._helperReady = false;
        this._helperFrame = null;
        this._helperTexture = null;
        this._helperTextureSerial = 0;
        this._glBridge.stop();
        this._disableFallbackTick();
    }

    _startBridge() {
        if (this._bridgeStarted)
            return;

        this._bridgeStarted = true;
        const [streamWidth, streamHeight] = this._buildHelperStreamSize();
        this._glBridge.start({
            width: streamWidth,
            height: streamHeight,
        });
    }

    _ensureFallbackTick() {
        if (this._tickCallbackId || !this._running)
            return;

        this._tickCallbackId = this.add_tick_callback(() => {
            if (!this._running)
                return GLib.SOURCE_REMOVE;

            this.queue_draw();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _disableFallbackTick() {
        if (!this._tickCallbackId)
            return;

        this.remove_tick_callback(this._tickCallbackId);
        this._tickCallbackId = 0;
    }

    vfunc_snapshot(snapshot) {
        const width = this.get_width();
        const height = this.get_height();
        if (width <= 0 || height <= 0)
            return;

        const helperTexture = this._getHelperTexture();
        if (this._helperReady && helperTexture) {
            this._appendTexture(snapshot, helperTexture, 0, 0, width, height);
            return;
        }

        const state = this._frameState ?? this._buildFallbackFrameState();
        const zoom = state.zoom ?? 1.0;
        const rotation = state.rot ?? 0.0;
        const time = state.t ?? GLib.get_monotonic_time() / 1000000;
        const frame = state.frame ?? 0;

        const baseRed = this._wave(time * 0.37 + rotation * 25.0);
        const baseGreen = this._wave(time * 0.23 + zoom * 1.9);
        const baseBlue = this._wave(time * 0.41 + frame * 0.015);

        this._appendRect(snapshot, baseRed * 0.22, baseGreen * 0.2, baseBlue * 0.32, 1.0,
            0, 0, width, height);

        const stripeCount = FALLBACK_STRIPE_COUNT;
        const stripeWidth = width / stripeCount;
        for (let index = 0; index < stripeCount; index += 1) {
            const intensity = this._wave(time * 0.8 + index * 0.7 + rotation * 60.0);
            const stripeHeight = height * (0.18 + intensity * 0.55);
            const x = index * stripeWidth;
            const y = height - stripeHeight;
            this._appendRect(snapshot,
                0.12 + intensity * 0.35,
                0.24 + baseGreen * 0.45,
                0.45 + baseBlue * 0.4,
                0.78,
                x,
                y,
                Math.max(1, stripeWidth - 3),
                stripeHeight);
        }

        const orbX = (0.1 + this._wave(time * 1.3 + rotation * 90.0) * 0.8) * width;
        const orbY = (0.15 + this._wave(time * 0.9 + zoom * 3.0) * 0.7) * height;
        const orbSize = Math.max(
            FALLBACK_ORB_MIN_SIZE,
            Math.min(width, height) * (FALLBACK_ORB_SIZE_FACTOR + Math.abs(rotation) * 6.0)
        );
        this._appendRect(snapshot, 0.92, 0.96, 1.0, 0.92, orbX - orbSize / 2, orbY - orbSize / 2, orbSize, orbSize);

        const zoomBarWidth = Math.max(24, Math.min(width * 0.72, width * (0.28 + (zoom - 1.0) * 10.0)));
        this._appendRect(snapshot, 0.98, 0.78, 0.22, 0.9, 18, 18, zoomBarWidth, 10);

        const rotBarWidth = Math.max(18, width * (0.08 + Math.min(0.42, Math.abs(rotation) * 35.0)));
        this._appendRect(snapshot, 0.32, 0.95, 0.74, 0.86, 18, 36, rotBarWidth, 8);
    }

    _buildFallbackFrameState() {
        const t = GLib.get_monotonic_time() / 1000000;
        return {
            t,
            frame: Math.floor(t * 60),
            zoom: 1.0 + Math.sin(t * 0.7) * 0.02,
            rot: Math.sin(t * 0.35) * 0.01,
        };
    }

    _buildHelperStreamSize() {
        const widgetWidth = Math.max(1, this.get_width(), this.get_allocated_width?.() ?? 0, 320);
        const widgetHeight = Math.max(1, this.get_height(), this.get_allocated_height?.() ?? 0, 180);

        return [widgetWidth, widgetHeight];
    }

    _getHelperTexture() {
        if (!this._helperFrame)
            return null;

        if (this._helperTexture && this._helperTextureSerial === this._helperFrame.serial)
            return this._helperTexture;

        const width = this._helperFrame.width ?? 0;
        const height = this._helperFrame.height ?? 0;
        const stride = this._helperFrame.stride ?? 0;
        const expectedSize = stride * height;
        const actualSize = typeof this._helperFrame.bytes?.get_size === 'function'
            ? this._helperFrame.bytes.get_size()
            : -1;
        if (width <= 0 || height <= 0 || stride < width * 4 || expectedSize <= 0 || actualSize !== expectedSize) {
            if (this._helperFrame.serial !== this._invalidHelperFrameSerial) {
                this._invalidHelperFrameSerial = this._helperFrame.serial;
                this._logger.warn?.(
                    `milkdrop glarea dropping invalid helper frame serial=${this._helperFrame.serial} `
                    + `width=${width} height=${height} stride=${stride} expected=${expectedSize} got=${actualSize}`
                );
            }
            this._helperFrame = null;
            this._helperTexture = null;
            this._helperTextureSerial = 0;
            return null;
        }

        // Null the previous texture before allocating the new one so SpiderMonkey can
        // promptly reclaim the 230+ KB of C-heap-backed pixel data it wraps.
        this._helperTexture = null;
        this._helperTexture = Gdk.MemoryTexture.new(
            width,
            height,
            Gdk.MemoryFormat.R8G8B8A8,
            this._helperFrame.bytes,
            stride
        );
        this._helperTextureSerial = this._helperFrame.serial;
        return this._helperTexture;
    }

    _appendRect(snapshot, red, green, blue, alpha, x, y, width, height) {
        if (width <= 0 || height <= 0)
            return;

        this._scratchColor.red = this._clamp(red);
        this._scratchColor.green = this._clamp(green);
        this._scratchColor.blue = this._clamp(blue);
        this._scratchColor.alpha = this._clamp(alpha);
        this._scratchRect.init(x, y, width, height);
        snapshot.append_color(this._scratchColor, this._scratchRect);
    }

    _appendTexture(snapshot, texture, x, y, width, height) {
        if (!texture || width <= 0 || height <= 0)
            return;

        this._scratchRect.init(x, y, width, height);
        snapshot.append_texture(texture, this._scratchRect);
    }

    _wave(value) {
        return (Math.sin(value) + 1) / 2;
    }

    _clamp(value) {
        return Math.max(0, Math.min(1, value));
    }

    _handleBridgeMessage(message) {
        switch (message.type) {
        case 'helper-ready':
            this._helperReady = message.ok ?? false;
            if (this._helperReady)
                this._disableFallbackTick();
            else
                this._ensureFallbackTick();
            if (this._helperReady) {
                if (this._useShaderWarp) {
                    const mesh = createDefaultMesh(this._baseMesh.columns, this._baseMesh.rows);
                    applyWarpToMesh(mesh.vertices, mesh.vertexCount, {}, (u, v) => [u, v]);
                    this._glBridge.uploadMesh(mesh);
                } else {
                    this._uploadPresetMesh();
                }
            }
            if (!this._helperReady) {
                this._helperFrame = null;
                this._helperTexture = null;
                this._helperTextureSerial = 0;
            }
            this.queue_draw();
            break;
        case 'frame-pixels':
            // Drop the previous frame first so the 230+ KB GLib.Bytes can be GC'd
            // promptly rather than waiting for SpiderMonkey to notice C-heap pressure.
            this._helperFrame = null;
            this._helperTexture = null;
            this._helperTextureSerial = 0;
            this._helperFrame = message;
            this.queue_draw();
            break;
        case 'shader_error':
        case 'helper-crashed':
            this._helperReady = false;
            this._ensureFallbackTick();
            this._helperFrame = null;
            this._helperTexture = null;
            this._helperTextureSerial = 0;
            this.queue_draw();
            break;
        default:
            break;
        }

        this._onBridgeMessage?.(message);
    }
});
