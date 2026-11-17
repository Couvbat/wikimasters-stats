// Tests : mise à jour automatique (prix relus selon leur valeur, routine, bouton « Tout mettre à jour maintenant »).
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply } = require('./harness');

const H = 36e5, DAY = 24 * H;
const iso = ms => new Date(ms).toISOString();
// Un prix relu il y a « age » ms, avec n ventes de la rareté r au prix p.
const priced = (age, r, p = 10, n = 3) => ({ at: Date.now() - age, sales: Array.from({ length: n }, (_, i) => ({ p, t: iso(Date.now() - age - i * H), r })) });
const card = (cardId, rarity, count = 1) => ({ cardId, title: 'Carte ' + cardId, rarity, count });

// ----- Tâche 1 : quand relire, dans quel ordre -----
test('priceDue : délais par rareté', () => {
  const { t } = load();
  const due = (r, age) => { t.db.prices = { X: priced(age, r, 5) }; t.resetPrices(); return t.priceDue('X', r); };
  assert.equal(due('L', 25 * H), true);
  assert.equal(due('L', 23 * H), false);
  assert.equal(due('SR', 47 * H), false);
  assert.equal(due('SR', 49 * H), true);
  assert.equal(due('R', 3 * DAY), false);
  assert.equal(due('R', 5 * DAY), true);
  assert.equal(due('C', 6 * DAY), false);
  assert.equal(due('C', 8 * DAY), true);
});

test('priceDue : une carte qui vaut plus de 50 ₩ ou en vente se relit chaque jour', () => {
  const { t } = load();
  t.db.prices = { V: priced(25 * H, 'R', 60), W: priced(25 * H, 'R', 40), S: priced(25 * H, 'C', 2) };
  t.resetPrices();
  assert.equal(t.priceDue('V', 'R'), true, 'R à 60 ₩');
  assert.equal(t.priceDue('W', 'R'), false, 'R à 40 ₩ : 4 jours');
  assert.equal(t.priceDue('S', 'C'), false);
  t.db.selling = [{ i: 'a1', c: 'S', t: 'S', r: 'C' }];
  assert.equal(t.priceDue('S', 'C'), true, 'en vente');
});

test('priceDue : sans prix, et historique vide douteux', () => {
  const { t } = load();
  t.db.prices = { E: { at: Date.now() - 2 * H, sales: [] } };
  assert.equal(t.priceDue('N', 'C'), true, 'jamais relue');
  assert.equal(t.priceDue('E', 'L'), true, 'L sans vente depuis 2 h');
});

test('dueCards : de la plus lourde à la plus légère', () => {
  const { t } = load();
  t.db.cards = { a: card('A', 'C', 5), b: card('B', 'C'), r: card('R1', 'R'), n: card('N', 'R'), p: card('P', 'PC') };
  t.db.prices = { A: priced(8 * DAY, 'C', 10), B: priced(8 * DAY, 'C', 100), R1: priced(1 * H, 'R', 30) };
  t.resetPrices();
  const list = t.dueCards();
  const ids = list.map(x => x[0]);
  assert.ok(ids.indexOf('B') < ids.indexOf('A'), '100 × 1 avant 10 × 5');
  assert.equal(list.find(x => x[0] === 'N')[2], 30, 'jamais relue : la médiane de sa rareté');
  assert.equal(list.find(x => x[0] === 'P')[2], 1, 'aucune PC connue : poids 1, mais présente');
  assert.ok(!ids.includes('R1'), 'relue il y a une heure');
});

test('dueCards : les souhaits en vente comptent, une seule fois', () => {
  const { t } = load();
  const ask = id => ({ a: 5, b: false, e: Date.now() + H, i: 'au' + id, t: Date.now(), r: 'L', list: [{ i: 'au' + id, a: 5, b: false, e: Date.now() + H, r: 'L' }] });
  t.db.wish = { W1: ['Souhait', 'L'], W2: ['Possédé', 'L'], W3: ['Pas en vente', 'L'] };
  t.db.market.asks = { W1: ask('W1'), W2: ask('W2') };
  t.db.cards = { w2: card('W2', 'L') };
  const ids = t.dueCards().map(x => x[0]);
  assert.ok(ids.includes('W1'));
  assert.equal(ids.filter(id => id === 'W2').length, 1);
  assert.ok(!ids.includes('W3'));
});

test('Relever les prix suit priceDue', () => {
  const { t } = load();
  t.ui.chosen = new Set(['L', 'UR', 'SR', 'R', 'PC', 'C']);
  t.db.cards = { c: card('C1', 'C'), l: card('L1', 'L') };
  t.db.prices = { C1: priced(3 * DAY, 'C', 2), L1: priced(25 * H, 'L', 5) };
  t.resetPrices();
  assert.deepEqual([...t.missingIds()], ['L1']);
});

