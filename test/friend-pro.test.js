// Tests du partage de l'historique Pro dans le fichier ami.
// Lancer : node --test test/*.test.js
// Le script est chargé dans un contexte simulé (pas de page, pas de site) ; une ligne ajoutée à la fin
// expose ses fonctions internes dans window.__t.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wikimasters-stats.user.js'), 'utf8');
const END = SRC.lastIndexOf('})();');
const CODE = SRC.slice(0, END) +
  'window.__t = { get db() { return db; }, set db(v) { db = v; }, ui, friendExport, parseFriend, mergePro, importFriend, mergeBackup, priceOf, relCell, badgeFor };\n' +
  SRC.slice(END);

class El {
  constructor(tag) { this.tagName = tag; this.title = ''; this.textContent = ''; this.className = ''; this.children = []; this.attrs = {}; this.style = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener() {}
  append(...k) { this.children.push(...k); }
  replaceChildren(...k) { this.children = k; }
}

// reject(texte) : renvoie true pour simuler un navigateur plein au moment d'enregistrer ce texte.
function load({ reject = () => false } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (reject(String(v))) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: k => store.delete(k)
  };
  const window = { fetch: async () => ({}), addEventListener() {}, innerWidth: 1000, innerHeight: 800 };
  const document = { readyState: 'loading', addEventListener() {}, createElement: t => new El(t), createElementNS: (n, t) => new El(t) };
  const ctx = { window, document, localStorage, setInterval: () => 0, setTimeout, clearTimeout, console, URL };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const t = window.__t;
  t.ui.el.frStatus = { textContent: '' };
  return { t, store };
}
// Les objets nés dans le contexte simulé ont leurs propres prototypes : on les compare en JSON.
const plain = v => JSON.parse(JSON.stringify(v));
const fakeFile = text => ({ size: text.length, text: async () => text });

const T1 = '2026-11-01T10:00:00.000Z', T2 = '2026-11-02T10:00:00.000Z', T3 = '2026-10-02T10:00:00.000Z';

// Jules a un compte Pro : des relevés, dont un reçu de Paul et un vide, et quelques ventes et achats.
function jules() {
  const { t } = load();
  t.db.me = 'Jules';
  t.db.cards = { x1: { cardId: 'A', title: 'Alpha', rarity: 'R', count: 2 } };
  t.db.prices = {
    A: { at: 100, sales: [{ p: 5, t: T1 }] },
    B: { at: 300, sales: [{ p: 7, t: T2 }, { p: 9, t: T3 }] },
    C: { at: 500, sales: [] },
    D: { at: 200, sales: [{ p: 3, t: T1 }], by: 'Paul' }
  };
  t.db.auctions = {
    a1: ['s', 'E', 'Epsilon', 'R', 10, 10, 42, T1, 0],
    a2: ['u', 'F', 'Phi', 'R', 10, 10, null, T1, 0],
    a3: ['b', 'G', 'Gamma', 'SR', 5, 5, 80, T2, 0],
    a4: ['s', 'H', 'Eta', 'R', 5, 5, 99, T2, 1]
  };
  return t;
}

// ----- Tâche 1 : export -----
test('friendExport partage les relevés Pro non vides, les plus récents d’abord, avec leur origine', () => {
  const data = plain(jules().friendExport('Jules'));
  assert.equal(data.wmstats, 1);
  assert.equal(data.pseudo, 'Jules');
  assert.deepEqual(data.pro, [
    ['B', 300, [[7, T2], [9, T3]], 'Jules'],
    ['D', 200, [[3, T1]], 'Paul'],
    ['A', 100, [[5, T1]], 'Jules']
  ]);
  assert.deepEqual(data.cards, [['A', 'Alpha', 'R', 2]]);
});

test('friendExport ajoute mes ventes et achats comme prix finaux exacts, sans les invendues ni les shiny', () => {
  const sales = plain(jules().friendExport('Jules')).seen.sales;
  assert.deepEqual(sales.find(s => s[5] === 'a1'), ['E', 42, T1, 0, 1, 'a1']);
  assert.deepEqual(sales.find(s => s[5] === 'a3'), ['G', 80, T2, 0, 1, 'a3']);
  assert.equal(sales.some(s => s[5] === 'a2' || s[5] === 'a4'), false);
});

// ----- Tâche 2 : import -----
test('l’import d’un fichier ami verse ses relevés Pro et ses ventes dans mes prix', async () => {
  const text = JSON.stringify(jules().friendExport('Jules'));
  const { t } = load();
  t.db.me = 'Marie';
  await t.importFriend(fakeFile(text));
  assert.deepEqual(plain(t.db.prices.B), { at: 300, sales: [{ p: 7, t: T2 }, { p: 9, t: T3 }], by: 'Jules' });
  assert.equal(t.db.prices.D.by, 'Paul');
  assert.equal(t.db.prices.C, undefined);
  assert.deepEqual(plain(t.db.obsSales.E), [{ p: 42, t: T1, g: 0, i: 'a1', x: 1 }]);
  assert.ok(t.db.friends.Jules);
  assert.match(t.ui.el.frStatus.textContent, /3 relevés Pro ajoutés/);
});

