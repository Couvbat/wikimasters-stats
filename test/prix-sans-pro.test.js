// Tests : plus de prix pour les comptes sans Pro (priorités, pages par rareté, limite du site, relevé automatique).
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');

const MIN = 6e4;
const iso = ms => new Date(ms).toISOString();

// Une enchère suivie, finie à `end`, en attente de son prix final : [carte, rareté, fin, avait une offre].
function withQueue(t, now) {
  t.db.cards = { x1: { cardId: 'MINE', title: 'À moi', rarity: 'C', count: 1 } };
  t.db.wish = { WISH: ['Souhait', 'SR'] };
  t.db.finQ = {
    a1: ['X', 'C', now - 10 * MIN, 1],
    a2: ['L1', 'L', now - 10 * MIN, 0],
    a3: ['MINE', 'C', now - 20 * MIN, 0],
    a4: ['WISH', 'SR', now - 5 * MIN, 1],
    a5: ['L2', 'L', now - 10 * MIN, 1],
    a6: ['Y', 'L', now - 30 * 1000, 1],  // finie il y a 30 s : trop tôt
    a7: ['FULL', 'UR', now - 60 * MIN, 1] // la carte a déjà 10 prix plus récents : inutile
  };
  t.db.obsSales = { FULL: Array.from({ length: 10 }, (_, i) => ({ p: 50, t: iso(now - i * MIN), g: 0, x: 1 })) };
}

// ----- A : priorités -----
test('finalsToFetch : mes cartes et mes souhaits d’abord, puis par rareté, puis les enchères avec offre', () => {
  const { t } = load();
  withQueue(t, Date.now());
  assert.deepEqual(plain(t.finalsToFetch()), ['a4', 'a3', 'a5', 'a2', 'a1']);
});

test('sweepUrls : les pages habituelles, puis 3 pages de chaque rareté L, UR et SR', () => {
  const { t } = load();
  const urls = plain(t.sweepUrls(10, 3));
  assert.equal(urls.length, 19);
  assert.equal(urls[0], '/api/marketplace?page=1&limit=50&sort=ending_soon&mine=1');
  assert.equal(urls[9], '/api/marketplace?page=10&limit=50&sort=ending_soon');
  assert.equal(urls[10], '/api/marketplace?page=1&limit=50&sort=ending_soon&rarity=L');
  assert.equal(urls[18], '/api/marketplace?page=3&limit=50&sort=ending_soon&rarity=SR');
});

test('« Relever les fins d’enchères » lit aussi les pages par rareté', async () => {
  const { t, requests } = load({ fast: true, fetch: async () => reply({ auctions: [], hasMore: true }) });
  await t.scanMarket(10, 'status', 'ending_soon', 3);
  assert.equal(requests.length, 19);
  assert.ok(requests.some(u => u.endsWith('&rarity=UR')));
});

// ----- Limite d'automatisation du site -----
test('limite d’automatisation : tout s’arrête, rien n’est retiré de la file, le relevé automatique se met en pause', async () => {
  const now = Date.now();
  const { t, requests } = load({ fast: true, fetch: async () => reply({ error: 'Trop de requêtes', code: 'automation_limit' }, 403) });
  t.db.finQ = { b1: ['A', 'L', now - 10 * MIN, 1], b2: ['B', 'L', now - 10 * MIN, 1], b3: ['C', 'L', now - 10 * MIN, 1] };
  await t.fetchFinals('status');
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(t.db.finQ).sort(), ['b1', 'b2', 'b3']);
  assert.ok(t.db.autoPauseUntil > now + 23 * 60 * MIN);
  assert.match(t.ui.el.status.textContent, /limite/);
});

test('un vrai 403 sans limite retire toujours l’enchère inaccessible', async () => {
  const now = Date.now();
  const { t } = load({ fast: true, fetch: async () => reply({ error: 'interdit' }, 403) });
  t.db.finQ = { b1: ['A', 'L', now - 10 * MIN, 1] };
  await t.fetchFinals('status');
  assert.deepEqual(Object.keys(t.db.finQ), []);
  assert.equal(t.db.autoPauseUntil, undefined);
});

