import {shouldCommitByFrames, shouldCommitByTimeout} from '../../src/extension/preset-probe-policy.js';

export async function run(assert) {
    {
        assert(
            shouldCommitByFrames({probeActive: true, probeCrashed: false, frameCounter: 10, probeFrameTarget: 10}),
            'commit by frames when target is reached'
        );
        assert(
            !shouldCommitByFrames({probeActive: true, probeCrashed: true, frameCounter: 999, probeFrameTarget: 0}),
            'do not commit by frames when crashed'
        );
        assert(
            !shouldCommitByFrames({probeActive: false, probeCrashed: false, frameCounter: 999, probeFrameTarget: 0}),
            'do not commit by frames when probeActive is false'
        );
    }

    {
        assert(
            shouldCommitByTimeout({probeActive: true, probeCrashed: false, nowMs: 2000, probeStartMs: 0, probeTimeoutMs: 1500}),
            'commit by timeout when elapsed >= timeout'
        );
        assert(
            !shouldCommitByTimeout({probeActive: true, probeCrashed: true, nowMs: 2000, probeStartMs: 0, probeTimeoutMs: 1}),
            'do not commit by timeout when crashed'
        );
        assert(
            !shouldCommitByTimeout({probeActive: false, probeCrashed: false, nowMs: 2000, probeStartMs: 0, probeTimeoutMs: 1}),
            'do not commit by timeout when probeActive is false'
        );
        assert(
            !shouldCommitByTimeout({probeActive: true, probeCrashed: false, nowMs: 2, probeStartMs: 1, probeTimeoutMs: 0}),
            'timeout <= 0 should not commit'
        );
    }
}

