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

// ----- Tâche 3 : les repères avec l’historique -----
const sale = (d, p) => ({ p, t: new Date(NOW - d * DAY).toISOString(), r: 'SR' });
// Une semaine commencée il y a `d` jours : 2 → semaine en cours ; 9, 16, 23, 30… → semaines complètes.
const wk = (d, avg, count, min = avg, max = avg) => [new Date(NOW - d * DAY).toISOString().slice(0, 10), avg, min, max, count];

test('repères : le rythme vient de l’historique du site', () => {
  const { t } = load();
  const pace = weeks => t.cueLines(t.cardCues([sale(1, 100)], NOW, null, weeks)).find(l => l.k === 'pace').text.replace(/[  ]/g, ' ');
  assert.match(pace([wk(30, 100, 8), wk(23, 100, 6), wk(16, 100, 10), wk(9, 100, 4)]), /^se vend environ 7 fois par semaine sur le marché · dernière vente/);
  assert.match(pace([wk(30, 100, 1), wk(23, 100, 0), wk(16, 100, 1), wk(9, 100, 0)]), /^se vend environ 2 fois par mois sur le marché/);
  assert.match(pace([wk(16, 100, 0), wk(9, 100, 0)]), /^aucune vente en 4 semaines sur le marché/);
});

test('repères : prix du moment tiré des moyennes du site quand les ventes ne suffisent pas', () => {
  const { t } = load();
  const weeks = [wk(30, 100, 2), wk(23, 100, 2), wk(16, 100, 2), wk(9, 100, 2), wk(2, 130, 4)];
  const c = t.cardCues([sale(1, 130)], NOW, null, weeks);
  assert.equal(c.moment.state, 'high');
  assert.equal(c.moment.pct, 30);
  assert.equal(c.moment.src, 'hist');
  const text = t.cueLines(c)[0].text.replace(/[  ]/g, ' ');
  assert.match(text, /· cette semaine : 130 ₩ \(4 ventes\), 4 semaines d’avant : 100 ₩ \(8 ventes\), moyennes du site$/);
  assert.equal(t.cardCues([], NOW, null, [...weeks.slice(0, 4), wk(2, 130, 2)]).moment.state, 'few', '2 ventes cette semaine');
  assert.equal(t.cardCues([], NOW, null, [wk(16, 100, 2), wk(9, 100, 2), wk(2, 130, 4)]).moment.state, 'few', '4 ventes avant');
});

test('repères : les ventes passent avant l’historique quand elles suffisent', () => {
  const { t } = load();
  const sales = [sale(1, 100), sale(2, 100), sale(3, 100), ...[10, 12, 14, 16, 18].map(d => sale(d, 100))];
  const c = t.cardCues(sales, NOW, null, [wk(30, 50, 9), wk(23, 50, 9), wk(16, 50, 9), wk(9, 50, 9), wk(2, 200, 9)]);
  assert.equal(c.moment.src, 'sales');
  assert.equal(c.moment.state, 'usual');
});

test('repères : sens tiré des moyennes du site, 4 semaines au moins, semaine en cours maigre écartée', () => {
  const { t } = load();
  const rising = [58, 51, 44, 37, 30, 23, 16, 9].map((d, i) => wk(d, Math.round(100 * Math.pow(1.1, i)), 5));
  const c = t.cardCues([], NOW, null, rising.concat([wk(2, 10, 1)]));
  assert.equal(c.slope.src, 'hist');
  assert.equal(c.slope.state, 'up');
  assert.match(t.cueLines(c)[1].text, / · moyennes du site$/);
  assert.equal(t.cardCues([], NOW, null, rising.slice(-3)).slope.state, 'few');
});

test('fiche : un historique d’une autre rareté ne sert à rien', () => {
  const { t } = load();
  t.ingestHistory('C1', PH(new Date().toISOString(), { C: [{ start: wk(9, 1, 1)[0], avg: 100, min: 100, max: 100, count: 8 }] }));
  assert.equal(t.histWeeks('C1', 'SR'), null);
  assert.ok(t.histWeeks('C1', 'C'));
});

test('bulle : un historique reçu change la ligne « Repères »', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130)] };
  t.db.cards.X1 = { cardId: 'C1', title: 'X', rarity: 'SR', count: 1 };
  assert.ok(!t.badgeFor('C1', null, {}).lines.some(l => l.startsWith('Repères')));
  t.ingestHistory('C1', PH(new Date().toISOString(), { SR: [30, 23, 16, 9].map(d => ({ start: wk(d, 1, 1)[0], avg: 100, min: 100, max: 100, count: 2 }))
    .concat([{ start: wk(2, 1, 1)[0], avg: 130, min: 130, max: 130, count: 4 }]) }));
  assert.ok(t.badgeFor('C1', null, {}).lines.some(l => /^Repères : plus cher que d’habitude/.test(l)));
});
