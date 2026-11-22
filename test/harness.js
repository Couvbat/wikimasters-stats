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
  'sellingRows', 'sellingStats', 'renderSales', 'minuteTick', 'originOf', 'tagBatch', 'applyTagBatch', 'sbSession', 'auctionFor', 'saveWarning',
  'store', 'ready', 'storeLine', 'whenReady', 'priceDue', 'dueCards', 'missingIds', 'routinePass', 'updateAll', 'autoLine',
  'ingestWish', 'profileBody', 'poolSendProfile', 'poolRemoveProfile', 'setProfileShare', 'applyProfiles', 'poolPullProfiles',
  'keepAll', 'COLS', 'obsCardsMax', 'dropProvisional', 'applyFeedPage', 'feedOn', 'poolFeed', 'poolLine',
  'cardSource', 'cardRarities', 'cardCues', 'cueLines', 'cueShort', 'openCard', 'closeCard', 'renderCard', 'setTab', 'toggle', 'syncButtons',
  'chartBounds', 'defaultPeriod', 'cardMarks', 'cardChart', 'badgeClick', 'tipData', 'badgeKey', 'fetchSales', 'tradeCardsToPrice', 'queueBidPrices', 'onPull'
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

// Faux IndexedDB, réduit aux appels du script. opt :
//   data : Map clé → texte, la base (partagée entre deux load pour simuler un rechargement de page ou un second onglet) ;
//   gate : promesse à attendre avant que l'ouverture aboutisse ; failWrites() : vrai pour faire échouer les écritures ;
//   corruptReads : getAll renvoie chaque texte suivi de 'x' ; failReads() : vrai pour faire échouer une lecture ;
//   openThrows : open lève une exception.
// stats.tx : nombre de transactions readwrite ouvertes.
function fakeIndexedDB(opt, data, stats) {
  const later = f => setImmediate(f);
  const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });
  const db = {
    objectStoreNames: { contains: n => n === 'kv' && !!data.hasKv },
    createObjectStore: n => { if (n === 'kv') data.hasKv = true; return {}; },
    close() { db.closed = true; },
    onversionchange: null,
    transaction(name, mode) {
      if (db.closed) throw new Error('InvalidStateError');
      const write = mode === 'readwrite';
      if (write) stats.tx++;
      const queue = [];
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
      const op = (fn, args) => { const r = request(); queue.push({ r, fn, args }); return r; };
      later(run);
      tx.objectStore = () => ({
        get: k => op('get', [k]), put: (v, k) => op('put', [v, k]), delete: k => op('delete', [k]),
        getAll: () => op('getAll', []), getAllKeys: () => op('getAllKeys', [])
      });
      function run() {
        const fail = write ? !!(opt.failWrites && opt.failWrites()) : !!(opt.failReads && opt.failReads());
        const staged = new Map(data);
        while (queue.length) {
          const { r, fn, args } = queue.shift();
          if (fn === 'get') r.result = staged.get(args[0]);
          else if (fn === 'put') staged.set(args[1], String(args[0]));
          else if (fn === 'delete') staged.delete(args[0]);
          else if (fn === 'getAll') r.result = [...staged.values()].map(v => (opt.corruptReads ? v + 'x' : v));
          else if (fn === 'getAllKeys') r.result = [...staged.keys()];
          if (r.onsuccess) r.onsuccess({ target: r });
        }
        if (fail) {
          tx.error = new Error('QuotaExceededError');
          if (tx.onerror) tx.onerror({ target: tx });
          if (tx.onabort) tx.onabort({ target: tx });
          return;
        }
        if (write) { data.clear(); for (const [k, v] of staged) data.set(k, v); }
        if (tx.oncomplete) tx.oncomplete({ target: tx });
      }
      return tx;
    }
  };
  return {
    open(name, version) {
      if (opt.openThrows) throw new Error('SecurityError');
      const r = request();
      Promise.resolve(opt.gate).then(() => later(() => {
        r.result = db;
        if ((data.version || 0) < version) {
          data.version = version;
          if (r.onupgradeneeded) r.onupgradeneeded({ target: r, oldVersion: 0, newVersion: version });
        }
        if (r.onsuccess) r.onsuccess({ target: r });
      }));
      return r;
    }
  };
}
// Bus partagé par les faux BroadcastChannel de plusieurs load (deux onglets).
const fakeBus = () => ({ members: new Set() });
function fakeBroadcastChannel(bus) {
  return class {
    constructor(name) { this.name = name; this.onmessage = null; bus.members.add(this); }
    postMessage(data) {
      for (const m of bus.members) if (m !== this && m.name === this.name) setImmediate(() => { if (m.onmessage) m.onmessage({ data }); });
    }
    close() { bus.members.delete(this); }
  };
}

// Réponse simulée du site.
const reply = (body, status = 200) => { const r = { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } }; r.clone = () => r; return r; };

// reject(texte, clé, contenu actuel) : renvoie true pour simuler un navigateur plein au moment d'enregistrer ce texte sous cette clé.
// fetch(url) : réponse du site simulée (voir reply). fast : les attentes (une requête par seconde) passent tout de suite.
// storage : contenu du localStorage simulé avant le chargement du script ({ clé: texte }).
// idb : faux IndexedDB et faux BroadcastChannel (voir fakeIndexedDB) ; sans lui, le navigateur simulé n'en a pas.
// navigator : navigator simulé (par exemple navigator.locks), absent par défaut.
function load({ reject = () => false, fetch = async () => reply({}), fast = false, storage = {}, idb = null, navigator = null, clock = null } = {}) {
  const store = new Map(Object.entries(storage));
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (reject(String(v), k, store)) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: k => store.delete(k),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; }
  };
  const idbData = idb ? idb.data || new Map() : null, idbStats = { tx: 0 };
  const requests = [];
  const window = { fetch: async (url, init) => { requests.push(String(url)); return fetch(String(url), init); }, addEventListener() {}, innerWidth: 1000, innerHeight: 800 };
  const document = { readyState: 'loading', visibilityState: 'visible', addEventListener() {}, createElement: t => new El(t), createElementNS: (n, t) => new El(t) };
  const ctx = { window, document, localStorage, setInterval: () => 0, clearInterval: () => {}, setTimeout: fast ? (f => setImmediate(f)) : setTimeout, clearTimeout, console, URL, AbortController, Headers,
    location: { href: 'https://www.wiki-masters.com/collection', origin: 'https://www.wiki-masters.com', hash: '', pathname: '/collection' } };
  if (navigator) ctx.navigator = navigator;
  if (idb) {
    ctx.indexedDB = fakeIndexedDB(idb, idbData, idbStats);
    ctx.BroadcastChannel = fakeBroadcastChannel(idb.bus || fakeBus());
  }
  vm.createContext(ctx);
  // Horloge simulée : Date.now du contexte appelle la fonction donnée (le reste de Date ne change pas).
  if (clock) vm.runInContext('(f => { Date.now = () => f(); })', ctx)(clock);
  vm.runInContext(CODE, ctx);
  const t = window.__t;
  t.ui.el.frStatus = { textContent: '' };
  t.ui.el.status = { textContent: '' };
  return { t, store, requests, document, window, location: ctx.location, ready: t.ready, idbData, idbStats };
}
// Les objets nés dans le contexte simulé ont leurs propres prototypes : on les compare en JSON.
const plain = v => JSON.parse(JSON.stringify(v));
const fakeFile = text => ({ size: text.length, text: async () => text });

module.exports = { load, reply, plain, fakeFile, fakeBus };
