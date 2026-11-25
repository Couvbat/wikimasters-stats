// Tests de la fiche par carte (1.29.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const DAY = 864e5, NOW = Date.now();
const iso = d => new Date(NOW - d * DAY).toISOString();
const sale = (d, p, r = 'SR', more = {}) => Object.assign({ p, t: iso(d), r }, more);
const nb = s => String(s).replace(/[  ]/g, ' ');
const textOf = n => (n == null || n === false ? '' : Array.isArray(n) ? n.map(textOf).join(' ')
  : typeof n === 'object' ? (n.textContent || '') + ' ' + (n.children || []).map(textOf).join(' ') : String(n));
const find = (n, pred, out = []) => {
  if (Array.isArray(n)) { for (const k of n) find(k, pred, out); return out; }
  if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const k of n.children || []) find(k, pred, out); }
  return out;
};

// ----- Tâche 1 : la source des ventes -----
test('source de la fiche : celle de priceOf, avec toutes ses ventes (l’historique Pro passe devant les prix observés)', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: Array.from({ length: 12 }, (_, i) => sale(i * 5, 100 + i)) };
  t.db.obsSales.C1 = [sale(1, 50, 'SR', { x: 1, i: 'A1' }), sale(2, 55, 'SR', { x: 1, i: 'A2' })];
  const src = t.cardSource('C1', 'SR');
  assert.equal(src.kind, 'pro');
  assert.equal(src.sales.length, 12);
  assert.equal(t.priceOf('C1', 'SR').nAll, 12, 'priceOf repose sur la même source');
});

test('source de la fiche : tes ventes sans historique Pro, sinon les prix observés', () => {
  const { t } = load();
  t.db.obsSales.C1 = [sale(1, 50, 'SR', { x: 1, i: 'A1' })];
  assert.equal(t.cardSource('C1', 'SR').kind, 'obs');
  t.db.mySales.C1 = [sale(3, 70)];
  assert.equal(t.cardSource('C1', 'SR').kind, 'own');
});

test('source de la fiche : aucune vente à la rareté voulue, pas de mélange ; les raretés qui ont des ventes', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 900, 'UR'), sale(2, 950, 'L')] };
  assert.deepEqual(plain(t.cardSource('C1', 'SR')), { kind: null, sales: [] });
  assert.equal(t.priceOf('C1', 'SR').mixed, true, 'priceOf, lui, se rabat sur les autres raretés');
  assert.deepEqual(plain(t.cardRarities('C1')), ['L', 'UR']);
});

// ----- Tâche 2 : les repères -----
const base5 = p => [10, 12, 14, 16, 18].map(d => sale(d, p));
// Prix qui évolue de `weekly` par semaine : 1000 ₩ aujourd'hui, n ventes espacées de 3,5 jours à partir d'hier.
const trend = (weekly, n = 8) => Array.from({ length: n }, (_, i) => { const d = 1 + i * 3.5; return sale(d, Math.round(1000 * Math.pow(1 + weekly, -d / 7))); });

test('repère 1 : plus cher, moins cher, dans son habitude', () => {
  const { t } = load();
  const m = sales => t.cardCues(sales, NOW, null).moment;
  let c = m([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)]);
  assert.equal(c.state, 'high'); assert.equal(c.pct, 30);
  c = m([sale(1, 80), sale(2, 80), sale(3, 80), ...base5(100)]);
  assert.equal(c.state, 'low'); assert.equal(c.pct, -20);
  assert.equal(m([sale(1, 105), sale(2, 105), sale(3, 105), ...base5(100)]).state, 'usual');
  const line = nb(t.cueLines(t.cardCues([sale(1, 80), sale(2, 80), sale(3, 80), ...base5(100)], NOW, null))[0].text);
  assert.match(line, /^moins cher que d’habitude \(−20 %\) · 7 derniers jours : 80 ₩ \(3 ventes\), 30 jours d’avant : 100 ₩ \(5 ventes\)$/);
});

test('repère 1 : pas assez de ventes pour comparer', () => {
  const { t } = load();
  const m = sales => t.cardCues(sales, NOW, null).moment.state;
  assert.equal(m([sale(1, 130), sale(2, 130), ...base5(100)]), 'few', '2 ventes sur 7 jours');
  assert.equal(m([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100).slice(0, 4)]), 'few', '4 ventes sur les 30 jours d’avant');
  assert.equal(nb(t.cueLines(t.cardCues([sale(1, 130)], NOW, null))[0].text), 'pas assez de ventes pour comparer');
});

test('repère 2 : en hausse, en baisse, stable', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope;
  let c = s(trend(0.10));
  assert.equal(c.state, 'up'); assert.ok(c.pct >= 9 && c.pct <= 11, String(c.pct));
  c = s(trend(-0.10));
  assert.equal(c.state, 'down'); assert.ok(c.pct <= -9 && c.pct >= -11, String(c.pct));
  assert.equal(s(trend(0.01)).state, 'flat');
  assert.equal(nb(t.cueLines(t.cardCues(trend(-0.10), NOW, null))[1].text), 'en baisse (−10 % par semaine)');
});

