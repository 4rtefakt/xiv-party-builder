// Tests pour lib/discord.js — validation URL + builders purs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCORD_WEBHOOK_PATTERN, isValidWebhookUrl,
  buildEmbedPayload, buildMarkdown
} from '../lib/discord.js';

// --- DISCORD_WEBHOOK_PATTERN / isValidWebhookUrl ---

test('isValidWebhookUrl : URL valide discord.com', () => {
  assert.equal(isValidWebhookUrl('https://discord.com/api/webhooks/123456/abcDEF_-xyz'), true);
});

test('isValidWebhookUrl : URL valide discordapp.com (legacy)', () => {
  assert.equal(isValidWebhookUrl('https://discordapp.com/api/webhooks/987654321/tok_en-1234'), true);
});

test('isValidWebhookUrl : URL invalide rejetée', () => {
  for (const bad of [
    null, undefined, '', 42,
    'http://discord.com/api/webhooks/123/abc',         // http (pas https)
    'https://discord.com/api/webhook/123/abc',         // pas webhook**s**
    'https://example.com/api/webhooks/123/abc',        // autre domaine
    'https://discord.com/api/webhooks/abc/token',      // id pas numérique
    'https://discord.com/api/webhooks/123/$$$',        // token invalide
  ]) {
    assert.equal(isValidWebhookUrl(bad), false, `bad=${JSON.stringify(bad)}`);
  }
});

// --- buildEmbedPayload ---

test('buildEmbedPayload : shape attendu', () => {
  const p = buildEmbedPayload({
    title: 'Raid 8 · Samedi 21h',
    description: 'Composition validée',
    link: 'https://party-builder.pages.dev/?p=abc123',
    fields: [{ name: 'Tanks', value: 'Alice — PLD' }]
  });
  assert.equal(p.username, 'Party Builder');
  assert.equal(p.embeds.length, 1);
  const e = p.embeds[0];
  assert.equal(e.title, 'Raid 8 · Samedi 21h');
  assert.equal(e.url, 'https://party-builder.pages.dev/?p=abc123');
  assert.equal(e.description, 'Composition validée');
  assert.equal(e.color, 0x00e5ff);
  assert.deepEqual(e.fields, [{ name: 'Tanks', value: 'Alice — PLD' }]);
  assert.equal(e.footer.text, 'party-builder.pages.dev');
  assert.ok(e.timestamp);
});

test('buildEmbedPayload : titre tronqué à 256, description à 2048', () => {
  const p = buildEmbedPayload({
    title: 'x'.repeat(500),
    description: 'y'.repeat(3000),
    link: 'https://example.test/',
    fields: []
  });
  assert.equal(p.embeds[0].title.length, 256);
  assert.equal(p.embeds[0].description.length, 2048);
});

test('buildEmbedPayload : image incluse si ogImageUrl fourni, omise sinon', () => {
  const withImg = buildEmbedPayload({
    title: 't', description: 'd', link: 'https://x.test/',
    ogImageUrl: 'https://x.test/og/abc.png',
    fields: []
  });
  assert.deepEqual(withImg.embeds[0].image, { url: 'https://x.test/og/abc.png' });

  const noImg = buildEmbedPayload({
    title: 't', description: 'd', link: 'https://x.test/', fields: []
  });
  assert.equal(noImg.embeds[0].image, undefined);
});

test('buildEmbedPayload : custom username/color respectés', () => {
  const p = buildEmbedPayload({
    title: 't', description: 'd', link: 'https://x.test/', fields: [],
    color: 0xff0000, username: 'Custom Bot'
  });
  assert.equal(p.embeds[0].color, 0xff0000);
  assert.equal(p.username, 'Custom Bot');
});

// --- buildMarkdown ---

// Mini t() pour tests : tape simple, supporte les params
function makeT(overrides = {}) {
  const defaults = {
    res_slotTank: 'TANK',
    res_slotHeal: 'HEAL',
    res_slotMelee: 'MELEE',
    res_slotDistance: 'RANGED',
    res_slotCaster: 'CASTER',
    dc_bench: ({ names }) => `Banc : ${names}`,
    dc_rosterFallback: '_(pas de compo possible avec ces prefs)_',
    dc_absents: ({ names }) => `Absent·es : ${names}`,
    dc_banned: ({ names }) => `Jobs bannis : ${names}`
  };
  const dict = { ...defaults, ...overrides };
  return (key, params) => {
    const v = dict[key];
    if (v === undefined) return key;
    return typeof v === 'function' ? v(params || {}) : v;
  };
}

