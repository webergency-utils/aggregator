import { defineConfig } from 'vitest/config';

export default defineConfig({
    test : {
        environment : 'node',
        include     : [ 'src/tests/**/*.test.ts' ],
        coverage    : {
            provider : 'v8',
            reporter : [ 'text', 'json', 'html' ],
            include  : [
                'src/**/*.ts'
            ],
            exclude  : [
                '**/*.test.ts',
                'src/tests/**'
            ]
        }
    }
});
