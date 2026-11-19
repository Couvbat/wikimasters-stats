// Tests de la réception par le fil du pool (1.28.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');
const T = '2026-11-15T10:00:00.000Z';

// ----- Tâche 3 : briques -----
test('plafond des ventes observées : 50 000 cartes en IndexedDB, 8 000 en mode secours', async () => {
  const idb = load({ idb: {} });
  await idb.ready;
  assert.equal(idb.t.obsCardsMax(), 50000);
  assert.equal(load().t.obsCardsMax(), 8000);
});

test('mode IndexedDB : plus de 8 000 cartes observées sont gardées', async () => {
  const { t, ready } = load({ idb: {} });
  await ready;
  const sales = Array.from({ length: 9000 }, (_, i) => ['K' + i, 10, T, 0, 1, '', null]);
  t.mergeObserved({ sales });
  assert.equal(Object.keys(t.db.obsSales).length, 9000);
});

test('un exact à la même date et au même prix rend exact le provisoire sans enchère', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5 }, null);
  assert.equal(t.addObserved('C1', { p: 30, t: T, g: 0, x: true, i: 'A1' }, null), true);
  assert.deepEqual(plain(t.db.obsSales.C1), [{ p: 30, t: T, g: 0, i: 'A1', x: 1 }]);
});

test('dropProvisional retire le provisoire et la file des prix finaux, jamais un exact', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5, i: 'A1' }, null);
  t.addObserved('C2', { p: 40, t: T, g: 0, i: 'A2', x: true }, null);
  t.db.finQ.A1 = ['C1', 'SR', Date.parse(T), 1];
  assert.equal(t.dropProvisional(['A1', 'A2', 'A3']), 1);
  assert.equal(t.db.obsSales.C1, undefined, 'carte vidée : retirée');
  assert.equal(t.db.obsSales.C2.length, 1);
  assert.equal(t.db.finQ.A1, undefined);
});

// ----- Tâche 4 : fusion d'une page -----
const page = (o = {}) => Object.assign({ pool: 'p1', max: 0, next: 0, more: false, sales: [], pro: [], unsold: [] }, o);

test('page : ventes Pro avec leur relevé, ventes observées, sorte inconnue ignorée', () => {
  const { t } = load();
  const n = t.applyFeedPage(page({
    sales: [[1, 'C1', 50, T, 'pro', '', 0, 'SR'], [2, 'C2', 30, T, 'prov', 'A1', 4, null], [3, 'C3', 9, T, 'futur', '', 0, null]],
    pro: [[4, 'C1', 1700000000000, 'Paul']]
  }));
  assert.ok(n >= 2);
  assert.deepEqual(plain(t.db.prices.C1), { at: 1700000000000, sales: [{ p: 50, t: T, r: 'SR' }], by: 'Paul' });
  assert.deepEqual(plain(t.db.obsSales.C2), [{ p: 30, t: T, g: 4, i: 'A1' }]);
  assert.equal(t.db.obsSales.C3, undefined);
  assert.equal(t.db.prices.C3, undefined);
});

test('page : vente Pro sans son relevé rangée à la date 1, puis la date arrive seule', () => {
  const { t } = load();
  t.applyFeedPage(page({ sales: [[1, 'C1', 50, T, 'pro', '', 0, null]] }));
  assert.equal(t.db.prices.C1.at, 1);
  t.applyFeedPage(page({ pro: [[2, 'C1', 1700000000000, 'Paul']] }));
  assert.equal(t.db.prices.C1.at, 1700000000000);
  assert.equal(t.db.prices.C1.by, 'Paul');
  assert.equal(t.db.prices.C1.sales.length, 1);
  t.applyFeedPage(page({ pro: [[3, 'C9', 1700000000000, 'Paul']] }));
  assert.equal(t.db.prices.C9, undefined, 'pas de relevé vide');
});

test('page : unsold et vente Pro d’une enchère retirent le provisoire', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5, i: 'A1' }, null);
  t.addObserved('C2', { p: 20, t: T, g: 5, i: 'A2' }, null);
  t.applyFeedPage(page({ unsold: [[1, 'A1']], sales: [[2, 'C2', 25, T, 'pro', 'A2', 0, null]] }));
  assert.equal(t.db.obsSales.C1, undefined);
  assert.equal(t.db.obsSales.C2, undefined);
  assert.equal(t.db.prices.C2.sales[0].p, 25);
});

