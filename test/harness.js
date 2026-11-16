// Charge le script dans un contexte simulé (pas de page, pas de site). Une ligne ajoutée à la fin
// expose ses fonctions internes dans window.__t.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wikimasters-stats.user.js'), 'utf8');
const END = SRC.lastIndexOf('})();');
const EXPOSE = [
  'ui', 'job', 'auto', 'friendExport', 'parseFriend', 'mergePro', 'importFriend', 'mergeBackup', 'priceOf', 'relCell', 'badgeFor',
  'finalsToFetch', 'sweepUrls', 'scanMarket', 'fetchFinals', 'autoDue', 'autoRun',
  'mergeObserved', 'ingestSales', 'ingestFinal', 'ingestMarket', 'settleObserved', 'fillPrices', 'backupData',
  'poolOn', 'poolQueue', 'poolFetch', 'poolFlush', 'poolTick', 'poolBackfill', 'poolPull', 'poolPullMine', 'poolWant', 'poolKnown', 'poolPrefetch',
  'keepPerRarity', 'rarityOf', 'seenRarity', 'askOf', 'dealPct', 'maxBid', 'tidyAuctions', 'addObserved', 'resetPrices',
  'saveDb', 'loadDb', 'trimHistory', 'setAccount', 'clearAccount', 'ingestCollection', 'ingestPro',
  'sellingRows', 'sellingStats', 'renderSales', 'minuteTick'
];
const CODE = SRC.slice(0, END) +
  'window.__t = { get db() { return db; }, set db(v) { db = v; }, ' + EXPOSE.map(k => k + ': typeof ' + k + " !== 'undefined' ? " + k + ' : undefined').join(', ') + ' };\n' +
  SRC.slice(END);

class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.title = ''; this.textContent = ''; this.className = ''; this.children = []; this.attrs = {}; this.style = {}; this.dataset = {}; this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener() {}
  append(...k) { this.children.push(...k); }
  replaceChildren(...k) { this.children = k; }
}

// Réponse simulée du site.
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });

// reject(texte) : renvoie true pour simuler un navigateur plein au moment d'enregistrer ce texte.
// fetch(url) : réponse du site simulée (voir reply). fast : les attentes (une requête par seconde) passent tout de suite.
// storage : contenu du localStorage simulé avant le chargement du script ({ clé: texte }).
function load({ reject = () => false, fetch = async () => reply({}), fast = false, storage = {} } = {}) {
  const store = new Map(Object.entries(storage));
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (reject(String(v))) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: k => store.delete(k)
  };
  const requests = [];
  const window = { fetch: async (url, init) => { requests.push(String(url)); return fetch(String(url), init); }, addEventListener() {}, innerWidth: 1000, innerHeight: 800 };
  const document = { readyState: 'loading', visibilityState: 'visible', addEventListener() {}, createElement: t => new El(t), createElementNS: (n, t) => new El(t) };
  const ctx = { window, document, localStorage, setInterval: () => 0, setTimeout: fast ? (f => setImmediate(f)) : setTimeout, clearTimeout, console, URL, AbortController };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const t = window.__t;
  t.ui.el.frStatus = { textContent: '' };
  t.ui.el.status = { textContent: '' };
  return { t, store, requests, document };
}
// Les objets nés dans le contexte simulé ont leurs propres prototypes : on les compare en JSON.
const plain = v => JSON.parse(JSON.stringify(v));
const fakeFile = text => ({ size: text.length, text: async () => text });

module.exports = { load, reply, plain, fakeFile };
