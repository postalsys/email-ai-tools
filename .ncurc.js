'use strict';

module.exports = {
    upgrade: true,
    // undici 8.x requires Node 22.19+ and crashes at require() on Node 20; stay on
    // the latest 7.x (CommonJS, Node 20+) so security patches still flow through.
    target: name => (name === 'undici' ? 'minor' : 'latest'),
    reject: [
        // Block package upgrades that moved to ESM
        'nanoid',
        // htmlparser2 11+, domutils 4+ and dom-serializer 3+ are "type": "module" and load only
        // through require(esm), which pkg cannot bundle and Node 20 does not have. The last
        // CommonJS builds are 10.x, 3.x and 2.x
        'htmlparser2',
        'domutils',
        'dom-serializer'
    ]
};
