'use strict';

module.exports = {
    upgrade: true,
    target: name => {
        // @types/node stays on the 22.x line so the compiler rejects APIs that do
        // not exist on Node 22, the oldest supported version
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
        // through require(esm), which pkg cannot bundle. The last
        // CommonJS builds are 10.x, 3.x and 2.x
        'htmlparser2',
        'domutils',
        'dom-serializer'
    ]
};