test('repère 2 : une vente aberrante ne renverse pas le sens ; moins de 6 ventes, pas de sens', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope.state;
  assert.equal(s([sale(0.5, 50000), ...trend(-0.10)]), 'down');
  assert.equal(s(trend(0.10, 5)), 'few');
});

test('repère 3 : environ N fois par semaine, par mois, ou aucune vente en 30 jours', () => {
  const { t } = load();
  const pace = sales => nb(t.cueLines(t.cardCues(sales, NOW, null))[2].text);
  assert.equal(pace(Array.from({ length: 9 }, (_, i) => sale(1 + i * 3, 100))), 'se vend environ 2 fois par semaine · dernière vente il y a 1 j');
  assert.match(pace([sale(2, 100), sale(9, 100), sale(20, 100)]), /^se vend environ 3 fois par mois · /);
  assert.equal(pace([sale(40, 100), sale(45, 100)]), 'aucune vente en 30 jours · dernière vente il y a 40 j');
});

test('repère 4 : la concurrence à la bonne rareté seulement, avec l’âge du relevé', () => {
  const { t } = load();
  const list = [{ a: 120, b: false, r: 'SR', i: 'A1' }, { a: 50, b: true, r: 'UR', i: 'A2' }, { a: 150, b: false, r: 'SR', i: 'A3' }];
  const line = asks => nb(t.cueLines(t.cardCues([sale(1, 100)], NOW, asks)).find(l => l.k === 'compete').text);
  assert.equal(line({ list, rarity: 'SR', seenAt: NOW - 2 * 36e5 }), '2 en vente, la moins chère à 120 ₩ · relevé il y a 2 h');
  assert.equal(line({ list: list.slice(1, 2), rarity: 'SR', seenAt: NOW - 3 * 36e5 }), 'aucune annonce connue à cette rareté (relevé il y a 3 h)');
  assert.equal(line({ list: [], rarity: 'SR', seenAt: 0 }), 'annonces jamais cherchées');
  assert.equal(t.cueLines(t.cardCues([sale(1, 100)], NOW, null)).some(l => l.k === 'compete'), false);
});

test('repères en court pour la bulle', () => {
  const { t } = load();
  assert.equal(nb(t.cueShort(t.cardCues([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)], NOW, null))), 'plus cher que d’habitude · en hausse');
  assert.equal(t.cueShort(t.cardCues([sale(1, 100)], NOW, null)), '');
});

test('repères : date illisible ignorée, date future comptée comme maintenant, ventes à la même date', () => {
  const { t } = load();
  const odd = [{ p: 100, t: 'n/a', r: 'SR' }, sale(-2, 130), sale(1, 130), sale(2, 130), ...base5(100)];
  const c = t.cardCues(odd, NOW, null);
  assert.equal(c.moment.n7, 3);
  assert.equal(c.moment.state, 'high');
  const same = Array.from({ length: 8 }, () => sale(3, 100));
  assert.equal(t.cardCues(same, NOW, null).slope.state, 'few', 'aucune paire de dates différentes');
  for (const s of [odd, same]) assert.doesNotMatch(t.cueLines(t.cardCues(s, NOW, null)).map(l => l.text).join(' '), /NaN|undefined|Infinity/);
});

// ----- Tâche 3 : la fiche dans le panneau -----
// Faux éléments de la fiche ; renvoie une fonction qui lit tout son texte.
function fiche(t) {
  const out = {};
  for (const k of ['cardHead', 'cardBody']) t.ui.el[k] = { replaceChildren(...kids) { out[k] = kids; } };
  t.ui.el.cardStatus = { textContent: '' };
  return Object.assign(() => nb(textOf([out.cardHead, out.cardBody])), { out });
}

test('fiche : repères, ce que la carte t’a coûté et ce que la vendre rapporterait', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 120), sale(3, 120), ...base5(100)] };
  t.db.cards.X1 = { cardId: 'C1', title: 'Paris', rarity: 'SR', count: 1, shiny: false };
  t.db.auctions.B1 = ['b', 'C1', 'Paris', 'SR', 50, 80, 80, iso(20), 0];
  const text = fiche(t);
  t.openCard('C1');
  t.renderCard();
  const s = text();
  assert.match(s, /Paris/);
  assert.match(s, /Prix du moment/);
  assert.match(s, /plus cher que d’habitude \(\+20 %\)/);
  assert.match(s, /achetée 80 ₩/);
  assert.match(s, /\+40 ₩/);
  assert.doesNotMatch(s, /\b(vends|achète)\b/i);
});

test('fiche ouverte depuis une annonce : écart à la valeur, bonne affaire et enchère max', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 120), sale(3, 120)] };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', au: { a: 70, b: false, r: 'SR', i: 'A1' }, title: 'Paris' });
  t.renderCard();
  const s = text();
  assert.match(s, /Face à l’annonce/);
  assert.match(s, /42 % sous la valeur/);
  assert.match(s, /bonne affaire −42 %/);
  assert.match(s, /enchère max conseillée : 120 ₩/);
});