// ----- B : relevé automatique -----
test('autoDue : seulement si activé, onglet affiché, aucun autre onglet, pas de pause, 30 min écoulées', () => {
  const { t, store, document } = load();
  const now = Date.now();
  t.auto.loadedAt = now - 5 * MIN;
  assert.equal(t.autoDue(now), false, 'désactivé par défaut');
  t.db.ov.autoObs = true;
  assert.equal(t.autoDue(now), true);
  document.visibilityState = 'hidden';
  assert.equal(t.autoDue(now), true, 'en arrière-plan aussi (1.25) : le navigateur la ralentit tout seul');
  document.visibilityState = 'visible';
  t.auto.loadedAt = now - 30 * 1000;
  assert.equal(t.autoDue(now), false, 'page ouverte il y a moins de 2 min');
  t.auto.loadedAt = now - 5 * MIN;
  store.set('wmstats.auto', JSON.stringify({ tab: 'autre', until: now + 5 * MIN, at: now - 40 * MIN }));
  assert.equal(t.autoDue(now), false, 'un autre onglet relève');
  store.set('wmstats.auto', JSON.stringify({ tab: 'autre', until: 0, at: now - 10 * MIN }));
  assert.equal(t.autoDue(now), false, 'dernier relevé il y a 10 min');
  store.set('wmstats.auto', JSON.stringify({ tab: 'autre', until: 0, at: now - 31 * MIN }));
  assert.equal(t.autoDue(now), true);
  t.db.autoPauseUntil = now + MIN;
  assert.equal(t.autoDue(now), false, 'en pause après une limite du site');
});

test('autoRun : 60 prix finaux au plus, les plus utiles d’abord, puis le relevé des fins d’enchères', async () => {
  const now = Date.now();
  const { t, requests, store } = load({
    fast: true,
    fetch: async url => (url.startsWith('/api/marketplace/')
      ? reply({ auction: { card_id: 'K', final_price: 12, settled_at: iso(now - 5 * MIN), status: 'settled_sold' } })
      : reply({ auctions: [], hasMore: true }))
  });
  t.db.ov.autoObs = true;
  t.db.collectionFullAt = t.db.wishFullAt = Date.now(); // collection et liste à jour : sinon le passage les relirait d'abord
  t.db.cards = { x1: { cardId: 'K', title: 'Ma carte', rarity: 'C', count: 1 } };
  t.db.prices = { K: { at: Date.now(), sales: [] } };
  t.db.finQ = {};
  for (let i = 0; i < 70; i++) t.db.finQ['f' + i] = ['C' + i, 'C', now - 10 * MIN, 1];
  t.db.finQ.mine = ['K', 'C', now - 10 * MIN, 0];
  await t.autoRun();
  const details = requests.filter(u => /^\/api\/marketplace\/[^?]+$/.test(u));
  assert.equal(details.length, 60);
  assert.equal(details[0], '/api/marketplace/mine');
  assert.equal(requests.filter(u => u.startsWith('/api/marketplace?')).length, 19);
  assert.equal(t.db.autoLast.finals, 60);
  assert.equal(JSON.parse(store.get('wmstats.auto')).until, 0);
  assert.equal(t.auto.busy, false);
});

test('autoRun s’arrête dès qu’un relevé manuel démarre', async () => {
  const now = Date.now();
  let t;
  ({ t } = load({
    fast: true,
    fetch: async () => { t.job.running = true; return reply({ auction: { card_id: 'K', final_price: 3, settled_at: iso(now) } }); }
  }));
  t.db.ov.autoObs = true;
  t.db.collectionFullAt = t.db.wishFullAt = Date.now();
  t.db.finQ = { g1: ['A', 'C', now - 10 * MIN, 1], g2: ['B', 'C', now - 10 * MIN, 1] };
  await t.autoRun();
  assert.equal(t.db.autoLast.finals, 1);
  assert.equal(t.auto.busy, false);
});
