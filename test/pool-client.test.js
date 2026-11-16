// Tests du client du pool partagé dans le script : file d'envoi, points d'accroche, envoi, réception, enchères connues.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');

const POOL = 'https://pool.test';
const KEY = 'cle-du-groupe-assez-longue-123';
const T = '2026-11-15T10:00:00.000Z', T2 = '2026-11-15T11:00:00.000Z';
const MIN = 6e4;

// Pool simulé : répond aux routes /v1/* et note chaque appel. site(url) répond pour le site.
function setup({ fail = false, status = 200, pull = {}, known = {}, site = () => reply({}) } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    if (url.startsWith(POOL)) {
      const path = url.slice(POOL.length);
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ path, body, key: init && init.headers && init.headers['x-group-key'] });
      if (fail) throw new TypeError('Failed to fetch');
      if (status !== 200) return reply({ error: 'refusé' }, status);
      if (path === '/v1/push') return reply({ added: (body.pro || []).length + (body.sales || []).length, upgraded: 0, dropped: 0 });
      if (path === '/v1/pull') return reply({ cards: Object.fromEntries(Object.entries(pull).filter(([id]) => body.cards.includes(id))) });
      if (path === '/v1/known') return reply({ exact: Object.fromEntries(Object.entries(known).filter(([id]) => body.auctions.includes(id))) });
      if (path === '/v1/stats') return reply({ sales: 3, cards: 2, members: 1, lastPushAt: 1 });
      return reply({ error: 'route' }, 404);
    }
    return site(url);
  };
  const env = load({ fast: true, fetch });
  env.calls = calls;
  return env;
}
const enable = t => Object.assign(t.db.pool, { url: POOL, key: KEY, on: true });

// ----- Tâche 4 : file d'envoi et points d'accroche -----
test('pool désactivé : rien ne part en file', () => {
  const { t } = setup();
  assert.equal(t.poolOn(), false);
  t.poolQueue('s', ['C1', 5, T, 0, 1, 'A1', 'R']);
  assert.equal(t.db.poolQ.length, 0);
});

test('un relevé Pro part en file avec sa rareté', () => {
  const { t } = setup();
  enable(t);
  t.ingestSales('C1', { recent: [{ final_price: 50, settled_at: T }] }, 'SR');
  assert.deepEqual(plain(t.db.poolQ), [['p', ['C1', t.db.prices.C1.at, [[50, T]], 'SR']]]);
});

test('prix final lu et enchère invendue partent en file', () => {
  const { t } = setup();
  enable(t);
  t.db.finQ = { A1: ['C2', 'R', Date.now() - 10 * MIN, 1], A3: ['C3', 'R', Date.now() - 10 * MIN, 1] };
  t.ingestFinal('A1', { auction: { card_id: 'C2', final_price: 40, settled_at: T, snapshot_rarity: 'R' } });
  t.ingestFinal('A3', { auction: { card_id: 'C3', final_price: null, settled_at: T } });
  assert.deepEqual(plain(t.db.poolQ), [['s', ['C2', 40, T, 0, 1, 'A1', 'R']], ['u', 'A3']]);
});

test('un prix provisoire créé à la fin d’une enchère suivie part en file', () => {
  const { t } = setup();
  enable(t);
  const end = Date.now() - 5 * MIN;
  t.db.obs = { A5: ['C5', 30, 1, end, end - 2 * MIN, 'SR'] };
  t.settleObserved();
  assert.deepEqual(plain(t.db.poolQ), [['s', ['C5', 30, new Date(end).toISOString(), 2, 0, 'A5', 'SR']]]);
});

test('mes ventes et achats partent en file une seule fois', () => {
  const { t } = setup();
  enable(t);
  const page = { history: [{ id: 'H1', card_id: 'C9', final_price: 77, base_amount: 10, settled_at: T, card: { wikipedia_title: 'X', rarity: 'UR' } }] };
  t.ingestMarket(page);
  t.ingestMarket(page);
  assert.deepEqual(plain(t.db.poolQ), [['s', ['C9', 77, T, 0, 1, 'H1', 'UR']]]);
});

