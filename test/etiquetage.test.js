// Tests : étiquetage par lots. Le script prépare un lot (une règle, une de tes étiquettes existantes), et c'est ton clic
// qui l'applique, en une seule requête à la base du site, comme son mode « Sélectionner ».
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');

const SB = 'https://ref123.supabase.co';
const TAGS = [{ id: 'tag-vendre', name: 'À vendre', color: '#f00', user_id: 'U1' }, { id: 'tag-def', name: 'Défausse', color: '#888', user_id: 'U1' }];
const T = '2026-11-15T10:00:00.000Z';
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

// Le site lit tes étiquettes sur sa base, avec ta session : le script écoute cet appel.
async function withSession(env) {
  await env.window.fetch(SB + '/rest/v1/tags?select=*&user_id=eq.U1', { headers: { apikey: 'ANON-KEY', Authorization: 'Bearer SESSION-TOKEN' } });
  await new Promise(r => setImmediate(r));
}
function collection(t) {
  const card = (id, title, rarity, count, extra = {}) => Object.assign({ cardId: 'C' + id, title, rarity, count, tags: [], starred: false }, extra);
  t.db.cards = {
    [uuid(1)]: card(1, 'Doublon', 'R', 2),
    [uuid(2)]: card(2, 'Sans valeur', 'C', 1),
    [uuid(3)]: card(3, 'Légende', 'L', 1),
    [uuid(4)]: card(4, 'Déjà rangée', 'L', 1, { tags: ['À vendre'] }),
    C5: card(5, 'Ancienne clé', 'L', 1) // rangée sous l'identifiant de la carte, pas de l'exemplaire : on ne sait pas l'étiqueter
  };
  t.db.cards.C5.cardId = 'C5';
  const sales = (p, r) => [0, 1, 2].map(() => ({ p, t: T, r }));
  t.db.prices = { C2: { at: Date.now(), sales: sales(1, 'C') }, C3: { at: Date.now(), sales: sales(5000, 'L') }, C4: { at: Date.now(), sales: sales(4000, 'L') }, C5: { at: Date.now(), sales: sales(3000, 'L') } };
}

test('le script retient tes étiquettes et la session du site, sans jamais enregistrer la session', async () => {
  const env = load({ fast: true, fetch: async url => (url.startsWith(SB + '/rest/v1/tags') ? reply(TAGS) : reply({})) });
  await withSession(env);
  assert.deepEqual(plain(env.t.db.tagCat), [{ id: 'tag-vendre', name: 'À vendre', color: '#f00' }, { id: 'tag-def', name: 'Défausse', color: '#888' }]);
  assert.equal(env.t.sbSession.base, SB);
  env.t.saveDb();
  for (const v of env.store.values()) assert.equal(v.includes('SESSION-TOKEN') || v.includes('ANON-KEY'), false);
});

test('règles : doublons, sans valeur, rareté, valeur minimale ; sans les cartes déjà étiquetées ni les anciennes clés', () => {
  const { t } = load();
  collection(t);
  t.db.tagCat = [{ id: 'tag-vendre', name: 'À vendre', color: '#f00' }];
  const ids = b => plain(b.items.map(x => x.id)).sort();
  assert.deepEqual(ids(t.tagBatch('dupes', 'tag-vendre')), [uuid(1)]);
  assert.deepEqual(ids(t.tagBatch('discard', 'tag-vendre')), [uuid(2)]);
  assert.deepEqual(ids(t.tagBatch('rarity', 'tag-vendre', { rarity: 'L' })), [uuid(3)]);
  assert.deepEqual(ids(t.tagBatch('value', 'tag-vendre', { min: 1000 })), [uuid(3)]);
  assert.equal(t.tagBatch('dupes', 'inconnue').items.length, 0);
});

test('appliquer un lot : une seule requête, puis les cartes portent l’étiquette', async () => {
  const sent = [];
  const env = load({ fast: true, fetch: async (url, init) => {
    if (url.startsWith(SB + '/rest/v1/tags')) return reply(TAGS);
    if (url.startsWith(SB + '/rest/v1/user_card_tags')) { sent.push({ url, init }); return reply(null, 201); }
    return reply({});
  } });
  await withSession(env);
  const t = env.t;
  collection(t);
  const batch = t.tagBatch('rarity', 'tag-vendre', { rarity: 'L' });
  const res = await t.applyTagBatch(batch);
  assert.equal(res.n, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers.apikey, 'ANON-KEY');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer SESSION-TOKEN');
  assert.deepEqual(JSON.parse(sent[0].init.body), [{ user_card_id: uuid(3), tag_id: 'tag-vendre' }]);
  assert.ok(t.db.cards[uuid(3)].tags.includes('À vendre'));
  assert.equal(t.tagBatch('rarity', 'tag-vendre', { rarity: 'L' }).items.length, 0, 'déjà fait');
});

test('session expirée ou absente : rien ne change, et le message dit quoi faire', async () => {
  const env = load({ fast: true, fetch: async url => (url.startsWith(SB + '/rest/v1/tags') ? reply(TAGS)
    : url.startsWith(SB + '/rest/v1/user_card_tags') ? reply({ message: 'JWT expired' }, 401) : reply({})) });
  const t = env.t;
  collection(t);
  t.db.tagCat = [{ id: 'tag-vendre', name: 'À vendre', color: '#f00' }];
  await assert.rejects(() => t.applyTagBatch(t.tagBatch('dupes', 'tag-vendre')), /recharge/);
  await withSession(env);
  await assert.rejects(() => t.applyTagBatch(t.tagBatch('dupes', 'tag-vendre')), /session/);
  assert.deepEqual(plain(t.db.cards[uuid(1)].tags), []);
});

test('un lot est plafonné à 200 exemplaires', () => {
  const { t } = load();
  t.db.cards = {};
  for (let i = 0; i < 250; i++) t.db.cards[uuid(1000 + i)] = { cardId: 'D' + i, title: 'X' + i, rarity: 'R', count: 2, tags: [] };
  t.db.tagCat = [{ id: 'tag-vendre', name: 'À vendre', color: '#f00' }];
  const b = t.tagBatch('dupes', 'tag-vendre');
  assert.equal(b.items.length, 200);
  assert.equal(b.total, 250);
});