// ----- Tâche 5 : le passage -----
const POOL = 'https://pool.test', KEY = 'cle-du-groupe-assez-longue-123';
// rows : [[table, rev, ...champs]] ; state : { pool, fail(since), status (du fil seulement), body }.
function feedEnv(rows, state = {}) {
  const calls = [];
  const fetch = async url => {
    if (!url.startsWith(POOL)) return reply({});
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname === '/v1/pull') return reply({ cards: {} });
    if (u.pathname === '/v1/profiles') return reply({ profiles: [] });
    if (u.pathname !== '/v1/feed') return reply({ error: 'route' }, 404);
    if (state.status) return reply({ error: 'x' }, state.status);
    const since = Number(u.searchParams.get('since')), limit = Number(u.searchParams.get('limit'));
    if (state.fail && state.fail(since)) throw new TypeError('Failed to fetch');
    if (state.body) return reply(state.body);
    const todo = rows.filter(r => r[1] > since).sort((a, b) => a[1] - b[1]);
    const part = todo.slice(0, limit), last = part.length ? part[part.length - 1][1] : since;
    const pick = k => part.filter(r => r[0] === k).map(r => r.slice(1));
    return reply({ pool: state.pool || 'p1', max: rows.reduce((m, r) => Math.max(m, r[1]), 0), next: last, more: todo.length > limit,
      sales: pick('s'), pro: pick('p'), unsold: pick('u') });
  };
  return { fetch, calls };
}
async function feedLoad(rows, state) {
  const f = feedEnv(rows, state);
  const env = load({ idb: {}, fast: true, fetch: f.fetch });
  await env.ready;
  Object.assign(env.t.db.pool, { url: POOL + '/', key: KEY, on: true });
  return Object.assign(env, { calls: f.calls });
}
const sale = (rev, card) => ['s', rev, card, 10 + rev, T, 'exact', 'A' + rev, 0, null];
const many = n => Array.from({ length: n }, (_, i) => sale(i + 1, 'C' + (i % 7)));

test('première réception sur plusieurs pages, puis passage vide', async () => {
  const env = await feedLoad(many(12001));
  const { t, calls } = env;
  await t.poolFeed(true);
  assert.deepEqual(calls, ['/v1/feed?since=0&limit=5000', '/v1/feed?since=5000&limit=5000', '/v1/feed?since=10000&limit=5000']);
  assert.equal(t.db.pool.feed.rev, 12001);
  assert.equal(t.db.pool.feed.got, 12001);
  assert.equal(t.db.pool.feed.url, POOL, 'adresse normalisée, sans / final');
  assert.ok(t.db.pool.feed.at > 0);
  await t.poolFeed(true);
  assert.equal(calls.at(-1), '/v1/feed?since=12001&limit=5000');
});

test('une page en échec : la position reste à la dernière page fusionnée, puis reprend sans trou', async () => {
  let broken = true;
  const env = await feedLoad(many(12001), { fail: since => broken && since === 5000 });
  await env.t.poolFeed(true);
  assert.equal(env.t.db.pool.feed.rev, 5000);
  assert.ok(env.t.db.pool.err);
  broken = false;
  await env.t.poolFeed(true);
  assert.equal(env.t.db.pool.feed.rev, 12001);
});

test('corps inattendu : échec, position inchangée', async () => {
  const env = await feedLoad(many(10), { body: { hello: 1 } });
  await env.t.poolFeed(true);
  assert.equal(env.t.db.pool.feed.rev, 0);
  assert.ok(env.t.db.pool.err);
  assert.ok(env.t.db.pool.retryAt > Date.now());
});