test('fiche : aucune vente à cette rareté, pas de mélange, et les raretés qui en ont', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 900, 'UR'), sale(2, 950, 'UR')] };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.renderCard();
  const s = text();
  assert.match(s, /Aucune vente connue à cette rareté/);
  assert.match(s, /Ventes connues en : .*UR/);
  assert.doesNotMatch(s, /\b(900|950)\b/, 'aucune vente UR listée comme vente SR');
});

test('fiche : les 50 ventes les plus récentes, puis toutes', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: Array.from({ length: 80 }, (_, i) => sale(i * 0.5, 100 + i)) };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.renderCard();
  const rows = () => find(text.out.cardBody, n => n.tagName === 'tbody').reduce((a, b) => a + b.children.length, 0);
  assert.equal(rows(), 50);
  assert.match(text(), /Tout afficher \(80\)/);
  t.ui.card.all = true;
  t.renderCard();
  assert.equal(rows(), 80);
});

test('fiche : ← Retour et un onglet ramènent à l’onglet d’origine, fermer le panneau ferme la fiche', () => {
  const { t } = load();
  t.ui.el.back = { classList: { toggle() {} } };
  t.ui.tab = 'wish';
  t.openCard('C1', { title: 'Paris' });
  assert.equal(t.ui.card.from, 'wish');
  t.closeCard();
  assert.equal(t.ui.card, null);
  assert.equal(t.ui.tab, 'wish');
  t.openCard('C1', { title: 'Paris' });
  t.setTab('col');
  assert.equal(t.ui.card, null);
  assert.equal(t.ui.tab, 'col');
  t.openCard('C1', { title: 'Paris' });
  t.ui.open = true;
  t.toggle(false);
  assert.equal(t.ui.card, null);
});

test('fiche : actions grisées pendant un autre traitement, et recherche impossible sans le nom', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120)] };
  fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.job.running = true;
  t.renderCard();
  assert.equal(t.ui.el.cardSearch.disabled, true);
  t.job.running = false;
  t.syncButtons();
  assert.equal(t.ui.el.cardSearch.disabled, false);
  t.openCard('C9', { rarity: 'SR' });
  t.renderCard();
  assert.equal(t.ui.el.cardSearch.disabled, true, 'nom inconnu : la recherche par nom est impossible');
});

test('fiche d’une carte inconnue partout : aucune vente, pas de plantage', () => {
  const { t } = load();
  const text = fiche(t);
  t.openCard('C404');
  t.renderCard();
  assert.match(text(), /Aucune vente connue/);
  assert.doesNotMatch(text(), /NaN|undefined|Infinity/);
});

// ----- Tâche 4 : la courbe -----
test('courbe : axe des prix borné aux 2e et 98e centiles, sauf avec peu de ventes', () => {
  const { t } = load();
  const [lo, hi] = t.chartBounds(Array.from({ length: 49 }, (_, i) => 100 + i).concat([10000]));
  assert.ok(lo >= 100 && lo < 102, String(lo));
  assert.ok(hi >= 148 && hi < 1000, 'la vente aberrante ne fixe pas le haut de l’axe : ' + hi);
  assert.deepEqual(plain(t.chartBounds([10, 1000, 500])), [10, 1000]);
  assert.deepEqual(plain(t.chartBounds([100, 100, 100])), [99, 101]);
});

test('courbe : 30 jours par défaut, tout s’il y a moins de 10 ventes en 30 jours', () => {
  const { t } = load();
  assert.equal(t.defaultPeriod(Array.from({ length: 10 }, (_, i) => sale(i, 100)), NOW), '30');
  assert.equal(t.defaultPeriod(Array.from({ length: 9 }, (_, i) => sale(i, 100)).concat([sale(60, 100)]), NOW), 'all');
});

test('courbe : tes ventes et achats à la rareté affichée, sans les shiny ni les invendues', () => {
  const { t } = load();
  t.db.auctions = {
    S1: ['s', 'C1', 'Paris', 'SR', 50, 50, 130, iso(3), 0],
    B1: ['b', 'C1', 'Paris', 'SR', 50, 50, 90, iso(9), 0],
    B2: ['b', 'C1', 'Paris', 'UR', 50, 50, 900, iso(5), 0],
    B3: ['b', 'C1', 'Paris', 'SR', 50, 50, 400, iso(4), 1],
    U1: ['u', 'C1', 'Paris', 'SR', 50, 50, null, iso(2), 0]
  };
  assert.deepEqual(plain(t.cardMarks('C1', 'SR')).map(m => [m.k, m.p]), [['b', 90], ['s', 130]]);
});