test('ce qui vient d’un fichier ou du pool ne repart jamais', () => {
  const { t } = setup();
  enable(t);
  t.mergeObserved({ sales: [['C1', 5, T, 0, 1, 'Z1']] });
  t.mergePro([['C2', Date.now() - 1000, [[9, T]], 'Paul']], 'Paul');
  assert.equal(t.db.poolQ.length, 0);
});

test('activer le partage envoie mes propres relevés déjà accumulés, pas ceux reçus d’amis', () => {
  const { t } = setup();
  enable(t);
  t.db.prices = { MINE: { at: 100, sales: [{ p: 5, t: T }] }, FRIEND: { at: 200, sales: [{ p: 6, t: T }], by: 'Paul' }, EMPTY: { at: 300, sales: [] } };
  t.db.auctions = { H2: ['b', 'C7', 'Y', 'L', 5, 5, 300, T2, 0], H3: ['u', 'C8', 'Z', 'R', 5, 5, null, T2, 0], H4: ['s', 'C9', 'W', 'R', 5, 5, 99, T2, 1] };
  t.poolBackfill();
  assert.deepEqual(plain(t.db.poolQ), [['p', ['MINE', 100, [[5, T]], null]], ['s', ['C7', 300, T2, 0, 1, 'H2', 'L']]]);
});

test('poolFlush envoie le lot avec la clé et vide la file', async () => {
  const { t, calls } = setup();
  enable(t);
  t.db.me = 'Jules';
  t.poolQueue('p', ['C1', 100, [[5, T]], 'R']);
  t.poolQueue('s', ['C2', 8, T, 0, 1, 'A2', 'R']);
  t.poolQueue('u', 'A3');
  await t.poolFlush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v1/push');
  assert.equal(calls[0].key, KEY);
  assert.deepEqual(calls[0].body, { member: 'Jules', pro: [['C1', 100, [[5, T]], 'R']], sales: [['C2', 8, T, 0, 1, 'A2', 'R']], unsold: ['A3'] });
  assert.equal(t.db.poolQ.length, 0);
  assert.equal(t.db.pool.sent, 3);
});

test('mauvaise clé : file gardée, erreur affichée, attente qui double, pas d’essai pendant l’attente', async () => {
  const { t, calls } = setup({ status: 401 });
  enable(t);
  t.poolQueue('u', 'A1');
  await t.poolFlush();
  assert.equal(t.db.poolQ.length, 1);
  assert.match(t.db.pool.err, /401/);
  assert.equal(t.db.pool.wait, MIN);
  await t.poolTick(Date.now());
  assert.equal(calls.length, 1, 'pas de nouvel essai pendant l’attente');
  await t.poolFlush(t.db.pool.retryAt + 1);
  assert.equal(t.db.pool.wait, 2 * MIN);
});

test('file plafonnée à 20 000, envoi en plusieurs lots', async () => {
  const { t, calls } = setup();
  enable(t);
  for (let i = 0; i <= 20000; i++) t.poolQueue('u', 'A' + i);
  assert.equal(t.db.poolQ.length, 20000);
  assert.equal(t.db.poolQ[0][1], 'A1');
  t.db.poolQ = [];
  for (let i = 0; i < 6000; i++) t.poolQueue('s', ['C', 5, T, 0, 1, 'S' + i, 'R']);
  await t.poolFlush();
  assert.equal(calls[0].body.sales.length, 5000);
  await t.poolFlush();
  assert.equal(calls[1].body.sales.length, 1000);
  assert.equal(t.db.poolQ.length, 0);
});

// ----- Tâche 5 : réception, enchères déjà connues, relevés Pro sautés -----
test('poolPull fusionne le relevé Pro (avec son auteur) et les ventes observées', async () => {
  const { t } = setup({ pull: { C1: { pro: { at: Date.now() - MIN, by: 'Marie', sales: [[50, T]] }, sales: [[45, T2, 0, 1, 'A1']] } } });
  enable(t);
  const n = await t.poolPull(['C1', 'C2']);
  assert.ok(n >= 2);
  assert.equal(t.db.prices.C1.by, 'Marie');
  assert.equal(t.db.obsSales.C1[0].x, 1);
  assert.equal(t.db.obsSales.C1[0].i, 'A1');
  assert.ok(t.db.pool.recv >= 2);
  assert.equal(t.db.poolQ.length, 0, 'rien de reçu ne repart');
});

