// Historique des prix par semaine (1.30.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');
const DAY = 864e5, NOW = Date.now();
const settle = async () => { for (let i = 0; i < 100; i++) await new Promise(r => setImmediate(r)); };
const PH = (at, weeks = { SR: [{ start: '2026-11-09', avg: 120, min: 80, max: 200, count: 6 }, { start: '2026-11-16', avg: 110, min: 90, max: 150, count: 4 }] }) =>
  ({ computed_at: at, by_rarity: Object.fromEntries(Object.entries(weeks).map(([r, w]) => [r, { weekly: w, monthly: [] }])) });

test('historique : enregistré par rareté, semaines triées, une semaine illisible ignorée', () => {
  const { t } = load();
  const n = t.ingestHistory('C1', PH('2026-11-22T13:40:00Z', { SR: [{ start: '2026-11-16', avg: 110, min: 90, max: 150, count: 4 },
    { start: 'hier', avg: 5, min: 5, max: 5, count: 1 }, { start: '2026-11-09', avg: 120, min: 80, max: 200, count: 6 }], rare: [{ start: '2026-11-09', avg: 1, min: 1, max: 1, count: 1 }] }));
  assert.equal(n, 1);
  assert.deepEqual(plain(t.db.hist.C1.w), { SR: [['2026-11-09', 120, 80, 200, 6], ['2026-11-16', 110, 90, 150, 4]] });
  assert.equal(t.db.hist.C1.at, Date.parse('2026-11-22T13:40:00Z'));
});

test('historique : une réponse plus récente remplace, une plus ancienne est ignorée ; computed_at illisible = maintenant', () => {
  const { t } = load();
  t.ingestHistory('C1', PH('2026-11-22T13:40:00Z'));
  t.ingestHistory('C1', PH('2026-11-20T00:00:00Z', { SR: [{ start: '2026-11-02', avg: 999, min: 999, max: 999, count: 1 }] }));
  assert.equal(t.db.hist.C1.w.SR[0][1], 120, 'plus ancienne : ignorée');
  t.ingestHistory('C1', PH('n/a', { SR: [{ start: '2026-11-16', avg: 140, min: 140, max: 140, count: 2 }] }));
  assert.equal(t.db.hist.C1.w.SR[0][1], 140);
  assert.ok(Math.abs(t.db.hist.C1.at - Date.now()) < 5000);
});

test('historique : réponse mal formée, rien n’est enregistré', () => {
  const { t } = load();
  for (const j of [null, {}, { by_rarity: 3 }, { by_rarity: { SR: { weekly: 'x' } } }, { by_rarity: { SR: { weekly: [{ start: '2026-11-16', avg: 'cent', count: 2 }] } } }]) {
    assert.equal(t.ingestHistory('C1', j), 0);
  }
  assert.equal(t.db.hist.C1, undefined);
});

test('historique : 200 cartes au plus en mode secours, les plus anciennes partent ; trimHistory le vide', () => {
  const { t } = load();
  for (let i = 0; i < 205; i++) t.ingestHistory('K' + i, PH(new Date(Date.parse('2026-11-01T00:00:00Z') + i * 6e4).toISOString()));
  assert.equal(Object.keys(t.db.hist).length, 200);
  assert.equal(t.db.hist.K0, undefined);
  assert.ok(t.db.hist.K204);
  t.trimHistory();
  assert.deepEqual(plain(t.db.hist), {});
});

test('historique : la Vue du marché du site, en se chargeant, l’enregistre', async () => {
  const env = load({ fast: true, fetch: async () => reply(PH('2026-11-22T13:40:00Z')) });
  await env.ready;
  await env.window.fetch('https://www.wiki-masters.com/api/marketplace/cards/C1/price-history');
  await settle();
  assert.equal(env.t.db.hist.C1.w.SR.length, 2);
});

test('fiche : « Relever les ventes » demande les ventes puis l’historique', async () => {
  const urls = [];
  const { t } = load({ fast: true, fetch: async url => { urls.push(url); return reply(/price-history/.test(url) ? PH('2026-11-22T13:40:00Z') : { recent: [] }); } });
  t.db.userId = 'U1';
  for (const k of ['cardHead', 'cardBody']) t.ui.el[k] = { replaceChildren() {} };
  t.ui.el.cardStatus = { textContent: '' };
  t.openCard('C1', { rarity: 'SR', title: 'X' });
  await t.cardFetchNow();
  assert.equal(urls[urls.length - 1], '/api/marketplace/cards/C1/price-history');
  assert.ok(urls.includes('/api/marketplace/cards/C1/sales?rarity=SR'));
  assert.ok(urls.indexOf('/api/marketplace/cards/C1/sales?rarity=SR') < urls.indexOf('/api/marketplace/cards/C1/price-history'));
  assert.equal(t.db.hist.C1.w.SR.length, 2);
});