test('mergePro ramène une date future à maintenant', () => {
  const { t } = load();
  const before = Date.now();
  assert.equal(t.mergePro([['A', before + 1e10, [[5, T1]], 'X']], 'X'), 1);
  assert.ok(t.db.prices.A.at <= Date.now() && t.db.prices.A.at >= before);
});

test('mergePro garde mon relevé quand il est plus récent, remplace un plus ancien', () => {
  const { t } = load();
  t.db.prices = { A: { at: 1000, sales: [{ p: 1, t: T1 }] }, B: { at: 100, sales: [{ p: 1, t: T1 }] } };
  assert.equal(t.mergePro([['A', 500, [[9, T1]]], ['B', 500, [[9, T1]]]], 'Marie'), 1);
  assert.equal(t.db.prices.A.sales[0].p, 1);
  assert.deepEqual(plain(t.db.prices.B), { at: 500, sales: [{ p: 9, t: T1 }], by: 'Marie' });
});

test('mergePro n’étiquette pas « partagé » mes propres prix qui me reviennent', () => {
  const { t } = load();
  t.db.me = 'Jules';
  t.mergePro([['A', 500, [[9, T1]], 'Jules']], 'Marie');
  assert.equal(t.db.prices.A.by, undefined);
});

test('mergePro ignore les entrées malformées sans planter', () => {
  const { t } = load();
  const n = t.mergePro([
    null, 'x', ['__proto__', 5, [[1, T1]]], ['A', 5, [[-1, T1], [NaN, T1], ['3', T1]]], ['B', 5, []],
    ['C', 5, [[4, T1]], { evil: 1 }], ['D', -3, [[4, T1]]], ['E', 5, 'nope']
  ], 'Marie');
  assert.equal(n, 1);
  assert.deepEqual(Object.keys(t.db.prices), ['C']);
  assert.equal(t.db.prices.C.by, 'Marie');
  assert.equal(t.mergePro('pas une liste', 'Marie'), 0);
});

test('mergePro refuse les ventes sans date valide et garde alors mon relevé', () => {
  const { t } = load();
  t.db.prices = { A: { at: 100, sales: [{ p: 5, t: T1 }] } };
  assert.equal(t.mergePro([['A', 500, [[999, ''], [998, 'pas une date']]]], 'Marie'), 0);
  assert.deepEqual(plain(t.db.prices.A), { at: 100, sales: [{ p: 5, t: T1 }] });
  assert.equal(t.mergePro([['B', 500, [[999, ''], [7, T2]]]], 'Marie'), 1);
  assert.deepEqual(plain(t.db.prices.B.sales), [{ p: 7, t: T2 }]);
});

test('navigateur déjà plein avant les relevés Pro : l’import échoue et le dit', async () => {
  const text = JSON.stringify(jules().friendExport('Jules'));
  const { t, store } = load({ reject: s => s.includes('"Jules":{') });
  t.db.me = 'Marie';
  await t.importFriend(fakeFile(text));
  assert.equal(t.db.friends.Jules, undefined);
  assert.equal(t.db.obsSales.E, undefined);
  assert.match(t.ui.el.frStatus.textContent, /Import impossible : plus assez de place/);
  assert.equal(store.has('wmstats.v1'), false);
});

test('navigateur plein : les relevés Pro sont annulés, l’ami reste importé', async () => {
  const text = JSON.stringify(jules().friendExport('Jules'));
  const { t, store } = load({ reject: s => s.includes('"by":"Jules"') });
  t.db.me = 'Marie';
  t.db.prices = { Z: { at: 50, sales: [{ p: 2, t: T1 }] } };
  await t.importFriend(fakeFile(text));
  assert.deepEqual(Object.keys(t.db.prices), ['Z']);
  assert.ok(t.db.friends.Jules);
  assert.match(t.ui.el.frStatus.textContent, /plus assez de place/);
  const saved = JSON.parse(store.get('wmstats.v1'));
  assert.ok(saved.friends.Jules);
  assert.equal(saved.prices.B, undefined);
});

// ----- Tâche 3 : origine affichée, gardée par la sauvegarde -----
test('l’origine d’un relevé partagé apparaît dans la fiabilité et dans la bulle', () => {
  const { t } = load();
  t.mergePro([['B', 300, [[7, T2], [9, T3]], 'Jules']], 'Jules');
  const p = t.priceOf('B');
  assert.equal(p.by, 'Jules');
  assert.match(t.relCell(p).title, /relevé partagé par Jules/);
  assert.match(t.badgeFor('B', null, {}).lines[0], /partagé par Jules/);
});

test('un relevé à moi n’a pas d’origine', () => {
  const { t } = load();
  t.db.prices = { A: { at: 100, sales: [{ p: 5, t: T1 }] } };
  assert.equal(t.priceOf('A').by, '');
  assert.doesNotMatch(t.relCell(t.priceOf('A')).title, /partagé/);
});

test('la sauvegarde garde l’origine des relevés', () => {
  const { t } = load();
  t.mergeBackup(JSON.stringify({ wmstatsBackup: 1, at: 1, data: { prices: { A: { at: 100, sales: [{ p: 5, t: T1 }], by: 'Paul' } } } }));
  assert.equal(t.db.prices.A.by, 'Paul');
});
