'use strict';

module.exports = {
    upgrade: true,
    // undici 8.x requires Node 22.19+ and crashes at require() on Node 20; stay on
    // the latest 7.x (CommonJS, Node 20+) so security patches still flow through.
    target: name => (name === 'undici' ? 'minor' : 'latest'),
    reject: [
        // Block package upgrades that moved to ESM
        'nanoid'
    ]
};
