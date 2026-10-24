import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
    {
        ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/build/**', '**/docs/**'],
    },
    {
        files: ['src/**/*.ts'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended,
        ],
        plugins: {
            '@stylistic': stylistic
        },
        rules: {
            // Disable strict TS recommended rules that break linting for legacy code
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unsafe-function-type': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
            'no-control-regex': 'off',
            'no-empty': 'off',
            // Indentation: 4 spaces strictly, ignoring Array/Object assignments to allow Allman brackets on new lines
            '@stylistic/indent': ['error', 4, {
                'ignoredNodes': [
                    'VariableDeclarator > ArrayExpression',
                    'VariableDeclarator > ObjectExpression',
                    'PropertyDefinition > ArrayExpression',
                    'PropertyDefinition > ObjectExpression',
                    'AssignmentExpression > ArrayExpression',
                    'AssignmentExpression > ObjectExpression',
                    // `as const` / `as T` wraps the literal, which would otherwise lose the exemptions above
                    'VariableDeclarator > TSAsExpression > ArrayExpression',
                    'VariableDeclarator > TSAsExpression > ObjectExpression'
                ]
            }],
            'indent': 'off',

            // Quotes: Single quotes
            '@stylistic/quotes': ['error', 'single', { 'avoidEscape': true }],

            // Allman brace style for multiline, allowing single line compacting
            '@stylistic/brace-style': ['error', 'allman', { 'allowSingleLine': true }],

            // Mandatory Braces for all control statements (even single-line)
            'curly': ['error', 'all'],

            // Padding spaces inside parenthesis, except empty, nested parens, objects, and arrays
            '@stylistic/space-in-parens': ['error', 'always', { 'exceptions': ['empty', '()', '{}', '[]'] }],

            // Object literal colon alignment
            '@stylistic/key-spacing': ['error', {
                'align': 'colon',
                'beforeColon': true,
                'afterColon': true
            }],

            // Block spacing: always
            '@stylistic/block-spacing': ['error', 'always'],

            // Commas & Semicolons
            '@stylistic/semi': ['error', 'always', { 'omitLastInOneLineBlock': true }],
            '@stylistic/comma-dangle': ['error', 'never'],

            // Typescript specific property/type alignments
            '@stylistic/member-delimiter-style': ['error', {
                'multiline': {
                    'delimiter': 'none',
                    'requireLast': false
                },
                'singleline': {
                    'delimiter': 'comma',
                    'requireLast': false
                }
            }],

            // Disable standard spacing that might interfere with single-line condensed blocks
            '@stylistic/keyword-spacing': ['error', {
                'overrides': {
                    'if': { 'after': false },
                    'for': { 'after': false },
                    'while': { 'after': false },
                    'catch': { 'after': false }
                }
            }],

            // Always require an empty line before control statements and return
            '@stylistic/padding-line-between-statements': [
                'error',
                { 'blankLine': 'always', 'prev': '*', 'next': ['if', 'for', 'while', 'return'] }
            ]
        }
    }
);
