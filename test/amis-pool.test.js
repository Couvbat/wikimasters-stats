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

// ----- Tâche 3 : recevoir les profils des autres -----
const profile = (id, pseudo, at = 1000) => ({ id, pseudo, at, cards: [['C1', 'Titre', 'L', 2]], wish: [['W1', 'Souhait', 'UR']] });

test('profils reçus : amis du pool, au format des fichiers', () => {
  const { t } = setup();
  t.applyProfiles([profile('U2', 'Paul'), profile('U3', 'Marie')]);
  assert.deepEqual(plain(t.db.friends.Paul), { at: 1000, cards: { C1: ['Titre', 'L', 2] }, wish: { W1: ['Souhait', 'UR'] }, src: 'pool', id: 'U2' });
  assert.equal(t.db.friends.Marie.id, 'U3');
});

test('le compte connecté est exclu, l’autre compte du joueur apparaît', () => {
  const { t } = setup();
  t.applyProfiles([profile('U1', 'Jules'), profile('U9', 'Jules')]);
  assert.deepEqual(Object.keys(t.db.friends), ['Jules']);
  assert.equal(t.db.friends.Jules.id, 'U9');
});

test('deux membres au même pseudo', () => {
  const { t } = setup();
  t.applyProfiles([profile('U4', 'Paul'), profile('U2', 'Paul')]);
  assert.equal(t.db.friends.Paul.id, 'U2');
  assert.equal(t.db.friends['Paul (2)'].id, 'U4');
});

test('membre parti : retiré ; ami venu d’un fichier : gardé', () => {
  const { t } = setup();
  t.applyProfiles([profile('U2', 'Paul')]);
  t.db.friends['Zoé'] = { at: 5, cards: {}, wish: {} };
  t.applyProfiles([]);
  assert.deepEqual(Object.keys(t.db.friends), ['Zoé']);
});

test('fichier plus récent : pas écrasé', () => {
  const { t } = setup();
  t.db.friends['Zoé'] = { at: 2000, cards: { X: ['Fichier', 'C', 1] }, wish: {} };
  t.applyProfiles([profile('U5', 'Zoé', 1000)]);
  assert.equal(t.db.friends['Zoé'].src, undefined, 'le fichier reste');
  t.applyProfiles([profile('U5', 'Zoé', 3000)]);
  assert.equal(t.db.friends['Zoé'].src, 'pool');
});

test('pseudo changé : l’ancien nom disparaît', () => {
  const { t } = setup();
  t.applyProfiles([profile('U2', 'Paul')]);
  t.applyProfiles([profile('U2', 'Paulo')]);
  assert.deepEqual(Object.keys(t.db.friends), ['Paulo']);
});

test('poolPullMine lit aussi les profils', async () => {
  const { t, sent } = setup({ profiles: [profile('U2', 'Paul')] });
  await t.poolPullMine(true);
  assert.equal(sent('/v1/profiles').length, 1);
  assert.equal(t.db.friends.Paul.src, 'pool');
});

test('serveur pas encore à jour (404 sur les profils) : pas d’erreur affichée', async () => {
  const { t } = setup();
  const env = load({ fast: true, fetch: async url => (url.startsWith(POOL) ? reply({ error: 'route inconnue' }, url.endsWith('/v1/profiles') ? 404 : 200) : reply({})) });
  Object.assign(env.t.db.pool, { url: POOL, key: KEY, on: true });
  assert.equal(await env.t.poolPullProfiles(), 0);
  assert.equal(env.t.db.pool.err, '');
  assert.ok(t);
});

test('les amis du pool ne comptent pas dans la limite de 10', async () => {
  const { t } = setup();
  t.applyProfiles(Array.from({ length: 10 }, (_, i) => profile('P' + i, 'Membre ' + i)));
  const file = JSON.stringify({ wmstats: 1, pseudo: 'Zoé', at: 1, cards: [['C1', 'T', 'L', 1]], wish: [] });
  await t.importFriend({ size: file.length, text: async () => file });
  assert.ok(t.db.friends['Zoé'], 'le fichier est importé malgré 10 amis du pool');
});

