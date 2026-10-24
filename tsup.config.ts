import { defineConfig } from 'tsup';

export default defineConfig({
    entry     : [ 'src/aggregator.ts' ],
    format    : [ 'cjs', 'esm' ],
    dts       : true,
    minify    : false,
    sourcemap : false,
    clean     : true,
    shims     : true,
    splitting : false
});
