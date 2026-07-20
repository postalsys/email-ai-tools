'use strict';

module.exports = {
    upgrade: true,
    // undici 8.x requires Node 22.19+ and crashes at require() on Node 20; stay on
    // the latest 7.x (CommonJS, Node 20+) so security patches still flow through.
    target: name => (name === 'undici' ? 'minor' : 'latest'),
    reject: [
        // Block package upgrades that moved to ESM
        'nanoid',
        // linkify-it 6.0.0 changed the CommonJS export shape (named bindings instead of
        // the constructor) and stopped linkifying bare domains such as example.com by
        // default, which silently breaks autolinking in plain text content. Stay on 5.x,
        // matching mailparser and @postalsys/email-text-tools so consumers dedupe on one copy.
        'linkify-it'
    ]
};