test('courbe : point creux pour un provisoire, losange pour ta vente, détail au survol', () => {
  const { t } = load();
  const pts = [{ t: NOW - DAY, p: 120, k: 'pro' }, { t: NOW - 2 * DAY, p: 110, k: 'prov' }, { t: NOW - 12 * DAY, p: 100, k: 'exact' }];
  const svg = t.cardChart(pts, [{ t: NOW - 3 * DAY, p: 115, k: 's' }], '30', NOW);
  const circles = find(svg, n => n.tagName === 'circle');
  assert.equal(circles.length, 3);
  assert.equal(circles.filter(c => c.attrs.fill === 'none').length, 1, 'le provisoire est creux');
  assert.equal(find(svg, n => n.attrs && n.attrs['stroke-dasharray']).length, 0, 'plus de segments de médiane : le trait du prix médian les remplace');
  assert.equal(find(svg, n => n.tagName === 'path').length, 1, 'ta vente en losange');
  assert.match(nb(textOf(svg)), /provisoire/);
  assert.match(nb(textOf(svg)), /ta vente/);
});

test('courbe : ventes toutes au même prix, l’axe ne s’écrase pas', () => {
  const { t } = load();
  const svg = t.cardChart([1, 2, 3].map(d => ({ t: NOW - d * DAY, p: 100, k: 'pro' })), [], '30', NOW);
  for (const c of find(svg, n => n.tagName === 'circle')) assert.ok(Number.isFinite(Number(c.attrs.cy)), c.attrs.cy);
});

// ----- Tâche 5 : pastilles et bulle -----
test('bulle : les repères en court, et le clic vers la fiche', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)] };
  const lines = t.badgeFor('C1', null, {}).lines.map(nb);
  assert.ok(lines.includes('Repères : plus cher que d’habitude · en hausse'), lines.join('\n'));
  assert.equal(lines[lines.length - 1], 'Clic : fiche de la carte');
});

test('bulle : sans assez de ventes, pas de ligne de repères', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130), sale(2, 120)] };
  const lines = t.badgeFor('C1', null, {}).lines;
  assert.ok(!lines.some(l => l.startsWith('Repères')));
  assert.ok(lines.includes('Clic : fiche de la carte'));
});

test('bulle : de nouvelles ventes changent les repères sans attendre', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 100), sale(2, 100), sale(3, 100), ...base5(100)] };
  assert.ok(t.badgeFor('C1', null, {}).lines.map(nb).includes('Repères : dans son habitude · stable'));
  t.mergePro([['C1', NOW, [[150, iso(0.5), 'SR'], [150, iso(0.6), 'SR'], [150, iso(0.7), 'SR'], [150, iso(0.8), 'SR']]]]);
  assert.ok(t.badgeFor('C1', null, {}).lines.map(nb).some(l => /^Repères : plus cher que d’habitude/.test(l)));
});

test('clic sur une pastille : la fiche s’ouvre à la rareté de l’annonce, sans suivre le lien du site', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120, 'UR'), sale(2, 100, 'SR')] };
  t.db.cards.X1 = { cardId: 'C1', title: 'Paris', rarity: 'SR', count: 1, shiny: false };
  t.ui.tab = 'col';
  const b = t.badgeFor('C1', { a: 90, b: false, r: 'UR', i: 'A1' }, {});
  assert.equal(b.card.id, 'C1');
  b.card.title = 'Paris';
  const el = {};
  t.tipData.set(el, b);
  const calls = [];
  t.badgeClick({ target: { closest: () => el }, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  assert.deepEqual(calls, ['prevent', 'stop']);
  assert.equal(t.ui.card.id, 'C1');
  assert.equal(t.ui.card.rarity, 'UR', 'la rareté de l’annonce, comme la pastille');
  assert.equal(t.ui.card.au.a, 90);
  assert.equal(t.ui.card.from, 'col');
});

test('clic ailleurs sur la page : rien n’est intercepté', () => {
  const { t } = load();
  const calls = [];
  t.badgeClick({ target: { closest: () => null }, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  assert.deepEqual(calls, []);
  assert.equal(t.ui.card, null);
});

// ----- Relecture finale -----
test('repère 2 : des ventes groupées en quelques heures ou jours ne donnent pas de sens', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope;
  const h = (hours, p) => ({ p, t: new Date(NOW - DAY - hours * 36e5).toISOString(), r: 'SR' });
  assert.equal(s([0, 0.5, 1, 1.5, 2, 3].map((x, i) => h(x, 130 - i * 6))).state, 'few', '6 ventes en 3 heures');
  assert.equal(s([0, 0.003, 0.006, 0.009, 0.012, 0.015].map((x, i) => h(x, 2000 / Math.pow(2, i)))).state, 'few', '6 ventes en une minute');
  assert.equal(s(Array.from({ length: 8 }, (_, i) => sale(0.25 * i, 1000 - i * 60))).state, 'few', '8 ventes en 2 jours');
  const c = s([...[0, 0.5, 1, 1.5, 2, 3].map((x, i) => h(x, 130 - i * 6)), sale(10, 100), sale(20, 100)]);
  assert.ok(Number.isFinite(c.pct) && Math.abs(c.pct) < 100, String(c.pct));
  assert.doesNotMatch(t.cueLines(t.cardCues([0, 0.003, 0.006, 0.009, 0.012, 0.015].map((x, i) => h(x, 2000 / Math.pow(2, i))), NOW, null)).map(l => l.text).join(' '), /Infinity|NaN/);
});

test('clic sur une pastille sans annonce : la fiche s’ouvre à la rareté de la pastille', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 100, 'SR'), sale(2, 900, 'UR')] };
  t.db.cards = { a: { cardId: 'C1', title: 'Paris', rarity: 'SR', count: 1, shiny: false }, b: { cardId: 'C1', title: 'Paris', rarity: 'UR', count: 1, shiny: false } };
  const b = t.badgeFor('C1', null, {});
  const el = {};
  t.tipData.set(el, b);
  t.badgeClick({ target: { closest: () => el }, preventDefault() {}, stopPropagation() {} });
  assert.equal(t.ui.card.rarity, t.rarityOf('C1'), 'la rareté que la pastille a évaluée');
  assert.equal(t.ui.card.rarity, 'UR');
});