test('poolPull : mes propres relevés revenus du pool n’ont pas d’étiquette « partagé »', async () => {
  const { t } = setup({ pull: { C1: { pro: { at: Date.now() - MIN, by: 'Marie', sales: [[50, T]] }, sales: [] } } });
  enable(t);
  t.db.me = 'Marie';
  await t.poolPull(['C1']);
  assert.equal(t.db.prices.C1.by, undefined);
});

test('écho : une vente déjà connue localement ne se double pas', async () => {
  const { t } = setup({ pull: { C1: { pro: null, sales: [[45, T2, 0, 1, 'A1']] } } });
  enable(t);
  t.db.obsSales = { C1: [{ p: 45, t: T2, g: 0, i: 'A1', x: 1 }] };
  await t.poolPull(['C1']);
  assert.equal(t.db.obsSales.C1.length, 1);
});

test('enchères déjà connues du pool : elles ne sont pas relues sur le site', async () => {
  const now = Date.now();
  const { t, requests } = setup({
    known: { A1: ['C1', 70, T] },
    site: url => reply({ auction: { card_id: 'C2', final_price: 12, settled_at: T2 } })
  });
  enable(t);
  t.db.finQ = { A1: ['C1', 'R', now - 10 * MIN, 1], A2: ['C2', 'R', now - 10 * MIN, 1] };
  await t.fetchFinals('status');
  const site = requests.filter(u => u.startsWith('/api/marketplace/'));
  assert.deepEqual(site, ['/api/marketplace/A2']);
  assert.equal(t.db.obsSales.C1[0].p, 70);
  assert.deepEqual(Object.keys(t.db.finQ), []);
});

test('pool injoignable : les prix finaux sont quand même lus sur le site', async () => {
  const now = Date.now();
  const { t, requests } = setup({ fail: true, site: () => reply({ auction: { card_id: 'C1', final_price: 9, settled_at: T } }) });
  enable(t);
  t.db.finQ = { A1: ['C1', 'R', now - 10 * MIN, 1], A2: ['C2', 'R', now - 10 * MIN, 1] };
  await t.fetchFinals('status');
  assert.equal(requests.filter(u => u.startsWith('/api/marketplace/')).length, 2);
  assert.ok(t.db.pool.err);
});

test('relevés Pro : une carte au relevé frais dans le pool n’est pas redemandée au site', async () => {
  const { t, requests } = setup({ pull: { C1: { pro: { at: Date.now(), by: 'Marie', sales: [[50, T]] }, sales: [] } } });
  enable(t);
  t.db.userId = 'U1';
  t.db.pro = { U1: true };
  t.db.cards = { x1: { cardId: 'C1', title: 'A', rarity: 'SR', count: 1 } };
  await t.fillPrices();
  assert.equal(requests.filter(u => u.includes('/sales')).length, 0);
  assert.equal(t.db.prices.C1.by, 'Marie');
});

test('poolPullMine : au plus toutes les 6 h, sauf si on force', async () => {
  const { t, calls } = setup({ pull: {} });
  enable(t);
  t.db.cards = { x1: { cardId: 'C1', title: 'A', rarity: 'SR', count: 1 } };
  t.db.wish = { W1: ['Souhait', 'L'] };
  t.db.pool.pullAt = Date.now() - 60 * MIN;
  await t.poolPullMine();
  assert.equal(calls.length, 0);
  await t.poolPullMine(true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.cards.sort(), ['C1', 'W1']);
});

test('la clé du groupe n’est ni dans la sauvegarde ni dans le fichier ami', () => {
  const { t } = setup();
  enable(t);
  t.db.cards = { x1: { cardId: 'C1', title: 'A', rarity: 'R', count: 1 } };
  assert.equal(JSON.stringify(t.backupData()).includes(KEY), false);
  assert.equal(JSON.stringify(t.friendExport('Jules')).includes(KEY), false);
});