test('retour à zéro : autre identifiant de pool, position au-delà de max, autre adresse', async () => {
  const state = { pool: 'p1' };
  const env = await feedLoad(many(10), state);
  const { t, calls } = env;
  await t.poolFeed(true);
  t.db.pool.feed.rev = 50; // base restaurée plus ancienne
  await t.poolFeed(true);
  assert.equal(t.db.pool.feed.rev, 10);
  assert.ok(calls.includes('/v1/feed?since=50&limit=5000') && calls.at(-1) === '/v1/feed?since=0&limit=5000');
  state.pool = 'p2';
  await t.poolFeed(true);
  assert.equal(t.db.pool.feed.pool, 'p2');
  assert.equal(calls.at(-1), '/v1/feed?since=0&limit=5000');
  t.db.pool.url = POOL; // même adresse sans / : pas de retour à zéro
  await t.poolFeed(true);
  assert.equal(calls.at(-1), '/v1/feed?since=10&limit=5000');
});

test('pool en 1.3.0 (404) : fil noté absent, ancienne méthode, nouvel essai au bout de 6 h', async () => {
  const env = await feedLoad([], { status: 404 });
  await env.t.poolFeed(true);
  assert.equal(env.t.feedOn(), false);
  assert.ok(env.t.db.pool.feed.off > 0);
  assert.equal(env.t.db.pool.err, '', 'un 404 du fil n’est pas une erreur du pool');
  env.t.db.pool.feed.off = Date.now() - 6 * 36e5 - 1;
  assert.equal(env.t.feedOn(), true);
  env.t.db.pool.feed.off = Date.now();
  env.t.db.pool.url = 'https://autre-pool.test';
  assert.equal(env.t.feedOn(), true, 'le 404 vaut pour une adresse');
});

test('mode secours : pas de fil ; une base neuve a sa position à zéro', () => {
  const { t } = load();
  assert.deepEqual(plain(t.db.pool.feed), { url: '', pool: '', rev: 0, at: 0, off: 0, got: 0 });
  Object.assign(t.db.pool, { url: POOL, key: KEY, on: true });
  assert.equal(t.feedOn(), false);
});

test('deux appels simultanés : une seule série de requêtes ; sans force, pas deux passages en moins d’une minute', async () => {
  const env = await feedLoad(many(10));
  await Promise.all([env.t.poolFeed(true), env.t.poolFeed(true)]);
  assert.equal(env.calls.length, 1);
  await env.t.poolFeed();
  assert.equal(env.calls.length, 1);
});

// ----- Tâche 6 : branchement -----
test('poolTick lance un passage toutes les 15 min, et aussi quand la date du dernier est dans le futur', async () => {
  const env = await feedLoad(many(3));
  const { t, calls } = env;
  await t.poolTick(Date.now());
  assert.equal(calls.length, 1);
  await t.poolTick(Date.now() + 5 * 6e4);
  assert.equal(calls.length, 1, 'moins de 15 min : rien');
  t.db.pool.feed.at = Date.now() + 36e5; // horloge reculée
  await t.poolTick(Date.now());
  assert.equal(calls.length, 2);
});

test('fil actif : poolPullMine passe par le fil, poolWant et poolPrefetch se taisent', async () => {
  const env = await feedLoad(many(3));
  const { t, calls } = env;
  await t.poolPullMine(true);
  assert.ok(calls.some(c => c.startsWith('/v1/feed')));
  assert.ok(!calls.some(c => c === '/v1/pull'));
  const before = calls.length;
  t.poolWant('C9');
  await t.poolPrefetch(['C9']);
  await new Promise(r => setImmediate(r)); // fast : le regroupement de 2 s de poolWant passe tout de suite
  assert.equal(calls.length, before);
});

test('pool en 1.3.0 : poolPullMine retombe sur /v1/pull dans le même appel', async () => {
  const env = await feedLoad([], { status: 404 });
  env.t.db.wish = { C1: ['Carte', 'SR'] };
  await env.t.poolPullMine(true);
  assert.ok(env.calls.includes('/v1/pull'));
});

test('ligne d’état : à jour, puis ancienne méthode', async () => {
  const env = await feedLoad(many(3));
  await env.t.poolFeed(true);
  assert.match(env.t.poolLine(), /à jour à l’instant/);
  env.t.db.pool.feed.off = Date.now();
  env.t.db.pool.feed.at = 0;
  assert.match(env.t.poolLine(), /ancienne méthode \(pool en 1\.3\.0\)/);
});