test('repères : 20 cartes à 300 ventes se calculent sans geler la page', () => {
  const { t } = load();
  const sales = Array.from({ length: 300 }, (_, i) => ({ p: 100 + (i * 37) % 50, t: new Date(NOW - (i / 10) * DAY - 36e5).toISOString(), r: 'SR' }));
  t.cardCues(sales, NOW, null);
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) t.cardCues(sales, NOW, null);
  const ms = performance.now() - t0;
  assert.ok(ms < 150, Math.round(ms) + ' ms');
});

// ----- Relecture Copilot -----
test('fiche : seulement des nœuds ou du texte passés à replaceChildren, comme le DOM réel le demande', () => {
  const { t } = load();
  const bad = [];
  const strict = name => ({ replaceChildren(...kids) {
    kids.forEach((k, i) => { if (!(typeof k === 'string' || (k && typeof k === 'object' && k.nodeType))) bad.push(name + '[' + i + '] = ' + (Array.isArray(k) ? 'tableau' : String(k))); });
  } });
  t.ui.el.cardHead = strict('cardHead');
  t.ui.el.cardBody = strict('cardBody');
  t.ui.el.cardStatus = { textContent: '' };
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120, 'SR'), sale(2, 900, 'UR')] };
  t.openCard('C1', { rarity: 'SR', title: 'Paris' }); // avec ventes, moins de 50 : pas de « Tout afficher »
  t.renderCard();
  t.openCard('C1', { rarity: 'L', title: 'Paris' }); // sans vente à cette rareté, d'autres raretés en ont
  t.renderCard();
  t.openCard('C9', { title: 'X' }); // carte inconnue : aucune autre rareté
  t.renderCard();
  assert.deepEqual(bad, []);
});

test('pastille au clavier : Entrée ou Espace ouvrent la fiche, les autres touches non', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 100)] };
  const b = t.badgeFor('C1', null, {});
  b.card.title = 'Paris';
  const el = {};
  t.tipData.set(el, b);
  const calls = [];
  const ev = key => ({ key, target: { closest: () => el }, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  t.badgeKey(ev('a'));
  assert.equal(t.ui.card, null);
  assert.deepEqual(calls, []);
  t.badgeKey(ev('Enter'));
  assert.equal(t.ui.card.id, 'C1');
  t.ui.card = null;
  t.badgeKey(ev(' '));
  assert.equal(t.ui.card.id, 'C1');
  assert.deepEqual(calls, ['prevent', 'stop', 'prevent', 'stop']);
});

// ----- 1.30.1 : la courbe à la taille réelle de la fiche (1.30.2 : toute la largeur, 280 px de haut) -----
test('courbe : dessinée à la largeur donnée, sans agrandissement (480 à 3 000, 760 sans largeur), 280 px de haut au moins', () => {
  const { t } = load();
  const pts = [{ t: NOW - DAY, p: 120, k: 'pro' }, { t: NOW - 2 * DAY, p: 110, k: 'pro' }];
  assert.equal(t.cardChart(pts, [], '30', NOW, null, 1200).attrs.viewBox.split(' ')[2], '1200');
  assert.equal(t.cardChart(pts, [], '30', NOW, null, 2300).attrs.viewBox.split(' ')[2], '2300', 'un écran large est rempli');
  assert.equal(t.cardChart(pts, [], '30', NOW, null, 5000).attrs.viewBox.split(' ')[2], '3000');
  assert.equal(t.cardChart(pts, [], '30', NOW, null, 300).attrs.viewBox.split(' ')[2], '480');
  assert.equal(t.cardChart(pts, [], '30', NOW, null).attrs.viewBox.split(' ')[2], '760');
  assert.ok(Number(t.cardChart(pts, [], '30', NOW, null, 1200).attrs.viewBox.split(' ')[3]) >= 280);
});

test('fiche : la courbe prend la largeur du corps de la fiche', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 110)] };
  const out = {};
  t.ui.el.cardHead = { replaceChildren() {} };
  t.ui.el.cardBody = { clientWidth: 1224, replaceChildren(...k) { out.body = k; } };
  t.ui.el.cardStatus = { textContent: '' };
  t.openCard('C1', { rarity: 'SR', title: 'X' });
  t.renderCard();
  assert.equal(find(out.body, n => n.tagName === 'svg')[0].attrs.viewBox.split(' ')[2], '1200');
});

