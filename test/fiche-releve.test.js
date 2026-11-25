// Tests : ce que dit la fiche après « Relever les ventes » (1.32.1). Vu sur le site le 25 novembre : un prix déjà à jour, ou la pause
// imposée par le site, faisaient dire « Tous les prix étaient dans le pool du groupe. », même quand le pool n'y était pour rien,
// et l'historique sautait sans rien dire.
// Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply } = require('./harness');

const POOL = 'https://pool.test', KEY = 'cle-du-groupe-assez-longue-123';
const T = '2026-11-25T10:00:00.000Z', MIN = 6e4;
const PH = { calculated_at: '2026-11-25T09:00:00Z', by_rarity: { SR: [{ week_start: '2026-11-16', avg_price: 50, min_price: 40, max_price: 60, sales_count: 3 }] } };

// La fiche de C1 (SR) ouverte ; site(url) répond pour le site, pull pour le pool (s'il est branché).
function fiche({ pool = false, pull = {}, site = url => reply(/price-history/.test(url) ? PH : { recent: [] }) } = {}) {
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    if (url.startsWith(POOL)) {
      const body = init && init.body ? JSON.parse(init.body) : {};
      if (url.endsWith('/v1/pull')) return reply({ cards: Object.fromEntries(Object.entries(pull).filter(([id]) => (body.cards || []).includes(id))) });
      return reply({});
    }
    return site(url);
  };
  const env = load({ fast: true, fetch });
  const { t } = env;
  t.db.userId = 'U1';
  if (pool) Object.assign(t.db.pool, { url: POOL, key: KEY, on: true });
  for (const k of ['cardHead', 'cardBody']) t.ui.el[k] = { replaceChildren() {} };
  t.ui.el.cardStatus = { textContent: '' };
  t.openCard('C1', { rarity: 'SR', title: 'X' });
  return Object.assign(env, { urls, status: () => t.ui.el.cardStatus.textContent });
}
const siteSales = urls => urls.filter(u => /\/sales/.test(u));

test('fiche : prix déjà relevé il y a peu, pool branché : pas de nouveau relevé, et la fiche le dit sans parler du pool', async () => {
  const env = fiche({ pool: true });
  const now = Date.now();
  env.t.db.prices.C1 = { at: now - 10 * MIN, ats: { SR: now - 10 * MIN }, sales: [{ p: 50, t: T, r: 'SR' }] };
  await env.t.cardFetchNow();
  assert.deepEqual(siteSales(env.urls), [], 'pas de relevé des ventes');
  assert.match(env.status(), /déjà à jour \(relevé il y a 10 min\)/);
  assert.doesNotMatch(env.status(), /pool/);
});

test('fiche : le prix manquant vient du pool : la fiche le dit', async () => {
  const env = fiche({ pool: true, pull: { C1: { pro: { at: Date.now() - MIN, by: 'Marie', sales: [[50, T, 'SR']] }, sales: [] } } });
  await env.t.cardFetchNow();
  assert.deepEqual(siteSales(env.urls), []);
  assert.match(env.status(), /^Tous les prix étaient dans le pool du groupe\./);
});

test('fiche : pendant la pause imposée par le site, l’historique n’est pas relevé et la fiche dit jusqu’à quand', async () => {
  const env = fiche();
  const until = Date.now() + 2 * 3600e3;
  env.t.db.autoPauseUntil = until;
  await env.t.cardFetchNow();
  assert.equal(env.urls.filter(u => /price-history/.test(u)).length, 0, 'pas d’historique demandé');
  const hm = new Date(until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  assert.match(env.status(), new RegExp('Historique non relevé : le site a mis en pause les relevés automatiques jusqu’au .* à ' + hm));
});