test('buildMarkdown : avec result OK → groupe par rôle', () => {
  const result = {
    results: [
      { name: 'Alice', assigned: true, role: 'tank',  jobName: 'Paladin',     prefRank: 0 },
      { name: 'Bob',   assigned: true, role: 'heal',  jobName: 'White Mage',  prefRank: 1 },
      { name: 'Carla', assigned: true, role: 'melee', jobName: 'Samurai',     prefRank: 0 },
      { name: 'Dan',   assigned: false }
    ]
  };
  const md = buildMarkdown({
    contentLabel: 'Raid 8', raidWhen: 'Samedi 21h',
    players: [], bannedJobs: [], link: 'https://x.test/?p=abc',
    result, t: makeT()
  });
  assert.match(md, /Party Builder · Raid 8 · Samedi 21h/);
  assert.match(md, /🛡️ TANK/);
  assert.match(md, /Alice — Paladin ★/);
  assert.match(md, /💚 HEAL/);
  assert.match(md, /⚔️ MELEE/);
  assert.match(md, /Banc : Dan/);
  assert.match(md, /🔗 https:\/\/x\.test\/\?p=abc/);
});

test('buildMarkdown : raidWhen vide → pas de séparateur', () => {
  const md = buildMarkdown({
    contentLabel: 'Donjon', raidWhen: '',
    players: [], bannedJobs: [], link: 'x',
    result: { error: 'noPlayers' }, t: makeT()
  });
  assert.match(md, /^\*\*Party Builder · Donjon\*\*/);
});

test('buildMarkdown : result error → fallback roster', () => {
  const md = buildMarkdown({
    contentLabel: 'Raid', raidWhen: '',
    players: [
      { name: 'Alice', preferences: ['PLD', 'WAR'], presence: 'in' },
      { name: '   ',   preferences: ['SCH'],         presence: 'in' },        // nom vide → filtré
      { name: 'Bob',   preferences: [],              presence: 'out' },        // absent → filtré
      { name: 'Carla', preferences: ['SCH'],         presence: 'maybe' }       // maybe → conservé avec (?)
    ],
    bannedJobs: [], link: 'x', result: { error: 'noComp' }, t: makeT()
  });
  assert.match(md, /pas de compo possible/);
  assert.match(md, /Alice : Paladin > Warrior/);
  assert.match(md, /Carla \(\?\) : Scholar/);
  // Bob (out) ne doit PAS apparaître dans le fallback roster (filtré),
  // mais doit apparaître dans la ligne "Absent·es"
  assert.doesNotMatch(md, /Bob : /);
  assert.match(md, /Absent·es : Bob/);
});

test('buildMarkdown : bannedJobs listés', () => {
  const md = buildMarkdown({
    contentLabel: 'R8', raidWhen: '',
    players: [], bannedJobs: ['BLM', 'PCT'], link: 'x',
    result: null, t: makeT()
  });
  assert.match(md, /Jobs bannis : Black Mage, Pictomancer/);
});

test('buildMarkdown : absents avec présence "out"', () => {
  const md = buildMarkdown({
    contentLabel: 'R8', raidWhen: '',
    players: [
      { name: 'Alice', preferences: [], presence: 'in' },
      { name: 'Bob',   preferences: [], presence: 'out' },
      { name: 'Carla', preferences: [], presence: 'out' }
    ],
    bannedJobs: [], link: 'x', result: null, t: makeT()
  });
  assert.match(md, /Absent·es : Bob, Carla/);
});

test('buildMarkdown : forcé → tag ⚠️', () => {
  const result = {
    results: [
      { name: 'Alice', assigned: true, role: 'tank', jobName: 'Paladin', prefRank: -1, forced: true }
    ]
  };
  const md = buildMarkdown({
    contentLabel: 'R8', raidWhen: '', players: [], bannedJobs: [], link: 'x',
    result, t: makeT()
  });
  assert.match(md, /Alice — Paladin ⚠️/);
});