test('courbe : jamais affichée plus large que sa largeur de dessin, même sur un très grand écran', () => {
  const { t } = load();
  const pts = [{ t: NOW - DAY, p: 120, k: 'pro' }];
  assert.equal(t.cardChart(pts, [], '30', NOW, null, 5000).attrs.style, 'max-width:3000px');
  assert.equal(t.cardChart(pts, [], '30', NOW, null, 1200).attrs.style, 'max-width:1200px');
});

// ----- 1.30.2 : une courbe qu'on peut lire -----
const svgText = n => (n.children || []).filter(k => typeof k !== 'object').join('');
const priceLabels = svg => find(svg, n => n.tagName === 'text' && / ₩$/.test(nb(svgText(n)))).map(n => Number(nb(svgText(n)).replace(/[^\d]/g, '')));
const dateLabels = svg => find(svg, n => n.tagName === 'text' && /^\d\d\/\d\d$/.test(svgText(n)));
const trendOf = svg => find(svg, n => n.tagName === 'polyline' && find(n, k => k.tagName === 'title' && /^prix médian/.test(svgText(k))).length);
// 5 ventes par jour, de 100 à 140 ₩, sur `days` jours.
const daily = (days, prices = [100, 110, 120, 130, 140]) =>
  Array.from({ length: days }, (_, d) => prices.map((p, i) => ({ t: NOW - (d + 0.1 + i * 0.15) * DAY, p, k: 'pro' }))).flat();

test('courbe : des prix ronds sur l’axe, chacun avec sa ligne de repère', () => {
  const { t } = load();
  const pts = [[1, 1013], [2, 1490], [3, 1999], [4, 1250], [5, 1720], [6, 1105], [7, 1888], [8, 1333], [9, 1601], [10, 1477], [11, 1150]]
    .map(([d, p]) => ({ t: NOW - d * DAY, p, k: 'pro' }));
  const svg = t.cardChart(pts, [], '30', NOW, null, 1200);
  const ys = priceLabels(svg);
  assert.ok(ys.length >= 3 && ys.length <= 7, ys.join(' '));
  const step = ys[1] - ys[0];
  assert.ok(ys.every((v, i) => i === 0 || v - ys[i - 1] === step), 'pas régulier : ' + ys.join(' '));
  assert.ok([1, 2, 2.5, 5].some(m => [1, 10, 100, 1000].some(p => m * p === step)), 'pas rond : ' + step);
  assert.ok(ys[0] <= 1013 && ys[ys.length - 1] >= 1999, 'l’axe contient les ventes : ' + ys.join(' '));
  assert.ok(find(svg, n => n.tagName === 'line' && n.attrs.class === 'grid').length >= ys.length, 'une ligne par prix');
});

test('courbe : des dates sur l’axe, une par jour sur 7 jours', () => {
  const { t } = load();
  const svg = t.cardChart(daily(7), [], '7', NOW, null, 1200);
  const n = dateLabels(svg).length;
  assert.ok(n >= 6 && n <= 8, String(n));
});

test('courbe : sur 90 jours avec 20 jours de ventes, l’axe commence à la première vente (pas de vide à gauche)', () => {
  const { t } = load();
  const svg = t.cardChart(daily(20), [], '90', NOW, null, 1200);
  const xs = find(svg, n => n.tagName === 'circle').map(c => Number(c.attrs.cx));
  assert.ok(Math.min(...xs) < 1200 * 0.15, 'première vente à x = ' + Math.min(...xs));
});

test('courbe : le prix médian sur 3 jours glissants en trait, et la moitié centrale des ventes en bande', () => {
  const { t } = load();
  const svg = t.cardChart(daily(10), [], '30', NOW, null, 1200);
  const trend = trendOf(svg);
  assert.equal(trend.length, 1);
  assert.equal(svgText(find(trend[0], k => k.tagName === 'title')[0]), 'prix médian sur 3 jours glissants');
  const ys = trend[0].attrs.points.split(' ').map(xy => Number(xy.split(',')[1]));
  assert.ok(ys.length >= 9, String(ys.length));
  assert.ok(ys.every(y => Math.abs(y - ys[0]) < 0.01), 'chaque jour a la même médiane (120 ₩) : ' + ys.join(' '));
  assert.equal(find(svg, n => n.tagName === 'polygon').length, 1, 'la bande du 1er au 3e quartile');
});

test('courbe : ventes rares, médiane sur 3 semaines ; trop rares, pas de trait', () => {
  const { t } = load();
  const one = Array.from({ length: 30 }, (_, d) => ({ t: NOW - (d + 0.5) * DAY, p: 100 + d, k: 'pro' }));
  const svg = t.cardChart(one, [], '30', NOW, null, 1200);
  assert.equal(svgText(find(trendOf(svg)[0], k => k.tagName === 'title')[0]), 'prix médian sur 3 semaines glissantes');
  assert.equal(trendOf(t.cardChart(one.slice(0, 3), [], '30', NOW, null, 1200)).length, 0);
});

