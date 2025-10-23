'use strict';

const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended
});

module.exports = [
    {
        ignores: ['node_modules/**', 'examples/**']
    },
    ...compat.extends('nodemailer', 'prettier'),
    {
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'script',
            globals: {
                BigInt: 'readonly'
            }
        },
        rules: {
            // Disable all formatting rules (handled by Prettier)
            indent: 0,
            quotes: 0,
            'linebreak-style': 0,
            semi: 0,
            'comma-dangle': 0,
            'comma-style': 0,
            'arrow-body-style': 0,
            'arrow-parens': 0,
            // Keep these disabled
            'no-await-in-loop': 0,
            'require-atomic-updates': 0
        }
    }
];
