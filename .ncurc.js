module.exports = {
    upgrade: true,
    reject: [
        // Block package upgrades that moved to ESM
        'nanoid',

        // no support for Node 16
        'undici'
    ]
};