test('courbe : une vente hors échelle est un triangle rouge au bord, avec son prix au survol', () => {
  const { t } = load();
  const pts = Array.from({ length: 49 }, (_, i) => ({ t: NOW - (1 + i * 0.5) * DAY, p: 100 + i, k: 'pro' })).concat([{ t: NOW - 2 * DAY, p: 10000, k: 'pro' }]);
  const svg = t.cardChart(pts, [], '30', NOW, null, 1200);
  const out = find(svg, n => n.tagName === 'path' && n.attrs.fill === '#f87171');
  assert.equal(out.length, 1);
  assert.match(nb(textOf(out[0])), /10 000 ₩/);
  assert.equal(find(svg, n => n.tagName === 'circle').length, 49);
});

test('la courbe ne touche pas la tendance des prix : priceOf dit toujours hausse, baisse ou stable', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(8, 150), sale(9, 150), sale(10, 150), sale(20, 100), sale(21, 100), sale(22, 100)] };
  assert.equal(t.priceOf('C1', 'SR').trend, 1);
  t.db.prices.C2 = { at: NOW, sales: [sale(1, 100), sale(2, 100), sale(3, 100), sale(10, 100)] };
  assert.equal(t.priceOf('C2', 'SR').trend, 0);
});

test('courbe : le trait du prix médian est coupé quand des jours de suite n’ont aucune vente', () => {
  const { t } = load();
  const pts = daily(14).filter(pt => NOW - pt.t < 4 * DAY || NOW - pt.t >= 10 * DAY);
  const svg = t.cardChart(pts, [], '30', NOW, null, 1200);
  assert.equal(trendOf(svg).length, 2, 'un trait avant le trou, un après');
  assert.equal(find(svg, n => n.tagName === 'polygon').length, 2);
});

// ----- 1.30.2 : légende et bulle de la courbe -----
const legendOf = svg => find(svg, n => n.tagName === 'text' && n.attrs.class === 'legend');
// Des ventes à heure fixe (midi, puis toutes les 20 min) pour que chaque jour local ait ses 5 ventes ; maintenant à 18 h.
const EVE = (() => { const d = new Date(NOW); d.setHours(18, 0, 0, 0); return d.getTime(); })();
const atNoon = (d, i) => { const x = new Date(EVE); x.setDate(x.getDate() - d); x.setHours(12, 20 * i, 0, 0); return x.getTime(); };
const noonDays = days => Array.from({ length: days }, (_, k) => [100, 110, 120, 130, 140].map((p, i) => ({ t: atNoon(k + 1, i), p, k: 'pro' }))).flat();

test('courbe : une légende en haut, avec les seuls symboles dessinés', () => {
  const { t } = load();
  const pts = daily(10).concat([{ t: NOW - 2 * DAY, p: 105, k: 'prov' }]);
  const svg = t.cardChart(pts, [{ t: NOW - 3 * DAY, p: 115, k: 's' }], '30', NOW, null, 1200);
  const leg = legendOf(svg).map(svgText).join(' | ');
  for (const w of ['une vente', 'prix provisoire', 'prix médian sur 3 jours glissants', 'la moitié des ventes', 'ta vente']) assert.ok(leg.includes(w), w + ' — ' + leg);
  for (const w of ['ton achat', 'hors échelle', 'moyenne par semaine']) assert.ok(!leg.includes(w), w + ' — ' + leg);
  const low = Math.max(...legendOf(svg).map(n => Number(n.attrs.y)));
  const top = Math.min(...find(svg, n => n.tagName === 'line' && n.attrs.class === 'grid').map(n => Math.min(Number(n.attrs.y1), Number(n.attrs.y2))));
  assert.ok(low < top, 'la légende est au-dessus du graphique');
});

test('courbe : sur une fiche étroite, la légende passe à la ligne et la courbe grandit d’autant', () => {
  const { t } = load();
  const pts = daily(10).concat([{ t: NOW - 2 * DAY, p: 105, k: 'prov' }]);
  const marks = [{ t: NOW - 3 * DAY, p: 115, k: 's' }, { t: NOW - 4 * DAY, p: 112, k: 'b' }];
  const H = svg => Number(svg.attrs.viewBox.split(' ')[3]);
  const wide = t.cardChart(pts, marks, '30', NOW, null, 2000), narrow = t.cardChart(pts, marks, '30', NOW, null, 480);
  assert.ok(H(narrow) > H(wide), H(narrow) + ' / ' + H(wide));
  for (const n of legendOf(narrow).filter(k => svgText(k).length > 2)) assert.ok(Number(n.attrs.x) + 6.2 * svgText(n).length <= 480, svgText(n));
});

test('bulle de la courbe : la vente sous la souris, puis le détail du jour et le prix médian', () => {
  const { t } = load();
  const pts = noonDays(10);
  const lay = t.chartLayout(pts, [], '30', EVE, null, 1200);
  const pt = pts.find(x => x.t === atNoon(3, 2));
  const hov = t.chartHoverAt(lay, lay.X(pt.t), lay.Y(pt.p));
  assert.equal(nb(hov.lines[0]), 'Vente du ' + new Date(pt.t).toLocaleDateString('fr-FR') + ' à 12:40 : 120 ₩ (Pro)');
  assert.deepEqual(plain(hov.focus), { cx: lay.X(pt.t), cy: lay.Y(pt.p) });
  assert.match(nb(hov.lines[1]), /^[A-Z][a-zé]+ \d+ [a-zéû]+ : 5 ventes, médiane 120 ₩, de 100 à 140 ₩$/);
  assert.equal(nb(hov.lines[2]), 'Prix médian sur 3 jours glissants : 120 ₩ · la moitié des ventes entre 110 et 130 ₩');
});

