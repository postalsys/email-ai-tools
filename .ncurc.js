'use strict';

module.exports = {
    upgrade: true,
    reject: [
        // Block package upgrades that moved to ESM
        'nanoid',
        // requires Node 22.19+
        'undici'
    ]
};