// ----- Tâche 2 : la routine et le passage en arrière-plan -----
// Site simulé : routes [motif, réponse(url)] d'abord, puis des réponses par défaut. calls garde chaque URL demandée.
function siteEnv(routes = [], opts = {}) {
  const calls = [];
  let env;
  const fetch = async url => {
    calls.push(url);
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, env);
    if (/\/sales$/.test(url)) return reply({ sales: [{ final_price: 5, settled_at: iso(Date.now() - H), rarity: 'C' }] });
    if (url.startsWith('/api/marketplace?')) return reply({ auctions: [], hasMore: false });
    if (url.startsWith('https://pool.test/v1/known')) return reply({ exact: {} });
    return reply({});
  };
  env = load(Object.assign({ fast: true, fetch }, opts));
  const t = env.t;
  t.db.userId = 'U1';
  t.db.pro = { U1: true };
  t.db.ov.autoObs = true;
  t.db.collectionFullAt = Date.now();
  t.db.wishFullAt = Date.now();
  env.calls = calls;
  env.sales = () => calls.filter(u => /\/sales$/.test(u));
  return env;
}
const manyCards = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ['e' + i, card('K' + i, 'C', i + 1)]));

test('passage : 60 requêtes au plus, les plus lourdes d’abord', async () => {
  const env = siteEnv();
  env.t.db.cards = manyCards(100);
  await env.t.autoRun();
  assert.equal(env.sales().length, 60);
  assert.equal(env.sales()[0], '/api/marketplace/cards/K99/sales', '100 exemplaires : la plus lourde');
  assert.equal(env.t.db.autoLast.prices, 60);
});

test('passage : 20 alertes au plus', async () => {
  const env = siteEnv();
  env.t.db.pro = { U1: false };
  for (let i = 0; i < 30; i++) env.t.db.alerts['a' + i] = ['W' + i, 'Souhait ' + i, Date.now() - H, 0];
  await env.t.autoRun();
  assert.equal(env.calls.filter(u => u.includes('&q=')).length, 20);
  assert.equal(env.t.db.autoLast.alerts, 20);
});

test('passage : le pool d’abord', async () => {
  const env = siteEnv([[/^https:\/\/pool\.test\/v1\/pull/, () => reply({ cards: { C1: { pro: { at: Date.now(), by: 'Marie', sales: [[50, iso(Date.now() - H), 'C']] }, sales: [] } } })]]);
  Object.assign(env.t.db.pool, { url: 'https://pool.test', key: 'cle-du-groupe-assez-longue-123', on: true });
  env.t.db.cards = { a: card('C1', 'C'), b: card('C2', 'C') };
  await env.t.autoRun();
  assert.ok(!env.sales().includes('/api/marketplace/cards/C1/sales'), 'le pool avait C1');
  assert.ok(env.sales().includes('/api/marketplace/cards/C2/sales'));
});

const collPage = (from, n) => reply({ collection: Array.from({ length: n }, (_, i) => ({ id: 'e' + (from + i), user_id: 'U1',
  card: { id: 'K' + (from + i), wikipedia_title: 'K' + (from + i), rarity: 'C' } })) });

test('passage : collection de plus de 24 h relue en entier, puis arrêt', async () => {
  const env = siteEnv([[/^\/api\/my-collection/, url => (/page=0/.test(url) ? collPage(0, 50) : collPage(50, 10))]]);
  env.t.db.collectionFullAt = 0;
  await env.t.autoRun();
  assert.equal(Object.keys(env.t.db.cards).length, 60);
  assert.equal(env.sales().length, 0, 'le passage s’arrête après la collection');
  assert.equal(env.t.db.autoLast.collection, true);
});

test('passage : collection interrompue, rien n’est remplacé', async () => {
  const env = siteEnv([[/^\/api\/my-collection/, url => (/page=0/.test(url) ? collPage(0, 50) : reply({}, 500))]]);
  env.t.db.collectionFullAt = 0;
  env.t.db.cards = { old: card('OLD', 'L') };
  await env.t.autoRun();
  assert.deepEqual(Object.keys(env.t.db.cards), ['old']);
});

test('passage : liste de souhaits de plus de 24 h relue', async () => {
  const env = siteEnv([[/^\/api\/cards\?.*wishlist=1/, () => reply({ cards: [{ id: 'W1', wikipedia_title: 'Souhait', rarity: 'L' }], total: 1 })]]);
  env.t.db.wishFullAt = 0;
  await env.t.autoRun();
  assert.ok(env.calls.some(u => /wishlist=1/.test(u)));
  assert.ok(env.t.db.wishFullAt > 0);
  assert.deepEqual(Object.keys(env.t.db.wish), ['W1']);
});

test('passage : compte non Pro, aucune requête /sales', async () => {
  const env = siteEnv();
  env.t.db.pro = { U1: false };
  env.t.db.cards = manyCards(5);
  await env.t.autoRun();
  assert.equal(env.sales().length, 0);
});

test('passage : limite du site, arrêt et pause de 24 h', async () => {
  const env = siteEnv([[/\/sales$/, () => reply({ code: 'automation_limit' }, 403)]]);
  env.t.db.cards = manyCards(5);
  await env.t.autoRun();
  assert.equal(env.sales().length, 1);
  assert.ok(env.t.db.autoPauseUntil > Date.now() + 23 * H);
});

test('passage : le verrou est renouvelé à chaque requête', async () => {
  const locks = [];
  const env = siteEnv([[/\/sales$/, (url, e) => {
    locks.push(JSON.parse(e.store.get('wmstats.auto') || '{}').until);
    return reply({ sales: [] });
  }]]);
  env.t.db.cards = manyCards(5);
  await env.t.autoRun();
  assert.equal(locks.length, 5);
  for (const until of locks) assert.ok(until >= Date.now() + 90e3, 'verrou tenu pour au moins 1 min 30');
  assert.equal(JSON.parse(env.store.get('wmstats.auto')).until, 0, 'libéré à la fin');
});
