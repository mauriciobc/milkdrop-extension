import {parseRendererWindowTitle, RENDERER_TITLE_PREFIX} from '../../src/extension/windowTitle.js';

export function run(assert) {
    // Valid title parses state and monitor index.
    {
        const title = `${RENDERER_TITLE_PREFIX}{"position":[10,20],"keepAtBottom":true}|2`;
        const parsed = parseRendererWindowTitle(title);
        assert(parsed !== null, 'valid renderer title parses successfully');
        assert(parsed?.monitorIndex === 2, 'valid renderer title monitor index parsed');
        assert(parsed?.state?.keepAtBottom === true, 'valid renderer title state parsed');
    }

    // Missing prefix fails.
    {
        const parsed = parseRendererWindowTitle('{"position":[0,0]}|1');
        assert(parsed === null, 'title without prefix is rejected');
    }

    // Malformed JSON fails.
    {
        const title = `${RENDERER_TITLE_PREFIX}{"position":[10,20}|1`;
        const parsed = parseRendererWindowTitle(title);
        assert(parsed === null, 'title with malformed JSON is rejected');
    }

    // Missing monitor separator fails.
    {
        const title = `${RENDERER_TITLE_PREFIX}{"position":[10,20]}`;
        const parsed = parseRendererWindowTitle(title);
        assert(parsed === null, 'title without monitor separator is rejected');
    }

    // Invalid monitor index fails.
    {
        const title = `${RENDERER_TITLE_PREFIX}{"position":[10,20]}|-1`;
        const parsed = parseRendererWindowTitle(title);
        assert(parsed === null, 'title with negative monitor index is rejected');
    }
}