test('bulle de la courbe : loin de toute vente, le jour seul ; hors du graphique, rien', () => {
  const { t } = load();
  const lay = t.chartLayout(noonDays(10), [], '30', EVE, null, 1200);
  const x = lay.X(EVE - 2 * 3600e3);
  const hov = t.chartHoverAt(lay, x, lay.T + 2);
  assert.equal(hov.focus, null);
  assert.equal(hov.x, x);
  assert.match(nb(hov.lines[0]), / : aucune vente$/);
  assert.equal(t.chartHoverAt(lay, lay.L - 5, lay.T + 20), null);
  assert.equal(t.chartHoverAt(lay, x, lay.H), null);
  assert.equal(t.chartHoverAt(t.chartLayout([], [], '30', EVE, null, 1200), 600, 100), null);
});

test('bulle de la courbe : la moyenne du site de la semaine', () => {
  const { t } = load();
  const wkd = d => new Date(EVE - d * DAY).toISOString().slice(0, 10);
  const lay = t.chartLayout([], [], 'all', EVE, [[wkd(16), 100, 60, 180, 3], [wkd(9), 110, 80, 150, 4]], 1200);
  const hov = t.chartHoverAt(lay, lay.X(Date.parse(wkd(16) + 'T00:00:00Z') + 2 * DAY), lay.T + 40);
  assert.ok(hov.lines.some(l => /^Site, semaine du \d\d\/\d\d\/\d{4} : moyenne 100 ₩, de 60 à 180 ₩, 3 ventes$/.test(nb(l))), hov.lines.join('\n'));
});

test('fiche : la bulle du survol est posée dans le cadre de la courbe', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 110)] };
  const out = {};
  t.ui.el.cardHead = { replaceChildren() {} };
  t.ui.el.cardBody = { clientWidth: 1224, replaceChildren(...k) { out.body = k; } };
  t.ui.el.cardStatus = { textContent: '' };
  t.openCard('C1', { rarity: 'SR', title: 'X' });
  t.renderCard();
  const box = find(out.body, n => n.className === 'chart')[0];
  assert.deepEqual(box.children.map(k => k.tagName), ['svg', 'div']);
  assert.equal(box.children[1].className, 'tip ctip');
  assert.match(textOf(out.body), /Passe la souris sur la courbe/);
});

test('bulle de la courbe : posée à côté de la souris dans le cadre (le SVG n’a pas d’offsetLeft)', () => {
  const { t } = load();
  const pts = noonDays(10);
  const proto = Object.getPrototypeOf(t.cardChart(pts, [], '30', EVE, null, 1200));
  const add = proto.addEventListener;
  proto.addEventListener = function (k, f) { (this._ev = this._ev || {})[k] = f; };
  try {
    // Le cadre : bord de 1 px, marge intérieure de 6 px à gauche et 10 px en haut ; la courbe affichée à la moitié de sa taille.
    const host = { clientLeft: 1, clientTop: 1, getBoundingClientRect: () => ({ left: 90, top: 20 }) };
    const tip = { style: {}, offsetParent: host, replaceChildren(...k) { this.kids = k; } };
    const svg = t.cardChart(pts, [], '30', EVE, null, 1200, tip);
    svg.getBoundingClientRect = () => ({ left: 97, top: 31, width: 600, height: 300 });
    const lay = t.chartLayout(pts, [], '30', EVE, null, 1200);
    svg._ev.mousemove({ clientX: 97 + 300, clientY: 31 + (lay.T + 50) / 2 });
    // La souris est à 306 px du bord intérieur du cadre.
    assert.equal(tip.style.display, 'block');
    assert.equal(tip.style.left, (306 + 14) + 'px', 'moitié gauche : la bulle à droite de la souris');
    assert.equal(tip.style.top, (31 - 20 - 1 + lay.T / 2) + 'px');
    tip.offsetWidth = 200;
    svg._ev.mousemove({ clientX: 97 + 500, clientY: 31 + (lay.T + 50) / 2 });
    assert.equal(tip.style.left, (506 - 200 - 14) + 'px', 'moitié droite : à gauche de la souris');
    // Un cadre étroit : la bulle reste dedans, à 4 px du bord.
    host.clientWidth = 620;
    tip.offsetWidth = 500;
    svg._ev.mousemove({ clientX: 97 + 300, clientY: 31 + (lay.T + 50) / 2 });
    assert.equal(tip.style.left, (620 - 500 - 4) + 'px');
    svg._ev.mouseleave();
    assert.equal(tip.style.display, 'none');
  } finally {
    proto.addEventListener = add;
  }
});
