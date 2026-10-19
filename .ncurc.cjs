'use strict';

module.exports = {
    upgrade: true,
    // undici 8.x requires Node 22.19+ and crashes at require() on Node 20; stay on
    // the latest 7.x (CommonJS, Node 20+) so security patches still flow through.
    target: name => {
        if (name === 'undici') {
            return 'minor';
        }
        // @types/node stays on the 20.x line so the compiler rejects APIs that do
        // not exist on Node 20, the oldest supported version
        if (name === '@types/node') {
            return 'minor';
        }
        // typescript-eslint declares a peer range that excludes TypeScript 7
        if (name === 'typescript') {
            return 'minor';
        }
        return 'latest';
    },
    reject: [
        // Block package upgrades that moved to ESM
        'nanoid',
        // htmlparser2 11+, domutils 4+ and dom-serializer 3+ are "type": "module" and load only
        // through require(esm), which pkg cannot bundle and Node 20 does not have. The last
        // CommonJS builds are 10.x, 3.x and 2.x
        'htmlparser2',
        'domutils',
        'dom-serializer',
        // @asamuzakjp/css-color >=4.1.2 pulls in @csstools/* which are pure ESM, so require(jsdom) fails
        // without require(esm) (email-text-tools -> jsdom -> cssstyle -> @asamuzakjp/css-color). Held at
        // 4.1.1 through package.json "overrides"; overrides do not propagate to consumers, EmailEngine
        // carries its own.
        '@asamuzakjp/css-color'
    ]
};
