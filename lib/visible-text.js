'use strict';

const { parseDocument } = require('htmlparser2');
const { default: serialize } = require('dom-serializer');
const { isTag, isText, isComment, hasChildren, textContent, findAll, findOne, prependChild, removeElement } = require('domutils');

// What the reader never sees must not reach the model either: an email can carry instructions
// for an AI in text a mail client does not render, and the summary has to describe the message
// as it looks to the person it was sent to. The links are collected before anything is removed,
// because the checks run on them must see every link the message carries, hidden or not

// Elements whose content is never rendered as text
const HIDDEN_TAGS = new Set(['script', 'style', 'template', 'title', 'iframe', 'object', 'embed']);

// Comments and quoted strings inside a style attribute, which carry no declarations
const STYLE_NOISE = /\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'/g;

// Outlook for Windows shows what a conditional comment wraps; the markers go, the content stays
const CONDITIONAL_COMMENT = /<!--\[if [^\]]*\]>|<!\[endif\]-->/gi;

// Characters that take no space on screen: zero-width joiners and spaces, soft hyphens, the
// bidirectional controls and the word joiner. Removing them changes nothing the reader sees and
// stops them splitting words the model should recognise or reordering text it should read
const INVISIBLE_CHARS = /[\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

// Only what reliably hides text. Zero sizes of boxes and negative positions depend on other
// properties to hide anything, so they are left alone rather than dropping text the reader sees
function isHiddenStyle(style) {
    style = String(style ?? '').replace(STYLE_NOISE, ' ');
    if (!style.trim()) {
        return false;
    }
    for (const declaration of style.split(';')) {
        const match = /^\s*([a-z-]+)\s*:\s*([^!]*)/i.exec(declaration);
        if (!match) {
            continue;
        }
        const property = match[1].toLowerCase();
        const value = match[2].trim().toLowerCase();
        const number = parseFloat(value);
        switch (property) {
            case 'display':
                if (value === 'none') {
                    return true;
                }
                break;
            case 'visibility':
                if (value === 'hidden' || value === 'collapse') {
                    return true;
                }
                break;
            case 'opacity':
                if (Number.isFinite(number) && number < 0.1) {
                    return true;
                }
                break;
            case 'font-size':
                // zero in any unit, or below one pixel
                if (Number.isFinite(number) && (number === 0 || (number < 1 && /^[\d.]+(?:px|pt)?$/.test(value)))) {
                    return true;
                }
                break;
            case 'text-indent':
                if (Number.isFinite(number) && number <= -1000) {
                    return true;
                }
                break;
        }
    }
    return false;
}

function isHiddenElement(node) {
    const attribs = node.attribs || {};
    const style = attribs.style || '';
    // the hidden attribute is a user agent rule, which an author display value overrides
    if ('hidden' in attribs && !/display\s*:\s*(?!none)/i.test(style.replace(STYLE_NOISE, ' '))) {
        return true;
    }
    return isHiddenStyle(style);
}

function hasText(node) {
    if (isText(node)) {
        return /\S/.test(node.data || '');
    }
    return hasChildren(node) && node.children.some(hasText);
}

function stripHidden(node, stats) {
    if (!hasChildren(node)) {
        return;
    }
    node.children = node.children.filter(child => {
        if (isComment(child)) {
            return false;
        }
        if (isText(child)) {
            // before the conversion, which would turn a zero-width space into a plain one
            const cleaned = child.data.replace(INVISIBLE_CHARS, '');
            stats.invisibleCharacters += child.data.length - cleaned.length;
            child.data = cleaned;
            return true;
        }
        if (!isTag(child)) {
            return true;
        }
        if (HIDDEN_TAGS.has(child.name)) {
            return false;
        }
        if (isHiddenElement(child)) {
            // a layout element with no text in it is not hidden content, only a spacer
            if (hasText(child)) {
                stats.hiddenElements++;
            }
            return false;
        }
        return true;
    });
    for (const child of node.children) {
        stripHidden(child, stats);
    }
}

// What the reader takes as the link: its text, and the alt and title of an image standing in
// for it
function linkText(node) {
    const parts = [textContent(node), node.attribs.title || ''];
    for (const image of findAll(child => child.name === 'img', node.children)) {
        parts.push(image.attribs.alt || '', image.attribs.title || '');
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function collectLinks(document) {
    const targets = findAll(
        node => ((node.name === 'a' || node.name === 'area') && !!node.attribs.href) || (node.name === 'form' && !!node.attribs.action),
        document.children
    );
    return targets.map(node => ({ href: node.attribs.href || node.attribs.action, text: linkText(node) }));
}

/**
 * Parses an HTML message once: every link it carries, for the checks, and the document as the
 * reader sees it, for the model
 *
 * @param {string} html
 * @returns {{links: Array<{href: string, text: string}>, hiddenElements: number, invisibleCharacters: number, html: Function}} The links, how many styled-away elements carrying text were dropped, how many invisible characters, and the visible HTML as a function, serialised only when asked for
 */
// A browser shows flow content a message put inside <head>, the converter reads only <body>:
// what is left of the head after the metadata went moves to the front of the body
function surfaceHead(document) {
    const head = findOne(node => node.name === 'head', document.children);
    if (!head) {
        return;
    }
    const body = findOne(node => node.name === 'body', document.children);
    if (!body) {
        head.name = 'div';
        return;
    }
    for (const child of head.children.slice().reverse()) {
        prependChild(body, child);
    }
    removeElement(head);
}

function visibleHtml(html) {
    const document = parseDocument(String(html ?? '').replace(CONDITIONAL_COMMENT, ''));
    const links = collectLinks(document);
    const stats = { hiddenElements: 0, invisibleCharacters: 0 };
    stripHidden(document, stats);
    surfaceHead(document);
    return { links, hiddenElements: stats.hiddenElements, invisibleCharacters: stats.invisibleCharacters, html: () => serialize(document) };
}

/**
 * Removes the characters that take no space on screen
 *
 * @param {string} text
 * @returns {{text: string, invisibleCharacters: number}}
 */
function visibleText(text) {
    text = String(text ?? '');
    const matches = text.match(INVISIBLE_CHARS);
    return { text: matches ? text.replace(INVISIBLE_CHARS, '') : text, invisibleCharacters: matches ? matches.length : 0 };
}

module.exports = { visibleHtml, visibleText, INVISIBLE_CHARS };