// ----- Relecture finale -----
test('case décochée sur un autre compte : le profil publié par ce compte est retiré à sa prochaine lecture', async () => {
  const { t, sent } = setup();
  t.db.pool.share = true;
  assert.equal(await t.poolSendProfile(), true);
  t.db.pool.share = false; // décochée depuis l'autre compte du navigateur : rien n'a été retiré pour celui-ci
  await t.poolPullMine(true);
  assert.deepEqual(plain(sent('/v1/profile/remove').map(c => c.body)), [{ id: 'U1' }]);
  await t.poolPullMine(true);
  assert.equal(sent('/v1/profile/remove').length, 1, 'une seule fois');
});

// ----- Relecture Copilot (PR #14) -----
const later = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

test('décocher retire les profils de tous les comptes qui ont publié', async () => {
  const { t, sent } = setup();
  t.db.pool.published = { U1: 1, U9: 1 };
  await t.setProfileShare(false);
  assert.deepEqual(plain(sent('/v1/profile/remove').map(c => c.body.id)).sort(), ['U1', 'U9']);
  assert.deepEqual(plain(t.db.pool.published), {});
});

test('compte changé pendant la publication : c’est le compte qui a publié qui est marqué', async () => {
  const gate = later();
  const env = load({ fast: true, fetch: async url => { if (url.endsWith('/v1/profile')) await gate.p; return reply({ ok: true }); } });
  const t = env.t;
  Object.assign(t.db.pool, { url: POOL, key: KEY, on: true, share: true });
  t.db.userId = 'U1'; t.db.me = 'Jules';
  const sending = t.poolSendProfile();
  await tick();
  t.db.userId = 'U2';
  gate.release();
  await sending;
  assert.deepEqual(plain(t.db.pool.published), { U1: 1 });
});

test('prix désactivés : décocher le partage retire quand même le profil', async () => {
  const { t, sent } = setup();
  t.db.pool.on = false;
  t.db.pool.published = { U1: 1 };
  await t.setProfileShare(false);
  assert.equal(sent('/v1/profile/remove').length, 1);
});

test('décocher pendant une publication : le retrait part après elle', async () => {
  const gate = later();
  let profileDone = false, removeAfter = null;
  const env = load({ fast: true, fetch: async url => {
    if (url.endsWith('/v1/profile')) { await gate.p; profileDone = true; }
    if (url.endsWith('/v1/profile/remove')) removeAfter = profileDone;
    return reply({ ok: true });
  } });
  const t = env.t;
  Object.assign(t.db.pool, { url: POOL, key: KEY, on: true, share: true });
  t.db.userId = 'U1'; t.db.me = 'Jules';
  const sending = t.poolSendProfile();
  await tick();
  const unsharing = t.setProfileShare(false);
  await tick();
  gate.release();
  await sending; await unsharing;
  assert.equal(removeAfter, true, 'le retrait est envoyé une fois la publication terminée');
  assert.deepEqual(plain(t.db.pool.published), {});
});

test('titre de plus de 200 caractères : coupé, le profil part', async () => {
  const { t } = setup();
  t.db.cards = { e1: { cardId: 'C1', title: 'x'.repeat(300), rarity: 'L', count: 1 } };
  t.db.wish = {};
  assert.equal(t.profileBody().cards[0][1].length, 200);
});

test('fichier plus récent et deux homonymes : le second reçoit bien « (2) »', () => {
  const { t } = setup();
  t.db.friends.Paul = { at: 2000, cards: {}, wish: {} };
  t.applyProfiles([profile('U2', 'Paul', 1000), profile('U4', 'Paul', 1000)]);
  assert.equal(t.db.friends.Paul.src, undefined, 'le fichier plus récent reste');
  assert.equal(t.db.friends['Paul (2)'] && t.db.friends['Paul (2)'].id, 'U4');
});
