// Tests : amis par le pool (profils : collection et souhaits partagés, au choix de chacun).
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');

const POOL = 'https://pool.test';
const KEY = 'cle-du-groupe-assez-longue-123';

// Pool simulé : note chaque appel (méthode, chemin, corps). profiles : ce que renvoie GET /v1/profiles.
function setup({ fail = false, profiles = [] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    if (url.startsWith(POOL)) {
      const path = url.slice(POOL.length);
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ method: (init && init.method) || 'GET', path, body });
      if (fail) throw new TypeError('Failed to fetch');
      if (path === '/v1/profiles') return reply({ profiles });
      if (path === '/v1/pull') return reply({ cards: {} });
      return reply({ ok: true });
    }
    return reply({});
  };
  const env = load({ fast: true, fetch });
  const t = env.t;
  Object.assign(t.db.pool, { url: POOL, key: KEY, on: true });
  t.db.userId = 'U1';
  t.db.me = 'Jules';
  t.ui.el.poolInfo = { textContent: '' };
  env.calls = calls;
  env.sent = path => calls.filter(c => c.path === path);
  return env;
}
const item = (id, card, rarity) => ({ id, user_id: 'U1', card: { id: card, wikipedia_title: 'Titre ' + card, rarity } });
const tick = () => new Promise(r => setImmediate(r));

// ----- Tâche 2 : publier et retirer son profil -----
test('case cochée : la collection relue part en profil', async () => {
  const { t, sent } = setup();
  t.db.pool.share = true;
  t.db.wish = { W1: ['Souhait', 'UR'] };
  t.ingestCollection([item('e1', 'C1', 'L'), item('e2', 'C1', 'L'), item('e3', 'C2', 'R')], true);
  await tick();
  const p = sent('/v1/profile');
  assert.equal(p.length, 1);
  assert.equal(p[0].body.id, 'U1');
  assert.equal(p[0].body.pseudo, 'Jules');
  assert.deepEqual(plain(p[0].body.cards).sort(), [['C1', 'Titre C1', 'L', 2], ['C2', 'Titre C2', 'R', 1]]);
  assert.deepEqual(plain(p[0].body.wish), [['W1', 'Souhait', 'UR']]);
});

test('case décochée : rien ne part', async () => {
  const { t, sent } = setup();
  t.ingestCollection([item('e1', 'C1', 'L')], true);
  await tick();
  assert.equal(sent('/v1/profile').length, 0);
});

test('liste de souhaits relue : le profil part aussi', async () => {
  const { t, sent } = setup();
  t.db.pool.share = true;
  t.ingestWish({ cards: [{ id: 'W1', wikipedia_title: 'Souhait', rarity: 'UR' }] }, true);
  await tick();
  assert.equal(sent('/v1/profile').length, 1);
});

test('sans pseudo : rien ne part, la case se décoche', async () => {
  const { t, calls } = setup();
  t.db.me = '';
  await t.setProfileShare(true);
  assert.equal(calls.length, 0);
  assert.equal(t.db.pool.share, false);
  assert.match(t.ui.el.poolInfo.textContent, /Écris d’abord ton pseudo dans l’onglet Amis/);
});

test('décocher retire le profil', async () => {
  const { t, sent } = setup();
  t.db.pool.share = true;
  await t.setProfileShare(false);
  assert.equal(t.db.pool.share, false);
  assert.deepEqual(plain(sent('/v1/profile/remove').map(c => c.body)), [{ id: 'U1' }]);
});

test('pool injoignable : pas de plantage, erreur notée', async () => {
  const { t } = setup({ fail: true });
  t.db.pool.share = true;
  assert.equal(await t.poolSendProfile(), false);
  assert.ok(t.db.pool.err);
});
