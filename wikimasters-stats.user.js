// ==UserScript==
// @name         WikiMasters – Stats de collection
// @namespace    wm-stats
// @version      1.26.0
// @description  Valeur de ta collection WikiMasters, cartes à vendre, bilan de tes ventes, liste de souhaits, stats de boosters, comparaison entre amis. Lecture seule : ne joue pas, n'ouvre rien, n'échange rien.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @homepageURL  https://github.com/Couvbat/wikimasters-stats
// @supportURL   https://github.com/Couvbat/wikimasters-stats/issues
// @updateURL    https://raw.githubusercontent.com/Couvbat/wikimasters-stats/main/wikimasters-stats.user.js
// @downloadURL  https://raw.githubusercontent.com/Couvbat/wikimasters-stats/main/wikimasters-stats.user.js
// ==/UserScript==
(function () {
  'use strict';
  if (window.__wmStats) return;
  window.__wmStats = true;

  const KEY = 'wmstats.v1';
  const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
  const DAY = 864e5;
  const PAGE_SIZE = 50;
  const PRICE_DELAY = 1000; // ms entre deux appels "ventes"
  const DISCARD = 1;        // wikibidous gagnés en défaussant une carte
  const MAX_PULLS = 1500;   // boosters gardés en mémoire
  const MARKET_PAGES = 10;  // pages d'enchères lues par « Relever les fins d'enchères »
  const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const nativeFetch = window.fetch.bind(window);
  // Vu passer pendant la visite : titre de carte → carte, enchère → carte et prix. Sert aux pastilles posées sur les cartes du site.
  const seenTitle = new Map(), seenAuction = new Map();

  // ---------- stockage local (reste dans ton navigateur) ----------
  function defaults() {
    return {
      cards: {}, prices: {}, pro: {}, userId: '', collectionAt: 0, autoPull: true,
      pulls: [], mySales: {}, market: { at: 0, max: 0, selling: null, asks: {} },
      auctions: {}, history: {}, wish: {}, wishAt: 0, wishFullAt: 0, alerts: {}, wishSeen: {},
      obs: {}, obsSales: {}, obsRar: {}, finQ: {}, trades: {}, tradesAt: 0,
      friends: {}, me: '', sell: { min: 10, favs: false, doubt: true, v: 2 }, ov: {}, bids: [], selling: [], sellingAt: 0, tagCat: [],
      pool: { url: '', key: '', on: false, share: false, published: {}, pushAt: 0, pullAt: 0, sent: 0, recv: 0, err: '', retryAt: 0, wait: 0 }, poolQ: []
    };
  }
  // Réglages de ce que le script ajoute aux pages du site (onglet Réglages). Valeur par défaut si jamais touché.
  // ---------- mise à jour ----------
  // Tampermonkey met le script à jour tout seul (une fois par jour par défaut) grâce à @updateURL.
  // Pour ne pas attendre : le panneau compare la version installée à celle publiée sur GitHub, et propose un lien.
  const SCRIPT_URL = 'https://raw.githubusercontent.com/Couvbat/wikimasters-stats/main/wikimasters-stats.user.js';
  const VERSION = (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) || '1.26.0';
  const newerThan = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  const upd = { busy: false, err: '' };
  async function checkUpdate(force) {
    if (upd.busy || (!force && Date.now() - (db.updAt || 0) < DAY)) return;
    upd.busy = true; upd.err = '';
    if (force) renderUpdate();
    try {
      const r = await nativeFetch(SCRIPT_URL + '?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
      const m = /@version\s+([\d.]+)/.exec(await r.text());
      if (!m) throw new Error('version introuvable');
      db.latest = m[1];
      db.updAt = Date.now();
      saveDb();
    } catch (e) {
      upd.err = 'Vérification impossible depuis cette page (' + e.message + '). Le bouton « Installer la dernière version » marche quand même.';
    }
    upd.busy = false;
    renderUpdate();
  }
  function renderUpdate() {
    const e = ui.el;
    if (!e.updInfo) return;
    const has = db.latest && newerThan(db.latest, VERSION);
    e.updInfo.textContent = upd.busy ? 'Vérification…' : upd.err ? upd.err
      : has ? 'Nouvelle version ' + db.latest + ' disponible.'
        : db.latest ? 'À jour (vérifié ' + ago(db.updAt) + ').' : '';
    e.updBanner.style.display = has ? '' : 'none';
    e.updBanner.textContent = has ?'Version ' + db.latest + ' disponible : mettre à jour ↗' : '';
  }
  const OV_DEF ={ cmp: true, dim: false, glow: true, outbid: true, tip: true, have: true, trade: true, bidAuto: true, autoObs: false };
  const ov = k => (db.ov && typeof db.ov[k] === 'boolean' ? db.ov[k] : OV_DEF[k]);
  const MAX_AUCTIONS = 3000; // enchères personnelles gardées en mémoire
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const okKey = k => typeof k === 'string' && k.length > 0 && k.length <= 80 && !BAD_KEYS.has(k);
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const safeUrl = u => (typeof u === 'string' && /^https?:\/\//.test(u) ? u.slice(0, 500) : '');
  // ---------- plusieurs comptes dans un même navigateur ----------
  // Ce qui est personnel (collection, ventes, échanges, boosters, souhaits…) est rangé à part pour chaque compte, sous
  // wmstats.v1.u.<compte> ; les prix du marché et les réglages d'affichage sont communs à tous, sous wmstats.v1.
  // Tant que le compte n'est pas reconnu, sa partie personnelle est sous wmstats.v1.u._.
  const PERSONAL = ['cards', 'collectionAt', 'collectionFullAt', 'pulls', 'mySales', 'auctions', 'history', 'wish', 'wishAt', 'wishFullAt',
    'alerts', 'wishSeen', 'trades', 'tradesAt', 'bids', 'bidsAt', 'selling', 'sellingAt', 'tagCat', 'friends', 'me', 'sell', 'wishHideOwned'];
  const PERSONAL_SET = new Set(PERSONAL);
  const acctKey = uid => KEY + '.u.' + (uid || '_');
  function personalDefaults() {
    const d = defaults(), out = { marketMine: { selling: null, max: 0 } }; // tes annonces en cours, tes places de vente
    for (const k of PERSONAL) out[k] = d[k];
    return out;
  }
  // Pose la partie personnelle d'un compte sur la base (les champs absents prennent leur valeur par défaut).
  function applyPersonal(base, mine) {
    const def = personalDefaults();
    for (const k of PERSONAL) base[k] = k in mine ? mine[k] : def[k];
    const mm = isObj(mine.marketMine) ? mine.marketMine : (isObj(mine.market) ? mine.market : def.marketMine);
    base.market = Object.assign(base.market || defaults().market, { selling: Array.isArray(mm.selling) ? mm.selling : null, max: num(mm.max) });
  }
  function cleanDb(base) {
    base.market = Object.assign(defaults().market, isObj(base.market) ? base.market : {});
    base.sell = Object.assign(defaults().sell, isObj(base.sell) ? base.sell : {});
    // Les prix douteux sont maintenant inclus par défaut : on coche la case une fois pour ceux qui avaient l'ancien réglage.
    if (base.sell.v !== 2) { base.sell.doubt = true; base.sell.v = 2; }
    if (!Array.isArray(base.pulls)) base.pulls = [];
    if (!Array.isArray(base.bids)) base.bids = [];
    if (!Array.isArray(base.selling)) base.selling = [];
    if (!Array.isArray(base.tagCat)) base.tagCat = [];
    base.pool = Object.assign(defaults().pool, isObj(base.pool) ? base.pool : {});
    if (!Array.isArray(base.poolQ)) base.poolQ = [];
    for (const k of ['cards', 'prices', 'pro', 'auctions', 'history', 'wish', 'friends', 'mySales', 'alerts', 'wishSeen', 'obs', 'obsSales', 'obsRar', 'finQ', 'trades', 'ov']) {
      if (!isObj(base[k])) base[k] = {};
    }
    // Nettoyage des doublons laissés par les versions précédentes : une carte rangée sous son propre
    // identifiant alors qu'elle l'est déjà sous celui de son exemplaire.
    const byExemplar = new Set();
    for (const k in base.cards) if (base.cards[k] && k !== base.cards[k].cardId) byExemplar.add(base.cards[k].cardId);
    for (const k in base.cards) if (base.cards[k] && k === base.cards[k].cardId && byExemplar.has(k)) delete base.cards[k];
    return base;
  }
  // ---------- où les données sont rangées ----------
  // Deux modes, avec les mêmes clés (wmstats.v1 et wmstats.v1.u.<compte>) : 'idb', la base IndexedDB « wmstats », sans la limite
  // de 5 Mo ; 'local', le localStorage du site (avant la 1.24, et en secours quand le navigateur bloque IndexedDB).
  // En mode 'idb', texts garde le dernier texte de chaque clé : les lectures restent synchrones.
  const localKeys = () => {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && (k === KEY || k.startsWith(KEY + '.u.'))) out.push(k); }
    } catch (e) {}
    return out;
  };
  const hasIdb = (() => { try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch (e) { return false; } })();
  const store = {
    mode: hasIdb ? 'idb' : 'local', loaded: !hasIdb, texts: new Map(), pending: new Map(), writing: false, idb: null,
    get: k => (store.mode === 'idb' ? (store.texts.has(k) ? store.texts.get(k) : null) : (() => { try { return localStorage.getItem(k); } catch (e) { return null; } })()),
    // En mode 'idb', une écriture met le cache à jour tout de suite et part dans la base peu après (flushStore).
    set: (k, text) => {
      if (store.mode !== 'idb') return localStorage.setItem(k, text);
      store.texts.set(k, text); store.pending.set(k, text); scheduleFlush();
    },
    del: k => {
      if (store.mode !== 'idb') { try { localStorage.removeItem(k); } catch (e) {} return; }
      store.texts.delete(k); store.pending.set(k, null); scheduleFlush();
    },
    keys: () => (store.mode === 'idb' ? [...store.texts.keys()] : localKeys()),
    size: () => store.keys().reduce((n, k) => n + k.length + (store.get(k) || '').length, 0),
    // Résolue quand rien n'est en cours d'écriture ni prévu.
    idle: () => new Promise(r => { idleWaiters.push(r); settleIdle(); })
  };
  const flushState = { scheduled: false }, idleWaiters = [];
  const settleIdle = () => { if (!store.writing && !flushState.scheduled) while (idleWaiters.length) idleWaiters.shift()(); };
  // Plusieurs saveDb dans la même tâche : une seule écriture.
  const scheduleFlush = () => {
    if (flushState.scheduled) return;
    flushState.scheduled = true;
    Promise.resolve().then(() => { flushState.scheduled = false; flushStore(); });
  };
  const TAB = Math.random().toString(36).slice(2);
  const channel = (() => { try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel('wmstats') : null; } catch (e) { return null; } })();
  // Une seule transaction à la fois. Réussie : on prévient les autres onglets, et on écrit ce qui est arrivé entre-temps.
  // Ratée : l'en-tête le dit, et ce qui n'a pas été écrit repart au prochain enregistrement.
  function flushStore() {
    if (store.writing || !store.pending.size || !store.idb) { settleIdle(); return; }
    const batch = store.pending, wasFailed = !!saveState.failed;
    store.pending = new Map();
    store.writing = true;
    idbWrite(store.idb, batch).then(() => {
      saveState.failed = 0;
      if (channel) { try { channel.postMessage({ saved: TAB }); } catch (e) {} }
      store.writing = false;
      if (wasFailed) refresh();
      if (store.pending.size) flushStore(); else settleIdle();
    }, () => {
      for (const [k, v] of batch) if (!store.pending.has(k)) store.pending.set(k, v);
      saveState.failed = Date.now();
      store.writing = false;
      if (!wasFailed) refresh();
      settleIdle();
    });
  }
  const readJson = k => { try { return JSON.parse(store.get(k)); } catch (e) { return null; } };
  let db = loadDb();
  function loadDb() {
    const base = defaults();
    const d = readJson(KEY);
    // Avant la 1.20, tout était sous wmstats.v1 : la partie personnelle s'y trouve encore et sera répartie au prochain enregistrement.
    if (isObj(d) && isObj(d.prices)) Object.assign(base, d);
    const mine = readJson(acctKey(base.userId));
    if (isObj(mine)) applyPersonal(base, mine);
    return cleanDb(base);
  }
  // ---------- base IndexedDB ----------
  const IDB_NAME = 'wmstats', IDB_STORE = 'kv', IDB_VERSION = 1;
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(IDB_NAME, IDB_VERSION);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE); };
      // Une future version de la base ne doit pas rester bloquée par cet onglet.
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); resolve(d); };
      r.onerror = () => reject(r.error || new Error('IndexedDB indisponible'));
    });
  }
  function idbReadAll(idb) {
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly'), os = tx.objectStore(IDB_STORE);
      const keys = os.getAllKeys(), vals = os.getAll();
      tx.oncomplete = () => { const m = new Map(); keys.result.forEach((k, i) => m.set(String(k), String(vals.result[i]))); resolve(m); };
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('lecture impossible'));
    });
  }
  // Une seule transaction : tout est écrit, ou rien. null efface la clé.
  function idbWrite(idb, entries) {
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite'), os = tx.objectStore(IDB_STORE);
      for (const [k, v] of entries) { if (v == null) os.delete(k); else os.put(v, k); }
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('écriture impossible'));
    });
  }
  // Efface du localStorage les clés de la base (jamais wmstats.auto, le verrou de la collecte automatique).
  const dropLocal = () => { for (const k of localKeys()) { try { localStorage.removeItem(k); } catch (e) {} } };
  // Chargement. La base fait foi seulement si elle porte le marqueur META, posé une fois la migration vérifiée : une copie
  // interrompue ou non vérifiée ne peut donc jamais faire foi, même si on n'a pas pu la retirer.
  // Sans marqueur, les données du localStorage y sont copiées telles quelles (ce qui n'en vient pas est retiré), relues et
  // comparées texte par texte ; puis le marqueur est posé, et seulement alors le localStorage est effacé.
  // Au moindre problème (base bloquée, lecture ratée, copie différente), on reste sur le localStorage, comme avant la 1.24.
  const META = 'wmstats.meta';
  async function loadStore() {
    try {
      const idb = await idbOpen();
      let texts = await idbReadAll(idb);
      if (!texts.has(META)) {
        const legacy = new Map();
        for (const k of localKeys()) { const v = localStorage.getItem(k); if (v != null) legacy.set(k, v); }
        if (legacy.size) {
          const copy = new Map(legacy);
          for (const k of texts.keys()) if (!legacy.has(k)) copy.set(k, null);
          await idbWrite(idb, copy);
          texts = await idbReadAll(idb);
          if ([...legacy].some(([k, v]) => texts.get(k) !== v)) {
            await idbWrite(idb, new Map([...legacy.keys()].map(k => [k, null]))).catch(() => {});
            throw new Error('copie différente');
          }
        }
        await idbWrite(idb, new Map([[META, JSON.stringify({ since: Date.now() })]]));
      }
      texts.delete(META);
      dropLocal();
      store.texts = texts;
      store.idb = idb;
      store.mode = 'idb';
    } catch (e) {
      store.mode = 'local';
    }
    db = loadDb();
    store.loaded = true;
  }
  // Résolue quand les données sont chargées (tout de suite sans IndexedDB).
  const ready = store.loaded ? Promise.resolve() : loadStore();
  // Ce qui touche aux données attend qu'elles soient chargées (réponses du site interceptées, panneau, pastilles).
  const whenReady = f => (store.loaded ? f() : ready.then(f));
  // Un autre onglet du site a enregistré des données : on les reprend pour ne pas les écraser.
  // Sauf pendant un traitement, ou quand cet onglet a lui-même des écritures en attente : elles seraient perdues.
  window.addEventListener('storage', ev => {
    if (store.mode === 'local' && ev.key === KEY && !job.running) { db = loadDb(); refresh(); }
  });
  // Occupé, l'onglet ne recharge pas ; mais les parties personnelles des autres comptes, qu'il ne modifie pas, sont mises à jour
  // dans le cache : un changement de compte lira la version récente, et ne l'écrasera pas par une ancienne.
  const mayReload = () => store.mode === 'idb' && store.loaded && !job.running && !store.pending.size && !store.writing;
  if (channel) channel.onmessage = ev => {
    if (!ev || !ev.data || ev.data.saved === TAB || store.mode !== 'idb' || !store.loaded) return;
    idbReadAll(store.idb).then(texts => {
      texts.delete(META);
      if (mayReload()) {
        store.texts = texts;
        db = loadDb();
        resetPrices();
        refresh();
        return;
      }
      const mine = acctKey(db.userId);
      for (const [k, v] of texts) if (k.startsWith(KEY + '.u.') && k !== mine && !store.pending.has(k)) store.texts.set(k, v);
    }).catch(() => {});
  };
  function splitDb() {
    const shared = {}, mine = {};
    for (const k of Object.keys(db)) (PERSONAL_SET.has(k) ? mine : shared)[k] = db[k];
    mine.marketMine = { selling: db.market.selling, max: db.market.max };
    shared.market = { at: db.market.at, asks: db.market.asks };
    return { shared, mine };
  }
  // Enregistre la partie personnelle (d'abord : si elle ne tient pas, rien ne change) puis la partie commune.
  // Plus de place : le relevé du marché, qui se refait en un clic, n'est plus enregistré qu'en partie (les annonces des cartes
  // souhaitées), puis plus du tout ; en dernier recours, l'historique des ventes revient à 10 par rareté (le pool, lui, garde tout).
  // Le relevé reste affiché jusqu'au rechargement de la page : on le retire de l'enregistrement, jamais de la mémoire.
  // Renvoie false si rien n'a pu être enregistré : l'en-tête du panneau le dit alors (saveWarning), au lieu d'un échec silencieux.
  const saveState = { failed: 0 };
  const saveWarning = () => (!saveState.failed ? '' : store.mode === 'idb'
    ? ' · ⚠ Enregistrement impossible : tes derniers changements ne sont pas enregistrés et seront perdus au rechargement de la page.'
    : ' · ⚠ Navigateur plein : tes derniers changements ne sont pas enregistrés et seront perdus au rechargement de la page.');
  function saveDb() {
    // Rien n'est encore chargé : écrire maintenant remplacerait les données par un db vide.
    if (!store.loaded) return true;
    if (store.mode === 'idb') {
      const { shared, mine } = splitDb();
      store.set(acctKey(db.userId), JSON.stringify(mine)); // le compte au moment de l'appel (setAccount change db.userId juste après)
      store.set(KEY, JSON.stringify(shared));
      return true;
    }
    const write = asks => {
      const { shared, mine } = splitDb();
      if (asks) shared.market = { at: db.market.at, asks };
      const mineKey = acctKey(db.userId), sharedText = JSON.stringify(shared), mineText = JSON.stringify(mine);
      try {
        localStorage.setItem(mineKey, mineText);
      } catch (e) {
        // Pas la place pour la partie personnelle. La partie commune enregistrée prend peut-être plus de place que la nouvelle :
        // format d'avant la 1.20, où elle contenait aussi la partie personnelle, ou relevé du marché qu'on vient d'en retirer.
        // On l'écrit d'abord pour libérer cette place, puis on réessaie. Si ça ne tient toujours pas, on la remet telle qu'elle
        // était : rien ne change. (Sans cela, un navigateur presque plein resté à l'ancien format n'enregistrait plus jamais rien.)
        const before = localStorage.getItem(KEY);
        localStorage.setItem(KEY, sharedText);
        try {
          localStorage.setItem(mineKey, mineText);
        } catch (e2) {
          try { if (before == null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, before); } catch (e3) {}
          throw e2;
        }
        return;
      }
      localStorage.setItem(KEY, sharedText);
    };
    const wishAsks = () => {
      const o = {};
      for (const id in db.market.asks) if (db.wish[id]) o[id] = db.market.asks[id];
      return o;
    };
    const tries = [() => write(), () => write(wishAsks()), () => write({}), () => { trimHistory(); write(wishAsks()); }, () => write({})];
    for (const tryIt of tries) {
      try { tryIt(); saveState.failed = 0; return true; } catch (e) {}
    }
    saveState.failed = Date.now();
    return false;
  }
  // Le compte connecté vient d'être reconnu, ou il a changé : on range les données de l'ancien, on charge celles du nouveau.
  // Renvoie true si l'on a changé de compte.
  function setAccount(uid) {
    if (!okKey(uid) || uid === db.userId) return false;
    if (!db.userId) {
      // Compte pas encore reconnu : les données présentes sont les siennes.
      db.userId = uid;
      saveDb();
      store.del(acctKey(''));
      return false;
    }
    saveDb();
    db.userId = uid;
    const mine = readJson(acctKey(uid));
    applyPersonal(db, isObj(mine) ? mine : personalDefaults());
    cleanDb(db);
    resetPrices();
    saveDb();
    return true;
  }
  // Bouton « Effacer les données de ce compte » : vide la partie personnelle du compte connecté. Les prix restent.
  function clearAccount() {
    applyPersonal(db, personalDefaults());
    cleanDb(db);
    resetPrices();
    saveDb();
    refresh();
  }
  const byDateDesc = (a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0);
  const rarOf = r => (typeof r === 'string' && /^[A-Z]{1,3}$/.test(r) ? r : '?');
  const rarOk = r => typeof r === 'string' && /^[A-Z]{1,3}$/.test(r);
  // Une même carte se vend à plusieurs raretés (des exemplaires de raretés différentes circulent) : chaque vente garde la sienne (r),
  // et l'on garde les ventes les plus récentes de chaque rareté, pour que chacune ait son propre historique.
  // 20 ventes pour les raretés qui valent le plus, 10 pour les autres, 60 au plus par carte (le pool, lui, garde tout).
  const KEEP_RARE = { L: 20, UR: 20, SR: 20 };
  function keepPerRarity(list, per, max = 60) {
    const by = new Map();
    for (const s of list.slice().sort(byDateDesc)) {
      const k = s.r || '';
      const l = by.get(k) || [];
      if (l.length < (per || KEEP_RARE[k] || 10)) { l.push(s); by.set(k, l); }
    }
    return [...by.values()].flat().sort(byDateDesc).slice(0, max);
  }
  // Garde-fou quand le navigateur est plein : l'historique de chaque carte revient à 10 ventes par rareté.
  function trimHistory() {
    for (const id in db.prices) if (isObj(db.prices[id]) && Array.isArray(db.prices[id].sales)) db.prices[id].sales = keepPerRarity(db.prices[id].sales, 10, 30);
    for (const id in db.obsSales) if (Array.isArray(db.obsSales[id])) db.obsSales[id] = keepPerRarity(db.obsSales[id], 10, 30);
    for (const id in db.mySales) if (Array.isArray(db.mySales[id])) db.mySales[id] = keepPerRarity(db.mySales[id], 10, 30);
    resetPrices();
  }

  function ingestCollection(items, replace) {
    if (!Array.isArray(items)) return;
    // La collection dit à qui elle appartient : on change de compte avant de la ranger (et avant de vider l'ancienne).
    const owner = items.find(it => it && okKey(it.user_id));
    if (owner) setAccount(owner.user_id);
    if (replace) db.cards = {};
    for (const it of items) {
      const c = it && it.card;
      if (!c || !c.id) continue;
      // Clé = l'exemplaire (it.id). Sans elle, on retombait sur l'identifiant de la carte : la même carte
      // pouvait alors être rangée deux fois. On n'accepte plus cette clé de secours si l'exemplaire est connu.
      if (!it.id && Object.values(db.cards).some(x => x.cardId === c.id)) continue;
      if (it.id && db.cards[c.id] && it.id !== c.id) delete db.cards[c.id];
      db.cards[it.id || c.id] = {
        cardId: c.id,
        title: c.wikipedia_title || '?',
        rarity: rarOf(c.rarity),
        atk: c.atk, def: c.def, q: c.q_score, views: c.pageviews,
        cat: c.category || '', url: safeUrl(c.wikipedia_url),
        count: it.count || 1, shiny: !!it.is_shiny, starred: !!it.starred,
        tags: (it.tags || []).map(t => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean),
        _tagObjs: (it.tags || []).filter(t => t && typeof t === 'object'),
        obtained: it.obtained_at || ''
      };
    }
    // Les étiquettes vues sur tes cartes complètent le catalogue (identifiant, nom, couleur).
    for (const k in db.cards) {
      const c = db.cards[k];
      if (!c || !c._tagObjs) continue;
      for (const t of c._tagObjs) addTag(t);
      delete c._tagObjs;
    }
    db.collectionAt = Date.now();
    saveDb();
    // Un chargement complet donne une photo fiable du jour ; une page isolée, non.
    if (replace) { db.collectionFullAt = Date.now(); saveDb(); resetPrices(); snapshot(buildRows()); poolSendProfile(); poolPullMine(true); }
    refresh();
  }

  // Liste de souhaits : les cartes pour lesquelles tu as demandé une alerte sur la page « Toutes les cartes ».
  function ingestWish(j, replace) {
    if (!j || !Array.isArray(j.cards)) return;
    if (replace) { db.wish = {}; db.wishFullAt = Date.now(); }
    for (const c of j.cards) if (c && okKey(c.id)) db.wish[c.id] = [str(c.wikipedia_title || '?', 200), rarOf(c.rarity)];
    db.wishAt = Date.now();
    saveDb();
    refresh();
    if (replace) poolSendProfile();
    poolPullMine(!!replace);
  }

  // Tes enchères passées, accumulées au fil des passages : le site ne renvoie que les plus récentes.
  // Chaque entrée : [type, carte, titre, rareté, mise de départ d'origine, mise finale, prix final ou null, date]
  // type : s = vendue, u = invendue, b = achetée
  function recordAuction(a, kind) {
    if (!a || !okKey(a.id) || !okKey(a.card_id)) return;
    const c = a.card || {}, had = db.auctions[a.id];
    db.auctions[a.id] = [kind, a.card_id, str(c.wikipedia_title || '?', 200), rarOf(a.snapshot_rarity || c.rarity),
      num(a.listing_base_amount != null ? a.listing_base_amount : a.base_amount), num(a.base_amount),
      typeof a.final_price === 'number' ? a.final_price : null, str(a.settled_at || a.end_at, 40), a.is_shiny ? 1 : 0];
    // Une vente ou un achat à toi, vu pour la première fois : un prix final exact pour le pool du groupe.
    const e = db.auctions[a.id];
    if (!had && kind !== 'u' && typeof e[6] === 'number' && e[6] > 0 && !e[8]) poolQueue('s', [e[1], e[6], e[7], 0, 1, a.id, e[3] !== '?' ? e[3] : null]);
  }
  function tidyAuctions() {
    const ids = Object.keys(db.auctions);
    if (ids.length > MAX_AUCTIONS) {
      ids.sort((x, y) => (db.auctions[x][7] < db.auctions[y][7] ? -1 : 1))
        .slice(0, ids.length - MAX_AUCTIONS).forEach(id => delete db.auctions[id]);
    }
    const mine = {};
    for (const a of Object.values(db.auctions)) {
      // Une shiny se vend plus cher : son prix fausserait la valeur d'une carte normale.
      if (a[6] == null || !okKey(a[1]) || a[8]) continue;
      (mine[a[1]] = mine[a[1]] || []).push(rarOk(a[3]) ? { p: a[6], t: a[7], r: a[3] } : { p: a[6], t: a[7] });
    }
    for (const id in mine) mine[id] = keepPerRarity(mine[id]);
    db.mySales = mine;
  }

  // rarity : connue quand c'est le script qui demande l'historique, absente quand c'est le site.
  function ingestSales(cardId, j, rarity) {
    if (!j || typeof j !== 'object') return;
    // « sales » remonte jusqu'à 200 ventes, chacune avec sa rareté ; « recent » n'en donne que 10, toutes raretés confondues.
    const src = Array.isArray(j.sales) && j.sales.length ? j.sales : (Array.isArray(j.recent) ? j.recent : []);
    const sales = keepPerRarity(src
      .filter(s => s && typeof s.final_price === 'number')
      .map(s => (rarOk(s.rarity) ? { p: s.final_price, t: s.settled_at || '', r: s.rarity } : { p: s.final_price, t: s.settled_at || '' })));
    // L'historique d'une carte ne disparaît pas : un retour vide vient du site. Un historique déjà relevé ici garde ses ventes,
    // et son envoi au pool, s'il attend dans la file, aussi.
    const old = db.prices[cardId];
    if (!sales.length && isObj(old) && !old.by && Array.isArray(old.sales) && old.sales.length) old.at = Date.now();
    else db.prices[cardId] = { at: Date.now(), sales };
    if (sales.length) poolQueue('p', [cardId, rarity && rarity !== '?' ? rarity : null]);
    saveDb();
    refresh();
  }

  // Page Marché : enchères en cours, tes ventes en cours, et ton propre historique de ventes et d'achats.
  // Une enchère en cours vue sur le site (liste du Marché ou page de l'enchère) : sa carte, son prix, la rareté de son exemplaire.
  function seeLive(id, a, price) {
    const prev = seenAuction.get(id);
    seenAuction.set(id, { c: a.card_id, a: price, b: a.current_bid != null, m: !!db.userId && a.current_bidder_id === db.userId,
      bid: !!(prev && prev.bid) || db.bids.some(x => x.i === id), own: !!db.userId && a.seller_id === db.userId, s: !!a.is_shiny,
      r: rarOf(a.snapshot_rarity || (a.card && a.card.rarity)) });
  }
  function ingestMarket(j) {
    if (!j || typeof j !== 'object') return;
    const m = db.market, now = Date.now();
    if (typeof j.maxConcurrentAuctions === 'number') m.max = j.maxConcurrentAuctions;
    if (Array.isArray(j.selling)) {
      m.selling = j.selling.map(a => a && a.card_id).filter(Boolean);
      // Tes mises en vente en cours, en entier, pour leur bilan dans l'onglet Mes ventes.
      db.selling = j.selling.filter(a => a && okKey(a.id) && okKey(a.card_id)).slice(0, 50).map(a => {
        const end = Date.parse(a.end_at), bid = a.current_bid != null;
        return {
          i: a.id, c: a.card_id, t: str((a.card && a.card.wikipedia_title) || '?', 200), r: rarOf(a.snapshot_rarity || (a.card && a.card.rarity)),
          base: num(a.base_amount), l: num(a.listing_base_amount != null ? a.listing_base_amount : a.base_amount),
          o: bid ? num(typeof a.effective_bid === 'number' ? a.effective_bid : a.current_bid) : null, b: bid,
          e: Number.isFinite(end) ? end : 0, s: a.is_shiny ? 1 : 0,
          at: Number.isFinite(Date.parse(a.created_at)) ? Date.parse(a.created_at) : 0 // mise en vente, pour retrouver l'origine de la carte
        };
      });
      db.sellingAt = now;
    }
    // Tes propres listes (Mes enchères, Mes ventes, Gagnées, Historique) : on retient la carte de chaque annonce,
    // pour poser la pastille de valeur. Seules les annonces en cours gardent leur prix, comparé à la valeur.
    for (const k of ['bidding', 'selling', 'won', 'history']) {
      if (!Array.isArray(j[k])) continue;
      const live = k === 'bidding' || k === 'selling';
      for (const a of j[k]) {
        if (!a || !okKey(a.card_id)) continue;
        const price = typeof a.effective_bid === 'number' ? a.effective_bid : a.current_bid != null ? a.current_bid : a.base_amount;
        if (okKey(a.id)) {
          seenAuction.set(a.id, live && typeof price === 'number'
            ? { c: a.card_id, a: price, b: a.current_bid != null, m: !!db.userId && a.current_bidder_id === db.userId,
              bid: k === 'bidding', own: k === 'selling', s: !!a.is_shiny, r: rarOf(a.snapshot_rarity || (a.card && a.card.rarity)) }
            : { c: a.card_id, a: null, s: !!a.is_shiny, r: rarOf(a.snapshot_rarity || (a.card && a.card.rarity)) });
        }
        if (a.card && typeof a.card.wikipedia_title === 'string') seenTitle.set(a.card.wikipedia_title, a.card_id);
        if (a.card && rarOk(a.card.rarity)) seenRarity.set(a.card_id, a.card.rarity); // rareté actuelle de la carte
        const end = Date.parse(a.end_at);
        if (k === 'bidding' && a.final_price == null && !a.is_shiny && typeof price === 'number' && okKey(a.id) && Number.isFinite(end)) {
          db.obs[a.id] = [a.card_id, price, a.current_bid != null ? 1 : 0, end, now, rarOf(a.snapshot_rarity || (a.card && a.card.rarity))];
        }
      }
    }
    // Mes enchères : la liste complète, pour le bilan (onglet Souhaits et Accueil).
    if (Array.isArray(j.bidding)) {
      db.bids = j.bidding.filter(a => a && okKey(a.card_id) && okKey(a.id)).slice(0, 200).map(a => {
        const end = Date.parse(a.end_at);
        return {
          i: a.id, c: a.card_id, t: str((a.card && a.card.wikipedia_title) || '?', 200), r: rarOf(a.snapshot_rarity || (a.card && a.card.rarity)),
          a: num(typeof a.effective_bid === 'number' ? a.effective_bid : a.current_bid != null ? a.current_bid : a.base_amount),
          m: !!db.userId && a.current_bidder_id === db.userId, e: Number.isFinite(end) ? end : 0, s: a.is_shiny ? 1 : 0
        };
      });
      db.bidsAt = now;
      queueBidPrices(j.bidding);
    }
    if (Array.isArray(j.history) || Array.isArray(j.won)) {
      for (const a of j.history || []) recordAuction(a, a && typeof a.final_price === 'number' ? 's' : 'u');
      for (const a of j.won || []) if (a && typeof a.final_price === 'number') recordAuction(a, 'b');
      tidyAuctions();
    }
    if (Array.isArray(j.auctions)) {
      for (const id in m.asks) if (now - m.asks[id].t > 2 * DAY) delete m.asks[id];
      for (const a of j.auctions) {
        if (!a || typeof a.card_id !== 'string' || BAD_KEYS.has(a.card_id) || a.final_price != null) continue;
        const price = typeof a.effective_bid === 'number' ? a.effective_bid : a.base_amount;
        if (typeof price !== 'number') continue;
        if (okKey(a.id)) seeLive(a.id, a, price);
        if (a.card && typeof a.card.wikipedia_title === 'string') seenTitle.set(a.card.wikipedia_title, a.card_id);
        if (a.card && rarOk(a.card.rarity)) seenRarity.set(a.card_id, a.card.rarity); // rareté actuelle de la carte
        const end = Date.parse(a.end_at);
        // Enchère observée : on note où en est l'offre. Une fois l'enchère finie, la dernière offre vue sert de prix de vente.
        // Les shiny sont laissées de côté : le site ne les distingue pas dans l'historique, leur prix fausserait la valeur normale.
        if (okKey(a.id) && Number.isFinite(end) && !a.is_shiny) {
          db.obs[a.id] = [a.card_id, price, a.current_bid != null ? 1 : 0, end, now, rarOf(a.snapshot_rarity || (a.card && a.card.rarity))];
        }
        // Tes propres annonces ne sont ni une offre à saisir ni une concurrence.
        if (db.userId && a.seller_id === db.userId) continue;
        // Chaque annonce garde la rareté de son exemplaire : deux annonces d'une même carte peuvent être de raretés différentes.
        const item = { i: str(a.id, 80), a: price, b: a.current_bid != null, e: Number.isFinite(end) ? end : 0, r: rarOf(a.snapshot_rarity || (a.card && a.card.rarity)) };
        // Plusieurs enchères peuvent porter sur la même carte : on les garde toutes, de la moins chère à la plus chère.
        // Les champs a, b, e, i du niveau supérieur reprennent la moins chère.
        const cur = m.asks[a.card_id];
        const list = (cur ? (cur.list || [{ i: cur.i, a: cur.a, b: cur.b, e: cur.e }]) : [])
          .filter(x => x && x.i !== item.i && (!x.e || x.e > now));
        list.push(item);
        list.sort((x, y) => x.a - y.a);
        m.asks[a.card_id] = { a: list[0].a, b: list[0].b, e: list[0].e, i: list[0].i, t: now,
          r: rarOf(a.snapshot_rarity || (a.card && a.card.rarity)), list: list.slice(0, 20) };
        if (okKey(a.id) && db.alerts[a.id]) db.alerts[a.id][3] = 1;
      }
      const ids = Object.keys(m.asks);
      if (ids.length > 4000) {
        ids.sort((x, y) => m.asks[x].t - m.asks[y].t).slice(0, ids.length - 4000).forEach(id => delete m.asks[id]);
      }
    }
    m.at = now;
    settleObserved();
    saveDb();
    refresh();
  }

  // ---------- prix observés : un historique construit à partir des enchères que tout compte peut voir ----------
  // À la fin d'une enchère suivie, la dernière offre vue sert de prix provisoire : c'est un minimum, l'offre a pu monter après.
  // « g » dit combien de minutes avant la fin on l'a vue. Ensuite, la page de l'enchère (que tout compte peut ouvrir)
  // donne son prix final exact : « Relever les prix finaux » le lit et remplace le prix provisoire (x = 1 : exact).
  const OBS_NEAR = 30;      // au-delà de 30 min avant la fin, le prix vu est trop incertain pour les niveaux par rareté
  const MAX_OBS = 6000;     // enchères en cours suivies
  const MAX_OBS_CARDS = 8000;
  const MAX_FINQ = 3000;    // enchères finies en attente de leur prix final
  function addObserved(cardId, sale, rarity) {
    if (!okKey(cardId) || typeof sale.p !== 'number' || sale.p <= 0) return false;
    let list = db.obsSales[cardId] || [];
    // Même enchère déjà notée : un prix exact remplace le prix provisoire, sinon on ne change rien.
    const same = sale.i ? list.find(x => x.i === sale.i) : null;
    if (same) {
      if (!sale.x || same.x) return false;
      list = list.filter(x => x !== same);
    } else if (list.some(x => x.t === sale.t && x.p === sale.p)) return false;
    const item = { p: sale.p, t: str(sale.t, 40), g: Math.max(0, Math.round(num(sale.g))) };
    if (okKey(sale.i)) item.i = sale.i;
    if (sale.x) item.x = 1;
    if (rarOk(sale.r)) item.r = sale.r;
    list.push(item);
    db.obsSales[cardId] = keepPerRarity(list);
    const end = Date.parse(sale.t);
    if (rarity && rarity !== '?' && sale.g <= OBS_NEAR && Number.isFinite(end)) {
      const rl = db.obsRar[rarity] || [];
      rl.push([sale.p, end]);
      db.obsRar[rarity] = rl.sort((x, y) => y[1] - x[1]).slice(0, 400);
    }
    return true;
  }
  function settleObserved() {
    const now = Date.now();
    let changed = false;
    for (const id in db.obs) {
      const o = db.obs[id];
      if (!Array.isArray(o) || o[3] > now) continue;
      // Tes propres enchères ont déjà leur vrai prix final dans « Mes ventes ».
      const gap = (o[3] - o[4]) / 6e4;
      if (o[2] && !db.auctions[id] && addObserved(o[0], { p: o[1], t: new Date(o[3]).toISOString(), g: gap, i: id, r: o[5] }, o[5])) {
        poolQueue('s', [o[0], o[1], new Date(o[3]).toISOString(), Math.max(0, Math.round(gap)), 0, id, o[5] !== '?' ? o[5] : null]);
      }
      // Prix final à relever : les enchères qui avaient une offre, et celles vues sans offre moins de 15 min avant la fin
      // (une offre de dernière minute a pu arriver). Au-delà d'une semaine, on n'insiste plus.
      if (!db.auctions[id] && (o[2] || gap <= 15) && now - o[3] < 7 * DAY) db.finQ[id] = [o[0], o[5], o[3], o[2] ? 1 : 0];
      delete db.obs[id];
      changed = true;
    }
    const fq = Object.keys(db.finQ);
    for (const id of fq) if (now - db.finQ[id][2] > 7 * DAY) delete db.finQ[id];
    if (fq.length > MAX_FINQ) fq.sort((x, y) => db.finQ[x][2] - db.finQ[y][2]).slice(0, fq.length - MAX_FINQ).forEach(id => delete db.finQ[id]);
    const ids = Object.keys(db.obs);
    if (ids.length > MAX_OBS) {
      ids.sort((x, y) => db.obs[x][4] - db.obs[y][4]).slice(0, ids.length - MAX_OBS).forEach(id => delete db.obs[id]);
    }
    const cards = Object.keys(db.obsSales);
    if (cards.length > MAX_OBS_CARDS) {
      cards.sort((x, y) => (db.obsSales[x][0].t < db.obsSales[y][0].t ? -1 : 1))
        .slice(0, cards.length - MAX_OBS_CARDS).forEach(id => delete db.obsSales[id]);
    }
    return changed;
  }
  // Page d'une enchère (/api/marketplace/<id>), ouverte par toi sur le site ou relue par « Relever les prix finaux ».
  // Une enchère réglée donne son prix final exact. Renvoie true si l'enchère est terminée et réglée.
  function ingestFinal(id, j) {
    const a = j && j.auction;
    if (!isObj(a) || !okKey(id)) return false;
    if (a.card && typeof a.card.wikipedia_title === 'string' && okKey(a.card_id)) seenTitle.set(a.card.wikipedia_title, a.card_id);
    if (!a.settled_at && a.final_price == null) {
      // Pas encore réglée : on la retient, pour que la pastille de la page juge la carte à la rareté de cet exemplaire.
      const price = typeof a.effective_bid === 'number' ? a.effective_bid : a.current_bid != null ? a.current_bid : a.base_amount;
      if (okKey(a.card_id) && typeof price === 'number') seeLive(id, a, price);
      return false;
    }
    // Réglée : plus en vente, mais la pastille de sa page garde la rareté de son exemplaire.
    if (okKey(a.card_id)) seenAuction.set(id, { c: a.card_id, a: null, s: !!a.is_shiny, r: rarOf(a.snapshot_rarity || (a.card && a.card.rarity)) });
    const q = db.finQ[id];
    delete db.finQ[id];
    if (!okKey(a.card_id) || a.is_shiny || (db.userId && a.seller_id === db.userId)) return true;
    const list = db.obsSales[a.card_id] || [];
    const prov = list.find(x => x.i === id);
    if (typeof a.final_price === 'number' && a.final_price > 0) {
      const rar = rarOf(a.snapshot_rarity || (a.card && a.card.rarity) || (q && q[1]));
      // Le niveau par rareté a déjà reçu le prix provisoire s'il était vu de près : on ne le compte pas deux fois.
      const r = prov && prov.g <= OBS_NEAR ? null : rar;
      const t = str(a.settled_at || a.end_at, 40);
      if (addObserved(a.card_id, { p: a.final_price, t, g: 0, i: id, x: 1, r: rar }, r)) poolQueue('s', [a.card_id, a.final_price, t, 0, 1, id, rar !== '?' ? rar : null]);
    } else {
      // Finie sans vente : le prix provisoire n'avait pas lieu d'être, ici comme dans le pool.
      if (prov) {
        db.obsSales[a.card_id] = list.filter(x => x !== prov);
        if (!db.obsSales[a.card_id].length) delete db.obsSales[a.card_id];
      }
      poolQueue('u', id);
    }
    return true;
  }
  // Enchères finies dont le prix final reste à lire, à partir d'une minute après la fin (le temps que le site la règle).
  // On ne peut en lire qu'une par seconde, alors que des centaines finissent chaque minute : l'ordre compte.
  // D'abord tes cartes et tes souhaits, puis les raretés qui valent le plus, puis celles qui avaient une offre, puis les plus récentes.
  // Une enchère dont le prix serait écarté de toute façon (la carte a déjà 10 prix, tous plus récents) n'est pas relue.
  const RAR_RANK = { L: 0, UR: 1, SR: 2, R: 3, PC: 4, C: 5 };
  function finalsToFetch() {
    const now = Date.now(), mine = myCards(), keys = {};
    const ids = Object.keys(db.finQ).filter(id => {
      const q = db.finQ[id], seen = db.obsSales[q[0]];
      return now - q[2] > 6e4 && !(seen && seen.length >= 10 && Date.parse(seen[seen.length - 1].t) >= q[2]);
    });
    for (const id of ids) {
      const q = db.finQ[id];
      keys[id] = [mine[q[0]] || db.wish[q[0]] ? 0 : 1, q[1] in RAR_RANK ? RAR_RANK[q[1]] : 6, q[3] ? 0 : 1, -q[2]];
    }
    return ids.sort((x, y) => {
      const a = keys[x], b = keys[y];
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
      return 0;
    });
  }
  // Les fins d'enchères observées, pour le fichier ami et la sauvegarde. L'historique Pro voyage à part (voir proExport).
  function observedExport() {
    const sales = [];
    for (const id in db.obsSales) for (const s of db.obsSales[id]) sales.push([id, s.p, s.t, s.g, s.x ? 1 : 0, s.i || '', s.r || null]);
    sales.sort((x, y) => (x[2] < y[2] ? 1 : -1));
    return { sales: sales.slice(0, 8000), rar: db.obsRar };
  }
  // Fusionne des observations venues d'un fichier (ami ou sauvegarde), champ par champ. Renvoie le nombre de prix ajoutés.
  function mergeObserved(seen) {
    if (!isObj(seen)) return 0;
    let added = 0;
    for (const s of (Array.isArray(seen.sales) ? seen.sales : []).slice(0, 20000)) {
      if (!Array.isArray(s) || !okKey(s[0]) || typeof s[1] !== 'number' || typeof s[2] !== 'string' || !Number.isFinite(Date.parse(s[2]))) continue;
      if (addObserved(s[0], { p: s[1], t: s[2], g: num(s[3]), x: s[4] === 1, i: okKey(s[5]) ? s[5] : '', r: s[6] }, null)) added++;
    }
    if (isObj(seen.rar)) for (const r of RARITIES) {
      const src = Array.isArray(seen.rar[r]) ? seen.rar[r].slice(0, 400) : [];
      const have = new Set((db.obsRar[r] || []).map(x => x[0] + '|' + x[1]));
      const list = db.obsRar[r] || [];
      for (const x of src) {
        if (!Array.isArray(x) || !(num(x[0]) > 0) || !(num(x[1]) > 0) || have.has(x[0] + '|' + x[1])) continue;
        list.push([x[0], x[1]]);
        have.add(x[0] + '|' + x[1]);
      }
      if (list.length) db.obsRar[r] = list.sort((x, y) => y[1] - x[1]).slice(0, 400);
    }
    const cards = Object.keys(db.obsSales);
    if (cards.length > MAX_OBS_CARDS) {
      cards.sort((x, y) => (db.obsSales[x][0].t < db.obsSales[y][0].t ? -1 : 1))
        .slice(0, cards.length - MAX_OBS_CARDS).forEach(id => delete db.obsSales[id]);
    }
    return added;
  }
  // ---------- historique Pro partagé avec les amis ----------
  // Chaque relevé : [carte, date du relevé, [[prix, date de vente], …], origine]. Les relevés « aucune vente » restent
  // chez soi : le site en renvoie parfois à tort pour des L, UR et SR. Un relevé reçu d'un ami garde son origine.
  const MAX_PRO_SHARE = 8000;
  function proExport(pseudo) {
    return Object.keys(db.prices).filter(id => okKey(id) && isObj(db.prices[id]) && Array.isArray(db.prices[id].sales) && db.prices[id].sales.length)
      .sort((x, y) => num(db.prices[y].at) - num(db.prices[x].at)).slice(0, MAX_PRO_SHARE)
      .map(id => { const p = db.prices[id]; return [id, num(p.at), p.sales.map(s => [s.p, s.t, s.r || null]), p.by || pseudo]; });
  }
  // Fusionne les relevés Pro d'un ami : pour chaque carte, le relevé le plus récent gagne, comme pour une sauvegarde.
  // Une date dans le futur est ramenée à maintenant, sinon ce prix ne serait jamais remplacé. Renvoie le nombre de relevés ajoutés.
  function mergePro(list, from) {
    if (!Array.isArray(list)) return 0;
    const now = Date.now();
    let added = 0;
    for (const e of list.slice(0, 20000)) {
      if (!Array.isArray(e) || !okKey(e[0]) || !(num(e[1]) > 0) || !Array.isArray(e[2])) continue;
      // Une vente sans date lisible ne compte pas, comme dans mergeObserved.
      const sales = keepPerRarity(e[2].filter(s => Array.isArray(s) && num(s[0]) > 0 && typeof s[1] === 'string' && Number.isFinite(Date.parse(s[1])))
        .slice(0, 200).map(s => (rarOk(s[2]) ? { p: s[0], t: str(s[1], 40), r: s[2] } : { p: s[0], t: str(s[1], 40) })));
      if (!sales.length) continue;
      const at = Math.min(e[1], now), cur = db.prices[e[0]];
      if (cur && num(cur.at) >= at) continue;
      // Tes propres prix revenus par un ami ne sont pas « partagés ».
      const by = (typeof e[3] === 'string' && e[3].trim().slice(0, 40)) || from;
      db.prices[e[0]] = by && by !== db.me ? { at, sales, by } : { at, sales };
      added++;
    }
    if (added) resetPrices();
    return added;
  }

  // ---------- étiquetage par lots ----------
  // Le site écrit les étiquettes directement dans sa base (Supabase) : une ligne { user_card_id, tag_id } par carte étiquetée,
  // toutes envoyées en une seule requête quand on étiquette en mode « Sélectionner ». Le script fait pareil, mais seulement
  // après ton clic, et il ne fait qu'ajouter une de tes étiquettes existantes : il n'en crée, n'en retire et n'en supprime aucune.
  // La session du site est lue sur ses propres appels à sa base et gardée en mémoire : jamais enregistrée, jamais exportée.
  const sbSession = { base: '', apikey: '', auth: '' };
  function noteSession(url, input, init) {
    let hd;
    try { hd = new Headers((init && init.headers) || (input && typeof input === 'object' && input.headers) || undefined); } catch (e) { return; }
    const key = hd.get('apikey'), auth = hd.get('authorization');
    if (key && auth && /^Bearer\s+\S+/i.test(auth)) { sbSession.base = url.origin; sbSession.apikey = key; sbSession.auth = auth; }
  }
  function addTag(t) {
    if (!t || !okKey(t.id) || typeof t.name !== 'string' || !t.name.trim()) return;
    const tag = { id: t.id, name: str(t.name, 60), color: typeof t.color === 'string' ? t.color.slice(0, 20) : '' };
    const i = db.tagCat.findIndex(x => x.id === tag.id);
    if (i < 0) db.tagCat.push(tag); else db.tagCat[i] = tag;
  }
  function ingestTags(list) {
    if (!Array.isArray(list)) return;
    db.tagCat = [];
    for (const t of list.slice(0, 200)) addTag(t);
    saveDb();
    refresh();
  }
  const TAG_MAX = 200; // exemplaires par lot
  const TAG_RULES = [['sell', 'Cartes de la liste À vendre'], ['discard', 'Cartes qui valent 1 ₩'], ['dupes', 'Doublons'],
    ['rarity', 'Une rareté'], ['value', 'Valeur au moins…']];
  // Le lot d'une règle : les exemplaires de ta collection qui n'ont pas encore l'étiquette. Un exemplaire rangé sous l'identifiant
  // de la carte (ancienne clé) est laissé de côté : on ne connaît pas son identifiant d'exemplaire.
  function tagBatch(rule, tagId, opt) {
    opt = opt || {};
    const tag = (db.tagCat || []).find(x => x.id === tagId);
    if (!tag) return { tag: null, items: [], total: 0 };
    const sell = rule === 'sell' ? new Set(sellList(buildRows()).map(r => r.id)) : null;
    const all = [];
    for (const [id, c] of Object.entries(db.cards)) {
      if (!c || !okKey(id) || id === c.cardId || (c.tags || []).includes(tag.name)) continue;
      const p = rule === 'discard' || rule === 'value' ? priceOf(c.cardId, c.rarity) : null;
      const ok = rule === 'dupes' ? c.count >= 2
        : rule === 'discard' ? !c.starred && !!p && (p.n === 0 || p.med <= DISCARD)
          : rule === 'rarity' ? rarOk(opt.rarity) && c.rarity === opt.rarity
            : rule === 'value' ? !!p && p.n > 0 && Math.max(p.med, DISCARD) >= num(opt.min)
              : rule === 'sell' ? sell.has(id) : false;
      if (ok) all.push({ id, title: c.title, rarity: c.rarity });
    }
    return { tag, items: all.slice(0, TAG_MAX), total: all.length };
  }
  // Applique un lot, en une seule requête. Toute erreur arrête tout ; rien ne change en local sans la réponse du site.
  async function applyTagBatch(batch) {
    if (!batch || !batch.tag || !batch.items.length) return { n: 0 };
    if (!sbSession.base || !sbSession.apikey || !sbSession.auth) {
      throw new Error('le script n’a pas encore vu ta session : recharge la page Collection du site, puis réessaie');
    }
    const rows = batch.items.slice(0, TAG_MAX).map(x => ({ user_card_id: x.id, tag_id: batch.tag.id }));
    const r = await nativeFetch(sbSession.base + '/rest/v1/user_card_tags', {
      method: 'POST', credentials: 'omit', body: JSON.stringify(rows),
      headers: { apikey: sbSession.apikey, Authorization: sbSession.auth, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }
    });
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      if (body && body.code === AUTO_LIMIT) { db.autoPauseUntil = Date.now() + DAY; saveDb(); throw new Error('le site limite les actions automatiques, réessaie plus tard'); }
      if (r.status === 401) throw new Error('session expirée : recharge la page du site, puis réessaie');
      throw new Error('le site a refusé (HTTP ' + r.status + ')');
    }
    for (const x of rows) {
      const c = db.cards[x.user_card_id];
      if (c) c.tags = [...new Set([...(c.tags || []), batch.tag.name])];
    }
    saveDb();
    refresh();
    return { n: rows.length };
  }

  // ---------- pool partagé du groupe ----------
  // Une base commune hébergée par un membre (voir server/README.md) : chaque prix relevé ici y part, et l'on reçoit ceux du groupe,
  // Pro et non-Pro mélangés. Seul ce qui est relevé sur ce navigateur part : ce qui vient du pool, d'un fichier ami ou d'une
  // sauvegarde ne repart jamais. Facultatif : désactivé ou injoignable, le script fonctionne comme avant.
  const POOL_FLUSH_EVERY = 15e3;      // envoi de la file
  const POOL_PULL_EVERY = 6 * 36e5;   // réception de la collection et des souhaits
  const POOL_QMAX = 20000;            // entrées en attente gardées au plus
  const POOL_BATCH = { p: 2000, s: 5000, u: 5000 };
  const poolUrlOk = u => /^https:\/\/[^\s/]+/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u);
  const poolOn = () => !!(db.pool && db.pool.on && db.pool.key && poolUrlOk(db.pool.url || ''));
  // type : 'p' relevé Pro [carte, rareté] ; 's' vente [carte, prix, date, écart, exact, enchère, rareté] ; 'u' enchère finie sans vente.
  // Un relevé Pro en file ne garde que la carte : son historique est relu dans db.prices au moment de l'envoi. Le copier dans la file
  // doublait la place prise par tout l'historique Pro à l'activation du partage, et le navigateur plein n'enregistrait plus rien.
  function poolQueue(type, entry) {
    if (!poolOn()) return;
    // Un seul relevé Pro en attente par carte : le dernier, avec sa rareté, puisque l'historique est relu à l'envoi.
    if (type === 'p') {
      const i = db.poolQ.findIndex(x => x[0] === 'p' && x[1][0] === entry[0] && !Array.isArray(x[1][2]));
      if (i >= 0) db.poolQ.splice(i, 1);
    }
    db.poolQ.push([type, entry]);
    if (db.poolQ.length > POOL_QMAX) db.poolQ.splice(0, db.poolQ.length - POOL_QMAX);
  }
  // Un pool qui ne répond pas ne doit rien bloquer : au bout de POOL_TIMEOUT, on abandonne l'appel (et le script lit le site comme avant).
  const POOL_TIMEOUT = 10e3;
  async function poolFetch(path, body) {
    const headers = { 'x-group-key': db.pool.key };
    if (body) headers['content-type'] = 'application/json';
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), POOL_TIMEOUT) : 0;
    try {
      const r = await nativeFetch(db.pool.url.replace(/\/+$/, '') + path, {
        method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!r.ok) throw Object.assign(new Error('pool : HTTP ' + r.status + (r.status === 401 ? ', clé refusée' : '')), { status: r.status });
      return await r.json();
    } catch (e) {
      if (ctrl && ctrl.signal.aborted) throw new Error('pool : pas de réponse en ' + POOL_TIMEOUT / 1000 + ' s');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  // Échec : on garde tout, et on attend de plus en plus longtemps (1 min, 2, 4… jusqu'à 30 min) avant de réessayer.
  function poolFailed(e, now) {
    const p = db.pool;
    p.err = (e && e.message) || 'pool injoignable';
    p.wait = Math.min(Math.max(num(p.wait) * 2, 6e4), 18e5);
    p.retryAt = now + p.wait;
  }
  const poolOk = () => { db.pool.err = ''; db.pool.wait = 0; db.pool.retryAt = 0; };
  // Le relevé Pro à envoyer pour une entrée de la file : [carte, date du relevé, [[prix, date, rareté], …], rareté].
  // null si la carte n'a plus de relevé à elle (remplacé depuis par celui d'un ami, déjà dans le pool).
  function proEntry(e) {
    if (Array.isArray(e[2])) return e; // file d'une version précédente : l'historique y est déjà
    const p = db.prices[e[0]];
    if (!isObj(p) || p.by || !Array.isArray(p.sales) || !p.sales.length) return null;
    return [e[0], num(p.at), p.sales.map(s => [s.p, s.t, s.r || null]), e[1] || null];
  }
  const poolState = { flushing: false };
  async function poolFlush(now) {
    now = now || Date.now();
    if (!poolOn() || poolState.flushing || !db.poolQ.length) return;
    poolState.flushing = true;
    const count = { p: 0, s: 0, u: 0 }, batch = [];
    const body = { member: (db.me || '').trim().slice(0, 40) || 'anonyme', pro: [], sales: [], unsold: [] };
    for (const item of db.poolQ) {
      const k = item[0];
      if (!(k in count) || count[k] >= POOL_BATCH[k]) continue;
      const e = k === 'p' ? proEntry(item[1]) : item[1];
      batch.push(item);
      if (!e) continue;
      count[k]++;
      (k === 'p' ? body.pro : k === 's' ? body.sales : body.unsold).push(e);
    }
    try {
      if (count.p + count.s + count.u) await poolFetch('/v1/push', body);
      const sent = new Set(batch);
      db.poolQ = db.poolQ.filter(x => !sent.has(x));
      db.pool.sent = num(db.pool.sent) + count.p + count.s + count.u;
      db.pool.pushAt = Date.now();
      poolOk();
    } catch (e) {
      poolFailed(e, now);
    }
    poolState.flushing = false;
    saveDb();
  }
  function poolTick(now) {
    now = now || Date.now();
    if (poolOn() && db.poolQ.length && now >= num(db.pool.retryAt)) return poolFlush(now);
  }
  // À l'activation du partage : tes propres relevés déjà accumulés partent aussi (historique Pro relevé ici, tes ventes et achats).
  function poolBackfill() {
    for (const id in db.prices) {
      const p = db.prices[id];
      if (okKey(id) && isObj(p) && !p.by && Array.isArray(p.sales) && p.sales.length) poolQueue('p', [id, null]);
    }
    for (const id in db.auctions) {
      const a = db.auctions[id];
      if (Array.isArray(a) && a[0] !== 'u' && typeof a[6] === 'number' && a[6] > 0 && !a[8] && okKey(a[1])) poolQueue('s', [a[1], a[6], a[7], 0, 1, id, a[3] !== '?' ? a[3] : null]);
    }
  }
  // Réception : les prix du groupe pour ces cartes, fusionnés comme ceux d'un fichier ami
  // (le relevé Pro le plus récent gagne, les ventes observées s'ajoutent). Rien de ce qui est reçu ne repart.
  async function poolPull(ids) {
    if (!poolOn()) return 0;
    const list = [...new Set((ids || []).filter(okKey))];
    let added = 0;
    for (let i = 0; i < list.length; i += 500) {
      const j = await poolFetch('/v1/pull', { cards: list.slice(i, i + 500) });
      const cards = isObj(j && j.cards) ? j.cards : {}, pro = [], sales = [];
      for (const id of Object.keys(cards)) {
        const c = cards[id];
        if (!okKey(id) || !isObj(c)) continue;
        if (isObj(c.pro) && Array.isArray(c.pro.sales)) pro.push([id, num(c.pro.at), c.pro.sales, typeof c.pro.by === 'string' ? c.pro.by : '']);
        for (const s of Array.isArray(c.sales) ? c.sales : []) if (Array.isArray(s)) sales.push([id, ...s]);
      }
      added += mergePro(pro, 'groupe') + mergeObserved({ sales });
    }
    db.pool.recv = num(db.pool.recv) + added;
    db.pool.err = '';
    if (added) resetPrices();
    saveDb();
    return added;
  }
  const poolNote = e => { db.pool.err = (e && e.message) || 'pool injoignable'; saveDb(); };
  // Ta collection et tes souhaits, au plus toutes les 6 h (ou tout de suite si on force).
  // ---------- amis par le pool ----------
  // Le profil du compte connecté : sa collection et sa liste de souhaits, au format du fichier ami, sans les prix (déjà dans le pool).
  // null sans compte reconnu ou sans pseudo.
  function profileBody() {
    const pseudo = (db.me || '').trim().slice(0, 40);
    if (!okKey(db.userId) || !pseudo) return null;
    const mine = myCards();
    return {
      id: db.userId, pseudo, at: Date.now(),
      cards: Object.keys(mine).map(id => [id, String(mine[id].title || '?').slice(0, 200), rarOk(mine[id].rarity) ? mine[id].rarity : null,
        Math.max(1, Math.min(9999, num(mine[id].count) || 1))]),
      wish: Object.entries(db.wish).map(([id, w]) => [id, String(w[0] || '?').slice(0, 200), rarOk(w[1]) ? w[1] : null])
    };
  }
  // Publications et retraits passent l'un après l'autre : un retrait ne part jamais avant une publication déjà lancée.
  let profileOps = Promise.resolve();
  const queueProfile = f => { const run = profileOps.then(f); profileOps = run.catch(() => {}); return run; };
  // db.pool.published : les comptes de ce navigateur qui ont un profil dans le pool (la case vaut pour tous).
  function markPublished(id, on) {
    const p = Object.assign({}, isObj(db.pool.published) ? db.pool.published : {});
    if (on) p[id] = 1; else delete p[id];
    db.pool.published = p;
    saveDb();
  }
  // Publie le profil, si la case « Partager ma collection et mes souhaits avec le groupe » est cochée. Ne lève jamais d'erreur.
  function poolSendProfile() {
    return queueProfile(async () => {
      if (!poolOn() || !db.pool.share) return false;
      const body = profileBody();
      if (!body) return false;
      try { await poolFetch('/v1/profile', body); markPublished(body.id, true); return true; } catch (e) { poolNote(e); return false; }
    });
  }
  // Retire du pool les profils de tous les comptes qui en ont publié un, et celui du compte connecté.
  // Il suffit de l'adresse et de la clé : la case des prix peut être décochée.
  function poolRemoveProfile() {
    return queueProfile(async () => {
      if (!poolUrlOk(db.pool.url || '') || !db.pool.key) return;
      const ids = new Set(Object.keys(isObj(db.pool.published) ? db.pool.published : {}));
      if (okKey(db.userId)) ids.add(db.userId);
      for (const id of ids) {
        try { await poolFetch('/v1/profile/remove', { id }); markPublished(id, false); } catch (e) { poolNote(e); }
      }
    });
  }
  // Message passager sous les réglages du pool.
  function poolSay(text) {
    if (ui.el.poolInfo) ui.el.poolInfo.textContent = text;
    poolUi.testing = true;
    setTimeout(() => { poolUi.testing = false; }, 8000);
  }
  // La case : cochée, le profil part (il faut un pseudo) et ceux des autres arrivent ; décochée, le profil est retiré du pool.
  async function setProfileShare(on) {
    if (on && !(db.me || '').trim()) {
      db.pool.share = false;
      saveDb();
      poolSay('Écris d’abord ton pseudo dans l’onglet Amis.');
      return;
    }
    db.pool.share = !!on;
    saveDb();
    if (on) {
      await poolSendProfile();
      if (typeof poolPullProfiles === 'function') await poolPullProfiles();
    } else {
      await poolRemoveProfile();
    }
    syncButtons();
  }
  // Les profils reçus deviennent des amis (src: 'pool'), au format des fichiers ami. Ceux du pool sont reconstruits à chaque fois :
  // un membre parti disparaît, un pseudo changé change de nom. Le compte connecté n'est pas un ami de lui-même.
  // Deux membres au même pseudo : « Paul », « Paul (2) ». Un ami venu d'un fichier plus récent n'est pas remplacé.
  function applyProfiles(profiles) {
    const list = (Array.isArray(profiles) ? profiles : [])
      .filter(p => p && okKey(p.id) && p.id !== db.userId && typeof p.pseudo === 'string')
      .sort((a, b) => a.pseudo.localeCompare(b.pseudo) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const n of Object.keys(db.friends)) if (db.friends[n] && db.friends[n].src === 'pool') delete db.friends[n];
    const used = new Set();
    for (const p of list) {
      let base = p.pseudo.trim().slice(0, 40) || 'ami';
      if (BAD_KEYS.has(base)) base = 'ami';
      let name = base;
      for (let k = 2; used.has(name); k++) name = base + ' (' + k + ')';
      used.add(name);
      const cur = db.friends[name];
      if (cur && num(cur.at) > num(p.at)) continue;
      const cards = {}, wish = {};
      for (const c of (Array.isArray(p.cards) ? p.cards : []).slice(0, 20000)) {
        if (!Array.isArray(c) || !okKey(c[0]) || typeof c[1] !== 'string') continue;
        const n = Math.max(1, Math.min(9999, Math.floor(Number(c[3]) || 1)));
        cards[c[0]] = [c[1].slice(0, 200), rarOf(c[2]), (cards[c[0]] ? cards[c[0]][2] : 0) + n];
      }
      for (const c of (Array.isArray(p.wish) ? p.wish : []).slice(0, 5000)) {
        if (Array.isArray(c) && okKey(c[0]) && typeof c[1] === 'string') wish[c[0]] = [c[1].slice(0, 200), rarOf(c[2])];
      }
      db.friends[name] = { at: num(p.at), cards, wish, src: 'pool', id: p.id };
    }
    saveDb();
    refresh();
  }
  // Lit les profils des membres qui partagent. Un pool pas encore à jour (sans profils, 404) n'est pas une erreur.
  async function poolPullProfiles() {
    if (!poolOn()) return 0;
    try {
      const j = await poolFetch('/v1/profiles');
      applyProfiles(j && j.profiles);
      return Object.values(db.friends).filter(f => f && f.src === 'pool').length;
    } catch (e) {
      if (e && e.status !== 404) poolNote(e);
      return 0;
    }
  }
  async function poolPullMine(force) {
    if (!poolOn()) return;
    const now = Date.now();
    if (!force && now - num(db.pool.pullAt) < POOL_PULL_EVERY) return;
    db.pool.pullAt = now;
    const ids = new Set(Object.keys(db.wish));
    for (const c of Object.values(db.cards)) if (c && okKey(c.cardId)) ids.add(c.cardId);
    try { if (await poolPull([...ids])) refresh(); } catch (e) { poolNote(e); }
    // La case vaut pour tous les comptes du navigateur : décochée depuis un autre compte, le profil publié par celui-ci est retiré ici.
    if (!db.pool.share && isObj(db.pool.published) && Object.keys(db.pool.published).length) await poolRemoveProfile();
    await poolPullProfiles();
  }
  // Cartes affichées par le site sans aucun prix connu : regroupées pendant 2 s, chacune demandée une seule fois par visite.
  const poolWanted = { queue: new Set(), asked: new Set(), timer: 0 };
  function poolWant(id) {
    if (!poolOn() || !okKey(id) || poolWanted.asked.has(id)) return;
    poolWanted.asked.add(id);
    poolWanted.queue.add(id);
    if (poolWanted.timer) return;
    poolWanted.timer = setTimeout(async () => {
      const ids = [...poolWanted.queue].slice(0, 500);
      for (const x of ids) poolWanted.queue.delete(x);
      try { if (await poolPull(ids)) refresh(); } catch (e) { poolNote(e); }
      poolWanted.timer = 0;
      if (poolWanted.queue.size) { const next = [...poolWanted.queue][0]; poolWanted.asked.delete(next); poolWanted.queue.delete(next); poolWant(next); }
    }, 2000);
  }
  // Enchères finies dont le prix final est déjà connu du groupe : on le prend au pool, et on ne les relit pas sur le site.
  async function poolKnown() {
    if (!poolOn()) return 0;
    const ids = finalsToFetch().slice(0, 1000);
    if (!ids.length) return 0;
    const j = await poolFetch('/v1/known', { auctions: ids });
    const exact = isObj(j && j.exact) ? j.exact : {}, sales = [];
    for (const id of Object.keys(exact)) {
      const e = exact[id];
      if (!okKey(id) || !Array.isArray(e) || !db.finQ[id]) continue;
      sales.push([e[0], e[1], e[2], 0, 1, id]);
      delete db.finQ[id];
    }
    if (sales.length) { mergeObserved({ sales }); resetPrices(); saveDb(); }
    return sales.length;
  }
  // Avant de demander des historiques Pro au site : ceux que le groupe a relevés il y a moins de 24 h suffisent.
  async function poolPrefetch(ids) {
    if (!poolOn() || !ids || !ids.length) return;
    try { await poolPull(ids); } catch (e) { poolNote(e); }
  }

  // Niveau de prix par rareté, d'après les fins d'enchères observées ces 7 derniers jours.
  function observedByRarity() {
    const since = Date.now() - 7 * DAY;
    return RARITIES.map(r => {
      const v = (db.obsRar[r] || []).filter(x => x[1] > since).map(x => x[0]);
      return v.length >= 5 ? { r, med: median(v), n: v.length } : null;
    }).filter(Boolean);
  }

  // Échanges entre joueurs, lus sur la page Échanges du site et gardés en mémoire.
  // Chaque entrée : s = statut, t = date, w = l'autre joueur, ini = 1 si c'est toi qui as proposé,
  // g = cartes que tu donnes, r = cartes que tu reçois, wg et wr = wikibidous donnés et reçus.
  const cleanCards = l => (Array.isArray(l) ? l : []).filter(c => Array.isArray(c) && okKey(c[0])).slice(0, 60)
    .map(c => [c[0], str(c[1] || '?', 200), rarOf(c[2])]);
  function tidyTrades() {
    const ids = Object.keys(db.trades);
    if (ids.length > 2000) {
      ids.sort((x, y) => (db.trades[x].t < db.trades[y].t ? -1 : 1)).slice(0, ids.length - 2000).forEach(id => delete db.trades[id]);
    }
  }
  function ingestTrades(j) {
    const list = j && Array.isArray(j.trades) ? j.trades : null;
    // Sans savoir qui tu es, impossible de dire quelle carte tu donnes et laquelle tu reçois.
    if (!list || !db.userId) return;
    for (const t of list) {
      if (!t || !okKey(t.id) || !Array.isArray(t.items)) continue;
      const ini = t.initiator_id === db.userId;
      if (!ini && t.recipient_id !== db.userId) continue;
      const other = (ini ? t.recipient : t.initiator) || {};
      const side = mine => cleanCards(t.items.filter(i => i && (i.offered_by === db.userId) === mine)
        .map(i => [i.card_id, i.card && i.card.wikipedia_title, i.snapshot_rarity || (i.card && i.card.rarity)]));
      db.trades[t.id] = {
        s: str(t.status, 20), t: str(t.updated_at || t.created_at, 40), w: str(other.username || '?', 40), ini: ini ? 1 : 0,
        g: side(true), r: side(false),
        wg: num(ini ? t.initiator_wikibidous : t.recipient_wikibidous), wr: num(ini ? t.recipient_wikibidous : t.initiator_wikibidous)
      };
    }
    tidyTrades();
    db.tradesAt = Date.now();
    saveDb();
    refresh();
  }

  // Alertes du site : « une carte de ta liste de souhaits vient d'être mise en vente ».
  // Le site les charge lui-même sur chaque page ; on retient l'enchère et la carte concernées.
  // Chaque entrée : [carte, titre, date, état] ; état : 0 = pas vérifiée, 1 = vue en vente, 2 = terminée
  function ingestAlerts(j) {
    const list = j && Array.isArray(j.notifications) ? j.notifications : null;
    if (!list) return;
    const now = Date.now();
    let changed = false;
    for (const n of list) {
      const d = n && n.data;
      if (!n || n.type !== 'marketplace_wishlist_listed' || !isObj(d) || !okKey(d.auction_id) || !okKey(d.card_id)) continue;
      const t = Date.parse(n.created_at);
      if (db.alerts[d.auction_id] || !Number.isFinite(t) || now - t > 2 * DAY) continue;
      db.alerts[d.auction_id] = [d.card_id, str(d.card_title || '?', 200), t, 0];
      changed = true;
    }
    for (const id in db.alerts) if (now - db.alerts[id][2] > 2 * DAY) { delete db.alerts[id]; changed = true; }
    if (changed) { saveDb(); refresh(); }
  }
  // La dernière alerte encore valable pour une carte : moins de 24 h et pas marquée terminée.
  function alertOf(cardId) {
    let best = null;
    const now = Date.now();
    for (const id in db.alerts) {
      const a = db.alerts[id];
      // On ajoute l'identifiant de l'enchère en 5e position, pour pouvoir y mener par un lien.
      if (a[0] === cardId && a[3] !== 2 && now - a[2] < 12 * 36e5 && (!best || a[2] > best[2])) best = [a[0], a[1], a[2], a[3], id];
    }
    return best;
  }

  // Statut Pro : lu dans la réponse que le site demande lui-même à chaque chargement de page.
  // L'historique des ventes est une fonction Pro, donc le script ne le demande que pour un compte Pro.
  function ingestPro(userId, j) {
    const row = Array.isArray(j) ? j[0] : j;
    if (!row || typeof row.is_pro !== 'boolean') return;
    // La requête que le site fait sur le profil du compte connecté, au chargement de la page : le signal le plus tôt du compte.
    setAccount(userId);
    db.pro = {};
    db.pro[userId] = row.is_pro;
    saveDb();
    refresh();
  }
  // true = Pro, false = non Pro, undefined = pas encore vu
  function proState() { return db.userId ? db.pro[db.userId] : undefined; }
  function showPrices() {
    return proState() === true || Object.keys(db.prices).length > 0 || Object.keys(db.mySales).length > 0 ||
      Object.keys(db.obsSales).length > 0;
  }

  // Parcourt une réponse à la recherche de cartes { id, wikipedia_title } ou { card_id, card: { wikipedia_title } }.
  function learnTitles(j) {
    let budget = 20000, found = 0;
    const walk = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 6 || --budget < 0) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v.wikipedia_title === 'string' && okKey(v.id) && (v.rarity || v.atk != null)) { seenTitle.set(v.wikipedia_title, v.id); found++; }
      if (okKey(v.card_id) && v.card && typeof v.card.wikipedia_title === 'string') { seenTitle.set(v.card.wikipedia_title, v.card_id); found++; }
      for (const k in v) if (v[k] && typeof v[k] === 'object') walk(v[k], depth + 1);
    };
    walk(j, 0);
    if (found) overlaySoon();
  }

  // ---------- écoute passive : on lit ce que le site charge déjà ----------
  window.fetch = function (input, init) {
    const p = nativeFetch(input, init);
    try {
      const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
      const url = new URL(raw, location.href);
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (/\.supabase\.co$/.test(url.hostname)) {
        noteSession(url, input, init);
        // Le site lit tes étiquettes (page Collection) : on retient leur liste, pour l'étiquetage par lots.
        if (method === 'GET' && url.pathname === '/rest/v1/tags') p.then(r => r.ok && r.clone().json().then(j => whenReady(() => ingestTags(j)))).catch(() => {});
      }
      if (method === 'GET' && /\.supabase\.co$/.test(url.hostname) && url.pathname === '/rest/v1/profiles' &&
          url.searchParams.get('select') === 'is_pro') { // la requête que le site fait sur ton propre profil
        const u = /^eq\.(.+)$/.exec(url.searchParams.get('id') || '');
        if (u) p.then(r => r.ok && r.clone().json().then(j => whenReady(() => ingestPro(u[1], j)))).catch(() => {});
      } else if (url.origin === location.origin && method === 'POST' && /^\/api\/packs\//.test(url.pathname)) {
        // Tu viens d'ouvrir un paquet toi-même : on lit juste la liste des cartes tirées.
        const kind = url.pathname.split('/').pop();
        p.then(r => r.ok && r.clone().json().then(j => j && Array.isArray(j.cards) && whenReady(() => onPull(j.cards, kind)))).catch(() => {});
      } else if (url.origin === location.origin && method === 'GET') {
        const m = url.pathname.match(/^\/api\/marketplace\/cards\/([^/]+)\/sales$/);
        if (m) {
          p.then(r => r.ok && r.clone().json().then(j => whenReady(() => ingestSales(m[1], j)))).catch(() => {});
        } else if (/^\/api\/marketplace\/[0-9a-f-]{36}$/.test(url.pathname)) {
          // Tu ouvres la page d'une enchère : si elle est finie, son prix final exact rejoint les prix observés.
          const id = url.pathname.split('/').pop();
          p.then(r => r.ok && r.clone().json().then(j => whenReady(() => { if (ingestFinal(id, j)) { saveDb(); refresh(); } else overlaySoon(); }))).catch(() => {});
        } else if (url.pathname === '/api/my-collection') {
          p.then(r => r.ok && r.clone().json().then(j => whenReady(() => ingestCollection(j.collection, false)))).catch(() => {});
        } else if (url.pathname === '/api/marketplace') {
          p.then(r => r.ok && r.clone().json().then(j => whenReady(() => ingestMarket(j)))).catch(() => {});
        } else if (url.pathname === '/api/trades') {
          p.then(r => r.ok && r.clone().json().then(j => whenReady(() => ingestTrades(j)))).catch(() => {});
        } else if (url.pathname === '/api/notifications') {
          p.then(r => r.ok && r.clone().json().then(j => whenReady(() => ingestAlerts(j)))).catch(() => {});
        } else if (url.pathname === '/api/cards' && url.searchParams.get('wishlist') === '1') {
          p.then(r => r.ok && r.clone().json().then(j => whenReady(() => ingestWish(j, false)))).catch(() => {});
        } else if (url.pathname === '/api/cards') {
          // Page « Toutes les cartes » : on apprend seulement les titres, pour poser les pastilles de valeur.
          p.then(r => r.ok && r.clone().json().then(j => {
            if (j && Array.isArray(j.cards)) for (const c of j.cards) if (c && okKey(c.id) && typeof c.wikipedia_title === 'string') {
              seenTitle.set(c.wikipedia_title, c.id);
              if (rarOk(c.rarity)) seenRarity.set(c.id, c.rarity);
            }
            overlaySoon();
          })).catch(() => {});
        } else if (/^\/api\//.test(url.pathname)) {
          // Toute autre réponse du site (collection d'un ami dans un échange, profil…) : on apprend seulement
          // quel titre correspond à quelle carte, pour reconnaître ces cartes sur la page.
          p.then(r => r.ok && /json/.test(r.headers.get('content-type') || '') && r.clone().json().then(learnTitles)).catch(() => {});
        }
      }
    } catch (e) {}
    return p;
  };

  // ---------- calculs ----------
  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Fiabilité d'un prix : assez de ventes, assez récentes, pas trop dispersées.
  // 2 = fiable, 1 = moyen, 0 = douteux
  function reliability(sales) {
    const v = sales.map(s => s.p);
    const ts = Date.parse(sales[0].t);
    const age = Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / DAY) : Infinity;
    const spread = Math.max(...v) / Math.max(1, Math.min(...v));
    let level = v.length >= 5 && age <= 30 ? 2 : v.length >= 2 && age <= 90 ? 1 : 0;
    if (level > 0 && spread > 5) level--;
    return { level, age, spread };
  }
  // Tendance : la moitié la plus récente des ventes comparée à la plus ancienne. 1 hausse, -1 baisse, 0 stable.
  function trendOf(sales) {
    if (sales.length < 4) return 0;
    const half = Math.floor(sales.length / 2);
    const recent = median(sales.slice(0, half).map(s => s.p));
    const old = median(sales.slice(-half).map(s => s.p));
    if (!old) return 0;
    const ratio = recent / old;
    return ratio > 1.25 ? 1 : ratio < 0.8 ? -1 : 0;
  }
  let priceCache = new Map(), rarMap = null;
  function resetPrices() { priceCache = new Map(); rarMap = null; }
  // Rareté actuelle d'une carte, quand on la connaît : ta collection, tes souhaits, sinon ce que le site a affiché.
  const seenRarity = new Map();
  function rarityOf(cardId) {
    if (!rarMap) {
      rarMap = new Map();
      for (const c of Object.values(db.cards)) if (c && rarOk(c.rarity)) rarMap.set(c.cardId, c.rarity);
    }
    const w = db.wish[cardId];
    return rarMap.get(cardId) || (w && rarOk(w[1]) ? w[1] : '') || seenRarity.get(cardId) || '';
  }
  // Les ventes d'une liste qui conviennent à une rareté : celles de cette rareté ; sinon celles de rareté inconnue
  // (anciennes données) ; sinon toutes, signalées comme mélangées.
  function salesFor(list, rarity) {
    if (!Array.isArray(list) || !list.length || !rarOk(rarity)) return { sales: Array.isArray(list) ? list : [], mixed: false };
    const same = list.filter(s => s.r === rarity);
    if (same.length) return { sales: same, mixed: false };
    const unknown = list.filter(s => !s.r);
    if (unknown.length) return { sales: unknown, mixed: false };
    return { sales: list, mixed: true };
  }
  // Prix d'une carte à une rareté donnée (par défaut, sa rareté actuelle) : un exemplaire UR ne se vend pas comme un L.
  // Sources, de la plus sûre à la moins sûre : historique Pro, tes ventes et achats, fins d'enchères observées
  // (par le script ou par un ami). On prend la première qui a des ventes à la bonne rareté ; à défaut, la première qui
  // a des ventes, en le signalant (mixed).
  function priceOf(cardId, rarity) {
    const want = rarity === undefined ? rarityOf(cardId) : (rarOk(rarity) ? rarity : '');
    const key = cardId + '|' + want;
    if (priceCache.has(key)) return priceCache.get(key);
    const rec = db.prices[cardId];
    const sources = [['pro', rec && rec.sales], ['own', db.mySales[cardId]], ['obs', db.obsSales[cardId]]]
      .map(([kind, list]) => Object.assign({ kind }, salesFor(list, want))).filter(s => s.sales.length);
    const src = sources.find(s => !s.mixed) || sources[0];
    let out = null;
    if (!src) out = rec && Array.isArray(rec.sales) ? { n: 0, at: rec.at } : null;
    else {
      const sales = src.sales, own = src.kind === 'own', obs = src.kind === 'obs';
      const v = sales.map(s => s.p);
      const at = (rec ? rec.at : 0) || (src.kind === 'pro' ? 0 : db.market.at);
      out = {
        avg: v.reduce((a, b) => a + b, 0) / v.length, med: median(v),
        last: v[0], lastT: sales[0].t, min: Math.min(...v), max: Math.max(...v), n: v.length, at, own, obs,
        rel: reliability(sales), trend: trendOf(sales), sales, mixed: src.mixed, r: want
      };
      // Un prix observé provisoire est un minimum, pas un prix final : tant qu'il en reste un, pas de « Fiable ».
      // Des prix finaux tous relus sur la page des enchères valent l'historique Pro.
      out.exact = obs && sales.every(s => s.x);
      if (obs && !out.exact && out.rel.level > 1) out.rel.level = 1;
      // Aucune vente connue à cette rareté : le prix d'autres raretés n'est qu'une indication.
      if (src.mixed) out.rel.level = 0;
      // Relevé Pro reçu d'un ami : son pseudo, pour le dire au survol.
      out.by = (src.kind === 'pro' && rec && rec.by) || '';
    }
    priceCache.set(key, out);
    return out;
  }
  // Valeur d'une carte : médiane de ses ventes, jamais moins que la défausse ; sans vente connue, la défausse.
  function valueOf(cardId, rarity) {
    const p = priceOf(cardId, rarity);
    return p && p.n ? Math.max(p.med, DISCARD) : DISCARD;
  }
  // Une enchère en cours sur cette carte : valable jusqu'à sa fin si elle est connue, sinon 48 h.
  // Le prix de la ligne est la moins chère des annonces à la rareté voulue (par défaut, celle de la carte) : un exemplaire
  // d'une autre rareté ne donne pas le prix d'une ligne L. « list » garde toutes les annonces, chacune avec sa rareté ;
  // « other » compte celles d'une autre rareté.
  function askOf(cardId, rarity) {
    const a = db.market.asks[cardId];
    if (!a) return null;
    const now = Date.now();
    const list = (a.list || [{ i: a.i, a: a.a, b: a.b, e: a.e, r: a.r }]).filter(x => x && (x.e ? x.e > now : now - a.t < 2 * DAY));
    if (!list.length) return null;
    const want = rarity === undefined ? rarityOf(cardId) : rarity;
    const same = rarOk(want) ? list.filter(x => !rarOk(x.r) || x.r === want) : list;
    const top = (same.length ? same : list)[0];
    return { a: top.a, b: top.b, e: top.e, i: top.i, t: a.t, r: rarOk(top.r) ? top.r : '', list, other: list.length - same.length };
  }
  // Le prix auquel comparer une annonce : celui de sa propre rareté.
  const priceForAsk = (cardId, ask, price) => (ask && rarOk(ask.r) && (!price || ask.r !== price.r) ? priceOf(cardId, ask.r) : price);
  // Bonne affaire : une annonce au moins 30 % sous la valeur médiane, quand cette médiane repose sur 3 ventes ou plus.
  const DEAL_PCT = 30;
  function dealPct(ask, price) {
    if (!ask || !price || !(price.n >= 3) || !(price.med > DISCARD)) return 0;
    const pct = Math.round(100 * (1 - ask.a / price.med));
    return pct >= DEAL_PCT ? pct : 0;
  }
  // Une annonce se compare à la valeur de sa propre rareté (c.id : la carte, c.ask : son annonce, c.price : la valeur de la ligne).
  const dealOf = c => (c && c.ask ? dealPct(c.ask, priceForAsk(c.id, c.ask, c.price)) : 0);
  const isDeal = c => dealOf(c) > 0;
  // Enchère max conseillée : la valeur médiane. Au-delà, tu paies la carte plus cher que ce qu'elle se vend d'habitude.
  const maxBid = price => (price && price.n ? Math.max(DISCARD, Math.floor(price.med)) : null);
  // Une enchère dure 12 h au plus : une alerte plus ancienne concerne forcément une enchère terminée.
  const ALERT_TTL = 12 * 36e5;
  // Les alertes récentes dont on ne connaît pas encore le prix, une par carte, les plus récentes d'abord.
  function alertsToCheck() {
    const now = Date.now(), seen = new Set(), todo = [];
    for (const [id, a] of Object.entries(db.alerts).sort((x, y) => y[1][2] - x[1][2])) {
      if (a[3] === 2 || now - a[2] > ALERT_TTL || seen.has(a[0])) continue;
      seen.add(a[0]);
      const ask = db.market.asks[a[0]];
      if (ask && now - ask.t < 20 * 6e4 && askOf(a[0])) continue;
      todo.push([id, a]);
    }
    return todo;
  }
  // Niveau de prix par rareté, d'après les enchères en cours qui ont déjà reçu une offre.
  function marketByRarity() {
    const by = {}, now = Date.now();
    for (const id in db.market.asks) {
      const raw = db.market.asks[id];
      if (now - raw.t > DAY) continue;
      const live = askOf(id);
      if (!live) continue;
      for (const x of live.list) if (x.b) (by[raw.r] = by[raw.r] || []).push(x.a);
    }
    return RARITIES.filter(r => by[r] && by[r].length >= 3).map(r => ({ r, med: median(by[r]), n: by[r].length }));
  }
  function buildRows() {
    const rows = Object.entries(db.cards).map(([id, c]) => ({ id, ...c, price: priceOf(c.cardId, c.rarity), ask: askOf(c.cardId, c.rarity) }));
    for (const r of rows) {
      const known = r.price && r.price.n > 0;
      r.value = valueOf(r.cardId, r.rarity);
      r.est = !known;
      r.total = r.value * r.count;
    }
    return rows;
  }
  // Une photo par jour de la collection, pour l'onglet Évolution : [valeur, cartes, cartes différentes, cartes déjà vendues]
  function dayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function snapshot(rows) {
    if (!rows.length || Date.now() - db.collectionAt > DAY) return;
    const entry = [Math.round(rows.reduce((a, r) => a + r.total, 0)), rows.reduce((a, r) => a + r.count, 0),
      rows.length, rows.filter(r => r.price && r.price.n > 0).length];
    const day = dayKey(new Date());
    const cur = db.history[day];
    if (cur && cur.join() === entry.join()) return;
    db.history[day] = entry;
    const days = Object.keys(db.history).sort();
    days.slice(0, Math.max(0, days.length - 400)).forEach(d => delete db.history[d]);
    saveDb();
  }
  // Il arrive que le site réponde « aucune vente » pour une carte qui en a : constaté sur des UR et SR très vendues.
  // Pour les raretés où « jamais vendue » est rare, une réponse vide est donc redemandée une fois,
  // et n'est gardée qu'une heure au lieu de 24.
  const DOUBT_EMPTY = new Set(['L', 'UR', 'SR', 'R']);
  // Quand relire le prix d'une carte : selon ce qu'elle pèse dans la valeur. Chaque jour pour une carte qui vaut plus de 50 ₩,
  // une L, une UR ou une carte en vente ; les autres selon leur rareté ; une carte sans prix, tout de suite.
  const DUE_DAYS = { L: 1, UR: 1, SR: 2, R: 4, PC: 7, C: 7 };
  const DUE_VALUE = 50;
  function dueDays(cardId, rarity) {
    const p = priceOf(cardId, rarity);
    if (p && p.n && p.med > DUE_VALUE) return 1;
    if (db.selling.some(x => x && x.c === cardId)) return 1;
    return DUE_DAYS[rarity] || 7;
  }
  function priceDue(cardId, rarity) {
    const p = db.prices[cardId];
    if (!p) return true;
    const age = Date.now() - p.at;
    return age > dueDays(cardId, rarity) * DAY || (!(p.sales || []).length && DOUBT_EMPTY.has(rarity) && age > 36e5);
  }
  // Les prix à relire (collection et souhaits en vente), de celui qui pèse le plus dans la valeur à celui qui pèse le moins.
  // Poids = valeur × exemplaires possédés. Sans prix, la valeur est la médiane des valeurs connues de la même rareté dans
  // la collection, sinon 1. Renvoie [carte, rareté, poids].
  function dueCards() {
    const by = new Map();
    for (const c of Object.values(db.cards)) {
      if (!c || !okKey(c.cardId)) continue;
      const k = c.cardId + '|' + c.rarity, e = by.get(k), n = Math.max(1, num(c.count));
      if (e) e[2] += n; else by.set(k, [c.cardId, c.rarity, n]);
    }
    const known = {};
    for (const [id, r] of by.values()) { const p = priceOf(id, r); if (p && p.n) (known[r] = known[r] || []).push(Math.max(p.med, DISCARD)); }
    for (const r in known) known[r] = median(known[r]); // une fois par rareté
    for (const id in db.wish) {
      const r = db.wish[id][1];
      if (okKey(id) && !by.has(id + '|' + r) && askOf(id, r)) by.set(id + '|' + r, [id, r, 1]);
    }
    const out = [];
    for (const [id, r, n] of by.values()) {
      if (!priceDue(id, r)) continue;
      const p = priceOf(id, r);
      out.push([id, r, (p && p.n ? Math.max(p.med, DISCARD) : known[r] || 1) * n]);
    }
    return out.sort((a, b) => b[2] - a[2]);
  }
  // retryOk() : la seconde lecture d'un historique vide est-elle permise (budget) ; onRetry() la compte.
  async function fetchSales(cardId, rarity, retryOk = () => true, onRetry = () => {}) {
    const url = '/api/marketplace/cards/' + encodeURIComponent(cardId) + '/sales';
    const empty = j => !j || !((Array.isArray(j.recent) && j.recent.length) || (Array.isArray(j.sales) && j.sales.length));
    let j = await getJSON(url);
    if (empty(j) && DOUBT_EMPTY.has(rarity) && retryOk()) {
      onRetry();
      await sleep(1500);
      j = await getJSON(url);
    }
    ingestSales(cardId, j, rarity);
  }
  function missingIds() {
    const ids = new Set();
    for (const c of Object.values(db.cards)) {
      if (!ui.chosen.has(c.rarity)) continue;
      if (priceDue(c.cardId, c.rarity)) ids.add(c.cardId);
    }
    return [...ids];
  }

  // ---------- chargements à la demande ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const job = { running: false, stop: false, where: 'status', delay: PRICE_DELAY, msg: '' };
  // Attente interrompue par le bouton Stop.
  async function waitStoppable(ms) {
    for (let t = 0; t < ms && !job.stop; t += 250) await sleep(250);
  }
  // Rythme entre deux requêtes d'un même traitement : une par seconde, ralenti si le site a déjà freiné.
  const pace = () => waitStoppable(job.delay + Math.random() * 500);
  // Le site freine quand on va trop vite (429) ou qu'il sature (5xx). On respecte le délai qu'il demande,
  // ou on attend de plus en plus longtemps, puis on reprend au même endroit, plus lentement.
  // On ne cherche pas à contourner ce frein : on l'attend.
  const BUSY = new Set([429, 502, 503, 504]);
  // Le site répond « automation_limit » quand il estime qu'un compte va trop vite. Ce n'est pas un simple ralentissement :
  // tout s'arrête, rien n'est retiré des files d'attente, et le relevé automatique se met en pause 24 h.
  const AUTO_LIMIT = 'automation_limit';
  async function getJSON(path) {
    for (let attempt = 0; ; attempt++) {
      let r = null;
      try {
        r = await nativeFetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      } catch (e) {
        r = null; // coupure réseau : traitée comme un site occupé
      }
      if (r && r.ok) return r.json();
      const status = r ? r.status : 0;
      const body = r ? await r.json().catch(() => null) : null;
      if (body && body.code === AUTO_LIMIT) {
        db.autoPauseUntil = Date.now() + DAY;
        saveDb();
        throw Object.assign(new Error('le site limite les relevés automatiques, réessaie plus tard'), { status, code: AUTO_LIMIT });
      }
      if (r && !BUSY.has(status)) throw Object.assign(new Error('HTTP ' + status), { status });
      if (!job.running || job.stop || attempt >= 6) throw Object.assign(new Error(status ? 'HTTP ' + status : 'réseau'), { status });
      const asked = r ? Number(r.headers.get('retry-after')) : NaN;
      const wait = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 600) * 1000 : 15000 * Math.pow(2, attempt);
      job.delay = Math.min(job.delay * 2, 8000);
      const before = ui.el[job.where] ? ui.el[job.where].textContent : '';
      setStatus('Le site demande de ralentir : pause de ' + Math.round(wait / 1000) + ' s, puis reprise automatique. ' + before, job.where);
      await waitStoppable(wait);
      setStatus(before, job.where);
    }
  }
  // Temps restant estimé, au rythme actuel (qui ralentit si le site a freiné).
  const eta = left => {
    if (left <= 0) return '';
    const s = Math.round(left * (job.delay + 550) / 1000);
    return ' · encore ' + (s < 60 ? s + ' s' : '~' + Math.round(s / 60) + ' min');
  };
  function startJob(msg, where) {
    job.running = true; job.stop = false; job.where = where || 'status'; job.delay = PRICE_DELAY;
    setStatus(msg, where); syncButtons();
  }
  function endJob(msg, where) { job.running = false; setStatus(msg, where); syncButtons(); refresh(); }

  // Lit toute la collection, page après page. hit(f) fait la requête f (et l'attente qui suit) ; onPage(n) suit la progression.
  // Renvoie null si stop() devient vrai avant la fin : une collection lue à moitié ne doit rien remplacer.
  async function readCollection(stop, hit, onPage) {
    const all = [];
    for (let page = 0; page < 400; page++) {
      if (stop()) return null;
      const j = await hit(() => getJSON('/api/my-collection?sort=rarity&page=' + page + '&stats=0'));
      const items = (j && j.collection) || [];
      all.push(...items);
      if (onPage) onPage(all.length);
      if (items.length < PAGE_SIZE) return all;
    }
    return all;
  }
  async function loadCollection() {
    if (job.running) return;
    startJob('Chargement de la collection…');
    try {
      const all = await readCollection(() => job.stop, f => f().then(r => sleep(400).then(() => r)), n => setStatus('Collection : ' + n + ' cartes…'));
      if (!all) return endJob('Arrêté, collection inchangée.');
      ingestCollection(all, true);
      endJob('Collection chargée : ' + all.length + ' cartes.');
    } catch (e) {
      endJob('Erreur pendant le chargement (' + e.message + ').');
    }
  }

  async function fillPrices() {
    if (job.running || proState() !== true) return;
    let ids = missingIds();
    if (!ids.length) return setStatus('Rien à compléter pour les raretés cochées.');
    startJob('Prix : 0 / ' + ids.length);
    if (poolOn()) {
      setStatus('Prix : recherche dans le pool du groupe…');
      await poolPrefetch(ids);
      ids = missingIds();
      if (!ids.length) return endJob('Tous les prix manquants étaient dans le pool du groupe.');
      setStatus('Prix : 0 / ' + ids.length);
    }
    let i = 0;
    try {
      const rarById = {};
      for (const c of Object.values(db.cards)) rarById[c.cardId] = c.rarity;
      for (const id of ids) {
        if (job.stop) break;
        await fetchSales(id, rarById[id]);
        i++;
        setStatus('Prix : ' + i + ' / ' + ids.length + eta(ids.length - i));
        if (i < ids.length) await pace();
      }
      endJob(job.stop ? 'Arrêté à ' + i + ' / ' + ids.length + '.' : 'Prix complétés pour ' + i + ' cartes.');
    } catch (e) {
      if (e.code !== AUTO_LIMIT && [401, 402, 403].includes(e.status)) {
        return endJob('Le site refuse l’historique des ventes pour ce compte (réservé au Pro ?). ' +
          'Le tableau reste utilisable sans les prix : raretés, ATK, DEF, Q-Score, export CSV.');
      }
      endJob('Arrêt sur erreur (' + e.message + ') après ' + i + ' / ' + ids.length + '. Réessaie plus tard.');
    }
  }

  // Lit les premières pages de la page Marché, comme si tu les feuilletais.
  // sort : « recent » pour les dernières annonces, « ending_soon » pour les enchères sur le point de finir,
  // dont l'offre en cours est presque le prix final.
  // rare : pages lues en plus pour chaque rareté de RARE_SWEEP, avec le filtre de rareté du site. Sans lui, les L, UR et SR
  // se perdent parmi les centaines d'enchères qui finissent chaque minute.
  const RARE_SWEEP = ['L', 'UR', 'SR'];
  const RARE_PAGES = 3;
  function sweepUrls(pages, rare, sort) {
    const s = sort || 'ending_soon', urls = [];
    for (let p = 1; p <= pages; p++) urls.push('/api/marketplace?page=' + p + '&limit=50&sort=' + s + (p === 1 ? '&mine=1' : ''));
    for (const r of rare ? RARE_SWEEP : []) for (let p = 1; p <= rare; p++) urls.push('/api/marketplace?page=' + p + '&limit=50&sort=' + s + '&rarity=' + r);
    return urls;
  }
  const sweepGroup = url => (/&rarity=(\w+)/.exec(url) || [])[1] || '';
  async function scanMarket(pages, where, sort, rare) {
    if (job.running) return;
    startJob('Lecture du marché…', where);
    let seen = 0, n = 0;
    const done = new Set();
    try {
      for (const url of sweepUrls(pages, rare || 0, sort || 'recent')) {
        if (job.stop) break;
        if (done.has(sweepGroup(url))) continue; // plus de page dans cette rareté
        if (n++) await pace();
        const j = await getJSON(url);
        ingestMarket(j);
        seen += (j.auctions || []).length;
        setStatus('Marché : ' + seen + ' enchères lues…', where);
        if (!j.hasMore) done.add(sweepGroup(url));
      }
      endJob(pages === 1 ? 'Ventes en cours à jour.'
        : seen + ' enchères lues. Leur prix sera enregistré quand elles seront finies, d’ici quelques minutes.', where);
    } catch (e) {
      endJob('Lecture du marché impossible (' + e.message + ').', where);
    }
  }

  // Relit la page de chaque enchère suivie qui vient de finir, pour remplacer le prix provisoire par le prix final exact.
  // Pour tous les comptes, Pro ou non : c'est la page qu'on ouvre en cliquant sur une annonce du Marché.
  async function fetchFinals(where) {
    if (job.running) return;
    where = where || 'status';
    startJob('Prix finaux…', where);
    // Ceux que le groupe connaît déjà ne sont pas relus sur le site. Pool injoignable : on lit tout sur le site, comme avant.
    let fromPool = 0;
    if (poolOn()) {
      setStatus('Prix finaux : recherche dans le pool du groupe…', where);
      try { fromPool = await poolKnown(); } catch (e) { poolNote(e); }
    }
    const poolMsg = fromPool ? ' ' + plural(fromPool, 'prix final trouvé', 'prix finaux trouvés') + ' dans le pool du groupe.' : '';
    const todo = finalsToFetch();
    if (!todo.length) return endJob((poolMsg ? poolMsg.trim() + ' ' : '') + 'Aucun prix final à relever pour l’instant. « Relever les fins d’enchères » en prépare : leurs prix finaux se relèvent quelques minutes après.', where);
    setStatus('Prix finaux : 0 / ' + todo.length, where);
    const mine = myCards();
    let i = 0, sold = 0, soldMine = 0;
    try {
      for (const id of todo) {
        if (job.stop) break;
        const card = db.finQ[id] && db.finQ[id][0];
        try {
          const j = await getJSON('/api/marketplace/' + encodeURIComponent(id));
          ingestFinal(id, j);
          if (j && j.auction && typeof j.auction.final_price === 'number') {
            sold++;
            if (mine[card] || db.wish[card]) soldMine++;
          }
        } catch (e) {
          // Enchère retirée ou inaccessible : on l'oublie. Mais une limite du site arrête tout, sans rien oublier.
          if (e.code !== AUTO_LIMIT && (e.status === 404 || e.status === 403)) delete db.finQ[id];
          else throw e;
        }
        i++;
        if (i % 10 === 0) saveDb();
        setStatus('Prix finaux : ' + i + ' / ' + todo.length + eta(todo.length - i), where);
        if (i < todo.length) await pace();
      }
      saveDb();
      endJob((job.stop ? 'Arrêté à ' + i + ' / ' + todo.length + '. ' : '') + plural(sold, 'prix final relevé', 'prix finaux relevés') +
        (soldMine ? ', dont ' + fmt(soldMine) + ' sur tes cartes ou tes souhaits,' : '') + ' sur ' + plural(i, 'enchère lue', 'enchères lues') + '.' + poolMsg, where);
    } catch (e) {
      saveDb();
      endJob(e.code === AUTO_LIMIT
        ? 'Le site limite les relevés automatiques : arrêt après ' + i + ' / ' + todo.length + '. Réessaie plus tard. Le relevé automatique est en pause 24 h.'
        : 'Arrêt sur erreur (' + e.message + ') après ' + i + ' / ' + todo.length + '. Réessaie plus tard.', where);
    }
  }

  // ---------- relevé automatique (option, désactivé par défaut) ----------
  // Tant qu'un onglet du site est affiché, un petit relevé toutes les 30 min : d'abord les prix finaux les plus utiles,
  // puis une lecture des fins d'enchères qui prépare le suivant. Une requête par seconde, un seul onglet à la fois,
  // il ne bloque pas les boutons et s'efface dès qu'un relevé manuel démarre. Les amis sans Pro accumulent ainsi des prix sans rien cliquer.
  const AUTO_KEY = 'wmstats.auto';   // verrou et horloge partagés entre les onglets, à part de la base
  const AUTO_EVERY = 30 * 6e4;       // un passage au plus toutes les 30 min
  const AUTO_WARMUP = 2 * 6e4;       // pas avant 2 min après l'ouverture de la page
  const auto = { busy: false, loadedAt: Date.now(), tab: Math.random().toString(36).slice(2) };
  const readAuto = () => { try { return JSON.parse(localStorage.getItem(AUTO_KEY)) || {}; } catch (e) { return {}; } };
  const writeAuto = o => { try { localStorage.setItem(AUTO_KEY, JSON.stringify(o)); } catch (e) {} };
  const autoSleep = () => sleep(PRICE_DELAY + Math.random() * 500);
  // Le verrou est à cet onglet, ou libre. Un onglet qui l'a perdu (attente plus longue que le verrou) s'arrête, et ne le rend pas.
  const ownsAuto = () => { const a = readAuto(); return !(num(a.until) > Date.now() && a.tab !== auto.tab); };
  const holdAuto = () => writeAuto({ tab: auto.tab, until: Date.now() + 2 * 6e4, at: num(readAuto().at) });
  const releaseAuto = () => { if (ownsAuto()) writeAuto({ tab: auto.tab, until: 0, at: Date.now() }); };
  function autoDue(now) {
    if (!ov('autoObs') || auto.busy || job.running) return false;
    // En arrière-plan aussi : le navigateur ralentit alors les minuteries, et le passage avec.
    if (now - auto.loadedAt < AUTO_WARMUP || db.autoPauseUntil > now) return false;
    const a = readAuto();
    if (num(a.until) > now && a.tab !== auto.tab) return false; // un autre onglet relève en ce moment
    return now - num(a.at) >= AUTO_EVERY;
  }
  const AUTO_BUDGET = 60;     // requêtes au site par passage automatique : le site détecte l'automatisation, on reste modeste
  const ALERTS_PER_PASS = 20;
  const routineCounts = () => ({ prices: 0, alerts: 0, finals: 0, collection: false, wish: false });
  // Un passage de la routine, étape par étape, de la plus utile à la moins utile :
  //   1. la collection, relue en entier une fois par jour (en automatique, le passage s'arrête ensuite) ;
  //   2. la liste de souhaits, relue en entier une fois par jour ;
  //   3. les souhaits que le site a signalés en vente ;
  //   4. les prix à relire (priceDue), du plus lourd au plus léger : le pool d'abord, puis le site (compte Pro) ;
  //   5. les prix finaux, puis la lecture des fins d'enchères qui prépare le passage suivant (hors budget, comme avant).
  // manual (bouton) : pas de budget, rythme des boutons, Stop. Sinon : 60 requêtes, et arrêt dès qu'un relevé manuel démarre.
  // Le verrou entre onglets est renouvelé à chaque requête. out reçoit les compteurs au fil de l'eau.
  async function routinePass({ manual, out = routineCounts() }) {
    const stop = manual ? () => job.stop || !ownsAuto() : () => job.running || job.stop || !ownsAuto();
    // Le verrou reste tenu pendant les attentes longues (le site peut demander jusqu'à 10 min de pause).
    const beat = setInterval(() => { if (ownsAuto()) holdAuto(); }, 30e3);
    try {
      return await routineSteps(manual, out, stop);
    } finally {
      clearInterval(beat);
    }
  }
  async function routineSteps(manual, out, stop) {
    let used = 0;
    const left = () => (manual ? Infinity : AUTO_BUDGET - used);
    const hit = async (f, counted = true) => {
      if (counted) used++;
      holdAuto();
      const r = await f();
      if (manual) setStatus('Mise à jour en cours : ' + routineSummary(out) + '…');
      await (manual ? pace() : autoSleep());
      return r;
    };
    if (Date.now() - num(db.collectionFullAt) > DAY) {
      const all = await readCollection(stop, hit);
      if (!all) return out;
      ingestCollection(all, true);
      out.collection = true;
      if (!manual) return out;
    }
    if (Date.now() - num(db.wishFullAt) > DAY && !stop()) {
      const all = await readWishlist(stop, hit);
      if (all) { ingestWish({ cards: all }, true); out.wish = true; }
    }
    for (const [, a] of alertsToCheck().slice(0, manual ? Infinity : ALERTS_PER_PASS)) {
      if (stop() || left() <= 0) break;
      await hit(() => searchCard(a[0], a[1]));
      out.alerts++;
    }
    let due = dueCards();
    if (due.length && poolOn() && !stop()) {
      await poolPrefetch(due.map(x => x[0]));
      due = due.filter(([id, r]) => priceDue(id, r));
    }
    if (proState() === true) {
      for (const [id, r] of due) {
        if (stop() || left() <= 0) break;
        await hit(() => fetchSales(id, r, () => left() > 0 && !stop(), () => { used++; holdAuto(); }));
        out.prices++;
      }
    }
    if (poolOn() && !stop()) { try { await poolKnown(); } catch (e) { poolNote(e); } }
    for (const id of finalsToFetch()) {
      if (stop() || left() <= 0) break;
      try {
        const j = await hit(() => getJSON('/api/marketplace/' + encodeURIComponent(id)));
        ingestFinal(id, j);
        if (j && j.auction && typeof j.auction.final_price === 'number') out.finals++;
      } catch (e) {
        if (e.code === AUTO_LIMIT) throw e;
        if (e.status === 404 || e.status === 403) delete db.finQ[id];
        else throw e;
      }
    }
    if (!stop()) {
      const done = new Set();
      for (const url of sweepUrls(MARKET_PAGES, RARE_PAGES, 'ending_soon')) {
        if (stop()) break;
        if (done.has(sweepGroup(url))) continue;
        const j = await hit(() => getJSON(url), false);
        ingestMarket(j);
        if (!j.hasMore) done.add(sweepGroup(url));
      }
    }
    return out;
  }
  const routineSummary = o => plural(num(o.prices), 'prix relu', 'prix relus') + ', ' + plural(num(o.alerts), 'annonce vérifiée', 'annonces vérifiées') +
    ', ' + plural(num(o.finals), 'prix final', 'prix finaux');
  // Bouton « Tout mettre à jour maintenant » : la même routine, sans budget, au rythme des boutons, avec Stop.
  async function updateAll() {
    if (job.running) return;
    // Un autre onglet fait déjà un passage : on ne lit pas le site en double.
    const lock = readAuto();
    if (num(lock.until) > Date.now() && lock.tab !== auto.tab) {
      return setStatus('Une mise à jour tourne déjà dans un autre onglet du site. Réessaie dans quelques minutes.');
    }
    startJob('Mise à jour en cours…');
    // La progression et le bouton Stop sont dans l'onglet Collection.
    if (ui.el.view_col && ui.tab !== 'col') setTab('col');
    // Un passage automatique de cet onglet voit job.running et s'arrête à sa prochaine requête : on l'attend, pour ne pas lire le site à deux.
    if (auto.done) await auto.done;
    const out = routineCounts();
    holdAuto();
    let err = null;
    try { await routinePass({ manual: true, out }); } catch (e) { err = e; }
    db.autoLast = Object.assign({ at: Date.now() }, out);
    releaseAuto();
    saveDb();
    endJob(err ? 'Mise à jour interrompue (' + err.message + ') : ' + routineSummary(out) + '.'
      : (job.stop ? 'Arrêtée : ' : 'Mise à jour terminée : ') + routineSummary(out) + '.');
  }
  // État de la mise à jour automatique (Accueil et Réglages).
  function autoLine() {
    if (db.autoPauseUntil > Date.now()) return 'En pause : le site a limité les relevés automatiques. Reprise plus tard.';
    const a = db.autoLast;
    if (!a || !a.at) return 'Aucune mise à jour automatique pour l’instant.';
    return 'Dernière mise à jour automatique : ' + ago(a.at) + ' · ' + routineSummary(a) + '.' +
      (proState() === true ? ' Encore ' + plural(dueCards().length, 'carte à relire', 'cartes à relire') + '.' : '');
  }
  // auto.done : la promesse du passage en cours, que le bouton attend avant de démarrer.
  function autoRun() {
    if (auto.busy || job.running) return Promise.resolve();
    auto.busy = true;
    auto.done = (async () => {
      const out = routineCounts();
      holdAuto();
      try {
        await routinePass({ manual: false, out });
      } catch (e) { /* limite du site, réseau : on s'arrête et on reprendra au prochain passage */ }
      db.autoLast = Object.assign({ at: Date.now() }, out);
      releaseAuto();
      saveDb();
      auto.busy = false;
      auto.done = null;
      refresh();
    })();
    return auto.done;
  }

  // Les cartes passées dans tes échanges dont l'historique de ventes manque ou date.
  // Une carte donnée n'est plus dans ta collection : « Relever les prix » ne la voit donc jamais.
  const TRADE_BATCH = Infinity; // plus de plafond : tout est traité, au rythme du site
  function tradeCardsToPrice() {
    const out = [], seen = new Set();
    const list = Object.values(db.trades).sort(byDateDesc).sort((a, b) => (b.s === 'accepted') - (a.s === 'accepted'));
    for (const t of list) for (const c of t.g.concat(t.r)) {
      if (seen.has(c[0]) || !priceDue(c[0], c[2])) continue;
      seen.add(c[0]);
      out.push([c[0], c[2]]);
    }
    return out;
  }
  async function fillTradePrices() {
    if (job.running || proState() !== true) return;
    let todo = tradeCardsToPrice().slice(0, TRADE_BATCH);
    if (!todo.length) return setStatus('Toutes les cartes échangées ont déjà un prix relevé.', 'tradeStatus');
    startJob('Prix : 0 / ' + todo.length, 'tradeStatus');
    if (poolOn()) {
      await poolPrefetch(todo.map(x => x[0]));
      todo = todo.filter(([id, r]) => priceDue(id, r));
      if (!todo.length) return endJob('Tous les prix étaient dans le pool du groupe.', 'tradeStatus');
    }
    let i = 0;
    try {
      for (const [id, rarity] of todo) {
        if (job.stop) break;
        await fetchSales(id, rarity);
        i++;
        setStatus('Prix : ' + i + ' / ' + todo.length + eta(todo.length - i), 'tradeStatus');
        if (i < todo.length) await pace();
      }
      endJob(job.stop ? 'Arrêté à ' + i + ' / ' + todo.length + '.' : 'Prix relevés pour ' + plural(i, 'carte échangée', 'cartes échangées') + '.', 'tradeStatus');
    } catch (e) {
      endJob('Arrêt sur erreur (' + e.message + ') après ' + i + ' / ' + todo.length + '. Réessaie plus tard.', 'tradeStatus');
    }
  }

  // Relit tes échanges, comme en ouvrant la page Échanges du site.
  async function loadTrades() {
    if (job.running) return;
    if (!db.userId) return setStatus('Recharge d’abord la page (F5), pour que le script sache quel compte est le tien.', 'tradeStatus');
    startJob('Lecture des échanges…', 'tradeStatus');
    try {
      const j = await getJSON('/api/trades');
      ingestTrades(j);
      endJob(plural((j.trades || []).length, 'échange lu', 'échanges lus') + '.', 'tradeStatus');
    } catch (e) {
      endJob('Lecture impossible (' + e.message + ').', 'tradeStatus');
    }
  }

  // Lit ta liste de souhaits page par page, comme la page « Toutes les cartes » avec son filtre.
  // Lit toute la liste de souhaits (mêmes règles que readCollection).
  async function readWishlist(stop, hit, onPage) {
    const all = [];
    for (let page = 0; page < 100; page++) {
      if (stop()) return null;
      const j = await hit(() => getJSON('/api/cards?page=' + page + '&sort=rarity&wishlist=1'));
      const cards = (j && j.cards) || [];
      all.push(...cards);
      if (onPage) onPage(all.length);
      if (cards.length < PAGE_SIZE || (j && typeof j.total === 'number' && all.length >= j.total)) return all;
    }
    return all;
  }
  async function loadWish() {
    if (job.running) return;
    startJob('Lecture de la liste de souhaits…', 'wishStatus');
    try {
      const all = await readWishlist(() => job.stop, f => f().then(r => pace().then(() => r)), n => setStatus('Liste de souhaits : ' + n + ' cartes…', 'wishStatus'));
      if (!all) return endJob('Arrêté, liste inchangée.', 'wishStatus');
      ingestWish({ cards: all }, true);
      endJob('Liste de souhaits chargée : ' + all.length + ' cartes.', 'wishStatus');
    } catch (e) {
      endJob('Lecture impossible (' + e.message + ').', 'wishStatus');
    }
  }

  // Pour chaque alerte récente, cherche la carte sur le marché par son titre, comme avec la barre de recherche.
  const ALERT_BATCH = Infinity;
  const SEARCH_BATCH = Infinity;  // plus de plafond : tout est traité, au rythme du site
  const SEARCH_FRESH = 60 * 6e4;  // une carte cherchée depuis moins d'une heure n'est pas recherchée à nouveau
  // Cherche une liste de cartes [identifiant, titre] sur le marché, une recherche par seconde.
  // Cherche une carte sur le marché par son titre (une requête). Renvoie vrai si elle est en vente.
  async function searchCard(cardId, title) {
    const j = await getJSON('/api/marketplace?page=1&limit=50&sort=recent&q=' + encodeURIComponent(title));
    // La recherche fait foi pour cette carte : on repart de ce qu'elle renvoie.
    delete db.market.asks[cardId];
    ingestMarket(j);
    const found = ((j && j.auctions) || []).some(x => x && x.card_id === cardId);
    for (const id in db.alerts) if (db.alerts[id][0] === cardId) db.alerts[id][3] = found ? 1 : 2;
    db.wishSeen[cardId] = Date.now();
    return found;
  }
  async function marketSearch(todo, label, noneText, where) {
    where = where || 'wishStatus';
    startJob(label + ' : 0 / ' + todo.length, where);
    let i = 0, live = 0;
    try {
      for (const [cardId, title] of todo) {
        if (job.stop) break;
        if (await searchCard(cardId, title)) live++;
        i++;
        setStatus(label + ' : ' + i + ' / ' + todo.length + ' · ' + plural(live, 'carte en vente', 'cartes en vente') +
          eta(todo.length - i), where);
        if (i < todo.length) await pace();
      }
      saveDb();
      endJob((job.stop ? 'Arrêté à ' + i + ' / ' + todo.length + '. ' : '') + plural(live, 'carte en vente', 'cartes en vente') +
        ' sur ' + i + ', ' + (i - live) + ' ' + noneText + '.', where);
    } catch (e) {
      saveDb();
      endJob('Recherche interrompue (' + e.message + ') après ' + i + ' / ' + todo.length + '. Réessaie plus tard.', where);
    }
  }
  // Même chose pour ta collection : voir qui vend en ce moment les cartes que tu possèdes, et à quel prix.
  function colCards() {
    const seen = new Set(), out = [];
    for (const c of Object.values(db.cards)) {
      if (seen.has(c.cardId)) continue;
      seen.add(c.cardId);
      out.push(c);
    }
    return out;
  }
  // Les cartes de ta collection qui ont déjà une annonce connue.
  function colLive() {
    return colCards().filter(c => askOf(c.cardId)).map(c => [c.cardId, c.title]);
  }
  // Les cartes des raretés cochées pas encore cherchées, ou cherchées il y a le plus longtemps.
  function colToSearch() {
    const now = Date.now();
    return colCards()
      .filter(c => ui.chosen.has(c.rarity) && !(now - (db.wishSeen[c.cardId] || 0) < SEARCH_FRESH))
      .sort((a, b) => (db.wishSeen[a.cardId] || 0) - (db.wishSeen[b.cardId] || 0) || rarOrder(a.rarity) - rarOrder(b.rarity))
      .map(c => [c.cardId, c.title]);
  }
  function refreshCol() {
    if (job.running) return;
    const todo = colLive().slice(0, SEARCH_BATCH);
    if (!todo.length) return setStatus('Aucune annonce connue à rafraîchir. Lance d’abord « Chercher mes cartes sur le marché ».');
    return marketSearch(todo, 'Rafraîchissement', 'dont l’annonce est terminée', 'status');
  }
  function searchCol() {
    if (job.running) return;
    const todo = colToSearch().slice(0, SEARCH_BATCH);
    if (!todo.length) {
      return setStatus(Object.keys(db.cards).length
        ? 'Toutes les cartes des raretés cochées ont été cherchées il y a moins d’une heure.'
        : 'Charge d’abord ta collection.');
    }
    return marketSearch(todo, 'Recherche', 'sans annonce', 'status');
  }
  function checkAlerts() {
    if (job.running) return;
    const todo = alertsToCheck().slice(0, ALERT_BATCH).map(([, a]) => [a[0], a[1]]);
    if (!todo.length) return setStatus('Toutes les annonces récentes sont déjà à jour.', 'wishStatus');
    return marketSearch(todo, 'Annonces', 'dont l’enchère est terminée');
  }
  // Les cartes de la liste (selon le filtre de rareté) pas encore cherchées, ou cherchées il y a le plus longtemps.
  function ownedIds() {
    const s = new Set();
    for (const c of Object.values(db.cards)) s.add(c.cardId);
    return s;
  }
  function wishToSearch() {
    const now = Date.now();
    // Si les cartes déjà possédées sont cachées, inutile de les chercher sur le marché.
    const owned = db.wishHideOwned ? ownedIds() : null;
    return Object.keys(db.wish)
      .filter(id => (!ui.wishRarity || db.wish[id][1] === ui.wishRarity) && !(now - (db.wishSeen[id] || 0) < SEARCH_FRESH) &&
        !(owned && owned.has(id)))
      .sort((a, b) => (db.wishSeen[a] || 0) - (db.wishSeen[b] || 0) || rarOrder(db.wish[a][1]) - rarOrder(db.wish[b][1]));
  }
  // Les cartes de la liste qui ont une annonce connue ou une alerte récente : celles dont les prix peuvent avoir bougé.
  function wishLive() {
    const owned = db.wishHideOwned ? ownedIds() : null;
    const titles = {};
    for (const id in db.wish) titles[id] = [db.wish[id][0], db.wish[id][1]];
    for (const a of Object.values(db.alerts)) if (!titles[a[0]]) titles[a[0]] = [a[1], ''];
    const out = [];
    for (const id in titles) {
      if ((ui.wishRarity && titles[id][1] !== ui.wishRarity) || (owned && owned.has(id))) continue;
      if (askOf(id) || alertOf(id)) out.push([id, titles[id][0]]);
    }
    return out;
  }
  // Relit les annonces déjà affichées, sans attendre l'heure de délai de la recherche générale.
  // Souhaits en vente dont la valeur médiane manque ou date : il la faut pour juger une bonne affaire.
  function wishPricesToFetch() {
    const out = [];
    for (const id in db.wish) if (askOf(id) && priceDue(id, db.wish[id][1])) out.push([id, db.wish[id][1]]);
    return out;
  }
  // Cartes de la liste À vendre dont les annonces concurrentes n'ont pas été cherchées depuis une heure.
  function sellCompToSearch() {
    const now = Date.now();
    return sellList().filter(r => !(now - (db.wishSeen[r.cardId] || 0) < SEARCH_FRESH)).map(r => [r.cardId, r.title]);
  }
  // Relève l'historique de ventes d'une liste [carte, rareté] (compte Pro).
  async function fetchPricesFor(todo, where, one, many) {
    if (job.running) return;
    if (proState() !== true) return setStatus('Les prix de vente sont réservés aux comptes Pro.', where);
    if (!todo.length) return setStatus('Tous les prix sont déjà à jour.', where);
    startJob('Prix : 0 / ' + todo.length, where);
    if (poolOn()) {
      await poolPrefetch(todo.map(x => x[0]));
      todo = todo.filter(([id, r]) => priceDue(id, r));
      if (!todo.length) return endJob('Tous les prix étaient dans le pool du groupe.', where);
    }
    let i = 0;
    try {
      for (const [id, rarity] of todo) {
        if (job.stop) break;
        await fetchSales(id, rarity);
        i++;
        setStatus('Prix : ' + i + ' / ' + todo.length + eta(todo.length - i), where);
        if (i < todo.length) await pace();
      }
      endJob(job.stop ? 'Arrêté à ' + i + ' / ' + todo.length + '.' : 'Prix relevés pour ' + plural(i, one, many) + '.', where);
    } catch (e) {
      endJob('Arrêt sur erreur (' + e.message + ') après ' + i + ' / ' + todo.length + '.', where);
    }
  }
  function refreshWish() {
    if (job.running) return;
    const todo = wishLive().slice(0, SEARCH_BATCH);
    if (!todo.length) return setStatus('Aucune annonce à rafraîchir pour l’instant.', 'wishStatus');
    return marketSearch(todo, 'Rafraîchissement', 'dont l’annonce est terminée');
  }
  function searchWish() {
    if (job.running) return;
    const todo = wishToSearch().slice(0, SEARCH_BATCH).map(id => [id, db.wish[id][0]]);
    if (!todo.length) {
      return setStatus(Object.keys(db.wish).length
        ? 'Toutes les cartes de ce filtre ont été cherchées il y a moins d’une heure.'
        : 'Charge d’abord ta liste de souhaits.', 'wishStatus');
    }
    return marketSearch(todo, 'Recherche', 'sans annonce');
  }

  // ---------- après un booster : mémoire des tirages et prix des cartes tirées ----------
  const pull = { open: false, cards: [], queue: [], busy: false, note: '' };
  function advice(price) {
    if (!price) return { cls: 'unk', text: '—' };
    if (!price.n) return { cls: 'unk', text: 'Aucune vente' };
    return price.med > DISCARD
      ? { cls: 'sell', text: 'Vendre ~' + fmt(Math.round(price.med)) + ' ₩' }
      : { cls: 'drop', text: 'Défausser' };
  }
  function onPull(list, kind) {
    const cards = [];
    for (const it of list) {
      const c = (it && it.card) || it;
      if (!c) continue;
      const cardId = it.card ? c.id : (c.card_id || c.id);
      if (typeof cardId === 'string' && !BAD_KEYS.has(cardId)) {
        cards.push({ cardId, title: String(c.wikipedia_title || c.title || '?').slice(0, 200), rarity: rarOf(c.rarity) });
      }
    }
    if (!cards.length) return;
    db.pulls.push({ t: Date.now(), k: String(kind || '').slice(0, 20), c: cards.map(c => [c.cardId, c.title, c.rarity]) });
    if (db.pulls.length > MAX_PULLS) db.pulls.splice(0, db.pulls.length - MAX_PULLS);
    saveDb();
    const pro = proState();
    if (pro !== false && db.autoPull !== false) {
      pull.cards = cards;
      pull.open = true;
      pull.note = pro === true ? '' : 'Statut Pro pas encore détecté : recharge la page (F5) pour activer les prix.';
      if (pro === true) {
        const now = Date.now();
        for (const c of cards) {
          if (priceDue(c.cardId, c.rarity) && !pull.queue.includes(c.cardId)) pull.queue.push(c.cardId);
        }
        runPullQueue();
      }
    }
    refresh();
  }
  async function runPullQueue() {
    if (pull.busy) return;
    pull.busy = true;
    try {
      if (poolOn()) {
        await poolPrefetch(pull.queue.slice());
        pull.queue = pull.queue.filter(id => { const c = pull.cards.find(x => x.cardId === id); return priceDue(id, c ? c.rarity : ''); });
        renderPull();
      }
      while (pull.queue.length) {
        const id = pull.queue[0];
        const pulled = pull.cards.find(c => c.cardId === id);
        await fetchSales(id, pulled ? pulled.rarity : '');
        pull.queue.shift();
        if (pull.queue.length) await sleep(600 + Math.random() * 300);
      }
    } catch (e) {
      pull.queue.length = 0;
      pull.note = 'Prix indisponibles pour le moment (' + e.message + ').';
    }
    pull.busy = false;
    renderPull();
  }
  // Cartes où tu enchéris : leur prix est relevé tout seul quand le site affiche Mes enchères (compte Pro),
  // une carte à la fois, à peu près au rythme d'après un booster. Rien n'est redemandé avant 24 h.
  // Si un autre relevé tourne ou si le site refuse ou freine, on s'arrête là : la suite viendra au prochain passage.
  const bidQ = { queue: [], busy: false };
  function queueBidPrices(list) {
    if (proState() !== true || !ov('bidAuto')) return;
    for (const a of list) {
      const id = a && a.card_id;
      if (!okKey(id) || bidQ.queue.some(x => x[0] === id)) continue;
      const r = rarOf(a.snapshot_rarity || (a.card && a.card.rarity));
      if (priceDue(id, r)) bidQ.queue.push([id, r]);
    }
    runBidQueue();
  }
  async function runBidQueue() {
    if (bidQ.busy) return;
    bidQ.busy = true;
    try {
      if (poolOn()) await poolPrefetch(bidQ.queue.map(x => x[0]));
      while (bidQ.queue.length && !job.running && !pull.busy) {
        const [id, r] = bidQ.queue.shift();
        if (!priceDue(id, r)) continue;
        await fetchSales(id, r);
        if (bidQ.queue.length) await sleep(900 + Math.random() * 400);
      }
    } catch (e) {}
    bidQ.queue.length = 0;
    bidQ.busy = false;
  }
  function renderPull() {
    const e = ui.el;
    if (!e.pull) return;
    e.pull.classList.toggle('open', pull.open && pull.cards.length > 0);
    if (!pull.open) return;
    const rows = pull.cards.map(c => {
      const p = priceOf(c.cardId, c.rarity);
      const a = advice(p);
      const info = !p ? (pull.queue.includes(c.cardId) ? 'prix en cours…' : 'prix non relevé')
        : !p.n ? 'jamais vendue aux enchères'
          : 'méd. ' + fmt(p.med) + ' · dern. ' + fmt(p.last) + ' · ' + fmt(p.min) + ' à ' + fmt(p.max) +
            ' · ' + p.n + ' vente' + (p.n > 1 ? 's' : '');
      return h('div', { class: 'row' },
        h('span', { class: 'r r-' + c.rarity }, c.rarity),
        h('div', { class: 't' }, h('b', null, c.title), h('span', null, info, p && p.n ? [' · ', relCell(p)] : null)),
        h('span', { class: 'adv ' + a.cls }, a.text));
    });
    if (pull.note) rows.push(h('div', { class: 'row sub' }, pull.note));
    e.pullList.replaceChildren(...rows);
  }

  // ---------- amis : export, import, comparaison ----------
  function myCards() {
    const mine = {};
    for (const c of Object.values(db.cards)) {
      const m = mine[c.cardId];
      if (m) { m.count += c.count; m.starred = m.starred || c.starred; }
      else mine[c.cardId] = { title: c.title, rarity: c.rarity, count: c.count, starred: !!c.starred };
    }
    return mine;
  }
  // Échange proposé avec un ami : ce qu'il cherche et que tu as en trop, contre ce que tu cherches et qu'il a en trop.
  // Par défaut, seulement des doublons (personne ne perd une carte), jamais tes favoris.
  // On part de tout ce qui est possible, puis on retire du côté le plus lourd tant que l'écart de valeur diminue.
  function tradeFor(f, mine, singles) {
    const val = (id, rarity) => { const p = priceOf(id, rarity); return { v: p && p.n ? Math.max(p.med, DISCARD) : DISCARD, unknown: !p }; };
    const giveAll = [], recvAll = [];
    for (const id in (f.wish || {})) {
      const m = mine[id];
      if (!m || m.starred || (!singles && m.count < 2)) continue;
      giveAll.push(Object.assign({ id, title: m.title, rarity: m.rarity, count: m.count }, val(id, m.rarity)));
    }
    for (const id in db.wish) {
      const c = f.cards[id];
      if (!c || mine[id] || (!singles && c[2] < 2)) continue;
      recvAll.push(Object.assign({ id, title: c[0], rarity: c[1], count: c[2] }, val(id, c[1])));
    }
    const byVal = (a, b) => b.v - a.v || a.title.localeCompare(b.title);
    giveAll.sort(byVal); recvAll.sort(byVal);
    const give = giveAll.slice(), recv = recvAll.slice();
    const sum = l => l.reduce((a, c) => a + c.v, 0);
    if (give.length && recv.length) {
      for (;;) {
        const gap = sum(recv) - sum(give);
        const heavy = gap > 0 ? recv : give;
        if (heavy.length <= 1) break;
        let best = -1, bestGap = Math.abs(gap);
        heavy.forEach((c, k) => { const g = Math.abs(Math.abs(gap) - c.v); if (g < bestGap) { bestGap = g; best = k; } });
        if (best < 0) break;
        heavy.splice(best, 1);
      }
    }
    return { give, recv, giveAll, recvAll, gTot: sum(give), rTot: sum(recv) };
  }
  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    ui.el.host.shadowRoot.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  // Le fichier pour tes amis : ta collection, tes souhaits, et tous les prix que tu as accumulés.
  function friendExport(pseudo) {
    const mine = myCards();
    const seen = observedExport();
    // Tes ventes et achats : des prix finaux exacts, que tout compte peut lire sur la page de l'enchère.
    // Pas dans la sauvegarde, qui a déjà tes enchères.
    for (const id in db.auctions) {
      const a = db.auctions[id];
      if (Array.isArray(a) && typeof a[6] === 'number' && a[6] > 0 && !a[8] && okKey(a[1])) seen.sales.push([a[1], a[6], a[7], 0, 1, id, rarOk(a[3]) ? a[3] : null]);
    }
    return {
      wmstats: 1, pseudo, at: Date.now(),
      cards: Object.keys(mine).map(id => [id, mine[id].title, mine[id].rarity, mine[id].count]),
      wish: Object.entries(db.wish).map(([id, w]) => [id, w[0], w[1]]),
      seen, pro: proExport(pseudo)
    };
  }
  function exportMine() {
    const pseudo = (db.me || '').trim();
    if (!pseudo) return setStatus('Écris d’abord ton pseudo.', 'frStatus');
    if (!Object.keys(db.cards).length) return setStatus('Charge d’abord ta collection dans l’onglet Collection.', 'frStatus');
    const data = friendExport(pseudo);
    download('wikimasters-collection-' + pseudo.replace(/[^\w-]+/g, '_') + '.json', JSON.stringify(data), 'application/json');
    setStatus('Fichier créé : envoie-le à tes amis.' + (data.pro.length ? ' Il contient ' + plural(data.pro.length, 'relevé Pro', 'relevés Pro') + '.' : ''), 'frStatus');
  }
  // Le fichier d'un ami est une donnée extérieure : on ne garde que des champs simples, bornés.
  function parseFriend(text) {
    const j = JSON.parse(text);
    if (!j || j.wmstats !== 1 || typeof j.pseudo !== 'string' || !Array.isArray(j.cards)) throw new Error('fichier non reconnu');
    let pseudo = j.pseudo.trim().slice(0, 40) || 'ami';
    if (BAD_KEYS.has(pseudo)) pseudo = 'ami';
    const cards = {};
    for (const c of j.cards.slice(0, 20000)) {
      if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string') continue;
      const id = c[0].slice(0, 64);
      if (BAD_KEYS.has(id)) continue;
      const n = Math.max(1, Math.min(999, Math.floor(Number(c[3]) || 1)));
      cards[id] = [c[1].slice(0, 200), rarOf(c[2]), (cards[id] ? cards[id][2] : 0) + n];
    }
    const wish = {};
    for (const c of (Array.isArray(j.wish) ? j.wish : []).slice(0, 5000)) {
      if (Array.isArray(c) && okKey(c[0]) && typeof c[1] === 'string') wish[c[0].slice(0, 64)] = [c[1].slice(0, 200), rarOf(c[2])];
    }
    return { pseudo, at: typeof j.at === 'number' ? j.at : Date.now(), cards, wish, seen: isObj(j.seen) ? j.seen : null, pro: Array.isArray(j.pro) ? j.pro : null };
  }

  // ---------- sauvegarde : passer ses données d'un navigateur à l'autre ----------
  // Le contenu de la sauvegarde. Volontairement sans db.pool : la clé du groupe ne sort jamais du navigateur.
  function backupData() {
    const data = {};
    for (const k of ['cards', 'collectionAt', 'prices', 'pulls', 'auctions', 'history', 'wish', 'wishAt', 'friends', 'me', 'sell']) data[k] = db[k];
    data.seen = observedExport();
    data.trades = db.trades;
    return data;
  }
  function exportBackup() {
    download('wikimasters-sauvegarde-' + dayKey(new Date()) + '.json',
      JSON.stringify({ wmstatsBackup: 1, at: Date.now(), data: backupData() }), 'application/json');
    setStatus('Sauvegarde créée. Importe ce fichier dans ton autre navigateur.', 'dataStatus');
  }
  const cleanSales = a => (Array.isArray(a) ? a : []).filter(s => s && typeof s.p === 'number')
    .slice(0, 40).map(s => (rarOk(s.r) ? { p: s.p, t: str(s.t, 40), r: s.r } : { p: s.p, t: str(s.t, 40) }));
  const cleanPairs = (o, max) => {
    const out = {};
    if (isObj(o)) for (const id of Object.keys(o).slice(0, max)) {
      const w = o[id];
      if (okKey(id) && Array.isArray(w)) out[id] = [str(w[0], 200), rarOf(w[1])];
    }
    return out;
  };
  // Fusion prudente : on ne remplace que par plus récent, et on ne garde que des champs connus et bornés.
  function mergeBackup(text) {
    const j = JSON.parse(text);
    if (!isObj(j) || j.wmstatsBackup !== 1 || !isObj(j.data)) throw new Error('ce n’est pas une sauvegarde du script');
    const b = j.data, n = { prix: 0, boosters: 0, enchères: 0, jours: 0 };
    if (isObj(b.prices)) for (const id in b.prices) {
      const p = b.prices[id], cur = db.prices[id];
      if (!okKey(id) || !isObj(p)) continue;
      if (!cur || num(p.at) > cur.at) {
        db.prices[id] = { at: num(p.at), sales: cleanSales(p.sales) };
        // Un relevé reçu d'un ami garde son origine.
        if (typeof p.by === 'string' && p.by.trim()) db.prices[id].by = p.by.trim().slice(0, 40);
        n.prix++;
      }
    }
    if (Array.isArray(b.pulls)) {
      const seen = new Set(db.pulls.map(p => p.t));
      for (const p of b.pulls.slice(-MAX_PULLS)) {
        if (!isObj(p) || !num(p.t) || seen.has(p.t) || !Array.isArray(p.c)) continue;
        const c = p.c.filter(x => Array.isArray(x) && okKey(x[0])).slice(0, 20).map(x => [x[0], str(x[1], 200), rarOf(x[2])]);
        if (c.length) { db.pulls.push({ t: p.t, k: str(p.k, 20), c }); n.boosters++; }
      }
      db.pulls.sort((x, y) => x.t - y.t);
      if (db.pulls.length > MAX_PULLS) db.pulls.splice(0, db.pulls.length - MAX_PULLS);
    }
    if (isObj(b.auctions)) for (const id in b.auctions) {
      const a = b.auctions[id];
      if (!okKey(id) || db.auctions[id] || !Array.isArray(a) || !['s', 'u', 'b'].includes(a[0]) || !okKey(a[1])) continue;
      db.auctions[id] = [a[0], a[1], str(a[2], 200), rarOf(a[3]), num(a[4]), num(a[5]), typeof a[6] === 'number' ? a[6] : null, str(a[7], 40), a[8] ? 1 : 0];
      n.enchères++;
    }
    tidyAuctions();
    if (isObj(b.history)) for (const day in b.history) {
      const v = b.history[day];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || db.history[day] || !Array.isArray(v)) continue;
      db.history[day] = [num(v[0]), num(v[1]), num(v[2]), num(v[3])];
      n.jours++;
    }
    if (isObj(b.friends)) for (const name of Object.keys(b.friends).slice(0, 10)) {
      const f = b.friends[name], cur = db.friends[name];
      if (!okKey(name) || !isObj(f) || (cur && cur.at >= num(f.at))) continue;
      if (!cur && Object.keys(db.friends).length >= 10) continue;
      const cards = {};
      if (isObj(f.cards)) for (const id of Object.keys(f.cards).slice(0, 20000)) {
        const c = f.cards[id];
        if (okKey(id) && Array.isArray(c)) cards[id] = [str(c[0], 200), rarOf(c[1]), Math.max(1, Math.min(999, Math.floor(num(c[2])) || 1))];
      }
      db.friends[name] = { at: num(f.at), cards, wish: cleanPairs(f.wish, 5000) };
    }
    if (num(b.wishAt) > db.wishAt) { db.wish = cleanPairs(b.wish, 5000); db.wishAt = num(b.wishAt); }
    if (num(b.collectionAt) > db.collectionAt && isObj(b.cards)) {
      const cards = {};
      for (const id of Object.keys(b.cards).slice(0, 20000)) {
        const c = b.cards[id];
        if (!okKey(id) || !isObj(c) || !okKey(c.cardId)) continue;
        cards[id] = {
          cardId: c.cardId, title: str(c.title || '?', 200), rarity: rarOf(c.rarity),
          atk: num(c.atk), def: num(c.def), q: num(c.q), views: num(c.views), cat: str(c.cat, 100), url: safeUrl(c.url),
          count: Math.max(1, Math.floor(num(c.count)) || 1), shiny: !!c.shiny, starred: !!c.starred,
          tags: (Array.isArray(c.tags) ? c.tags : []).slice(0, 30).map(t => str(t, 60)), obtained: str(c.obtained, 40)
        };
      }
      db.cards = cards;
      db.collectionAt = num(b.collectionAt);
    }
    if (!db.me && typeof b.me === 'string') db.me = b.me.slice(0, 40);
    mergeObserved(b.seen);
    if (isObj(b.trades)) for (const id of Object.keys(b.trades).slice(0, 2000)) {
      const t = b.trades[id];
      if (!okKey(id) || db.trades[id] || !isObj(t)) continue;
      db.trades[id] = { s: str(t.s, 20), t: str(t.t, 40), w: str(t.w || '?', 40), ini: t.ini ? 1 : 0,
        g: cleanCards(t.g), r: cleanCards(t.r), wg: num(t.wg), wr: num(t.wr) };
    }
    tidyTrades();
    saveDb();
    return n;
  }
  async function importBackup(file) {
    if (!file) return;
    try {
      if (file.size > 2e7) throw new Error('fichier trop gros');
      const n = mergeBackup(await file.text());
      setStatus('Sauvegarde fusionnée. Ajoutés : ' + n.prix + ' prix, ' + plural(n.boosters, 'booster', 'boosters') + ', ' +
        plural(n.enchères, 'enchère', 'enchères') + ', ' + plural(n.jours, 'jour d’historique', 'jours d’historique') +
        '. Rien de plus récent n’a été écrasé.', 'dataStatus');
    } catch (e) {
      setStatus('Import impossible : ' + e.message + '.', 'dataStatus');
    }
    refresh();
  }
  async function importFriend(file) {
    if (!file) return;
    try {
      if (file.size > 2e7) throw new Error('fichier trop gros');
      const f = parseFriend(await file.text());
      if (!db.friends[f.pseudo] && Object.values(db.friends).filter(x => x && x.src !== 'pool').length >= 10) throw new Error('10 amis au maximum, retire-en un');
      db.friends[f.pseudo] = { at: f.at, cards: f.cards, wish: f.wish };
      ui.friend = f.pseudo;
      const prices = mergeObserved(f.seen);
      // Rien n'a pu être enregistré : on revient à ce qui est rangé dans le navigateur, plutôt qu'à un import qui disparaîtrait au rechargement.
      if (!saveDb()) { db = loadDb(); resetPrices(); throw new Error('plus assez de place dans le navigateur'); }
      // Ses relevés Pro passent à part : s'ils ne tiennent pas, on revient à l'état enregistré juste avant (l'ami et ses prix observés, sans eux).
      let pro = mergePro(f.pro, f.pseudo), full = false;
      if (pro && !saveDb()) { db = loadDb(); resetPrices(); pro = 0; full = true; }
      const parts = [plural(Object.keys(f.cards).length, 'carte différente', 'cartes différentes')];
      if (prices) parts.push(plural(prices, 'prix observé ajouté', 'prix observés ajoutés'));
      if (pro) parts.push(plural(pro, 'relevé Pro ajouté', 'relevés Pro ajoutés'));
      setStatus('Collection de ' + f.pseudo + ' importée : ' + parts.slice(0, -1).join(', ') + (parts.length > 1 ? ' et ' : '') + parts[parts.length - 1] + '.' +
        (full ? ' Ses relevés Pro n’ont pas été gardés : plus assez de place dans le navigateur.' : ''), 'frStatus');
    } catch (e) {
      setStatus('Import impossible : ' + e.message + '.', 'frStatus');
    }
    refresh();
  }

  // ---------- interface ----------
  const TABS = [['home', 'Accueil'], ['col', 'Collection'], ['sell', 'À vendre'], ['sales', 'Mes ventes'], ['trades', 'Échanges'], ['wish', 'Souhaits'],
    ['pulls', 'Boosters'], ['trend', 'Évolution'], ['friends', 'Amis'], ['opts', 'Réglages'], ['data', 'Sauvegarde']];
  const ui = {
    open: false, tab: 'home', chosen: new Set(['L', 'UR', 'SR']),
    sortKey: 'total', sortDir: -1, text: '', rarity: '', friend: '', frRarity: '',
    wishRarity: '', wishAvail: false, wishOpen: new Set(), wishAll: false, tradeOpen: new Set(), metric: 0, sorts: {}, el: {}
  };
  const SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    for (const k of kids.flat(3)) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
    return e;
  }
  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const fmt = v => (v == null || Number.isNaN(v) ? '—' : nf.format(v));
  const fmtDate = t => (t ? new Date(t).toLocaleDateString('fr-FR') : '—');
  const ago = t => {
    const m = Math.round((Date.now() - t) / 6e4);
    return m < 1 ? 'à l’instant' : m < 60 ? 'il y a ' + m + ' min' : m < 1440 ? 'il y a ' + Math.round(m / 60) + ' h' : 'il y a ' + Math.round(m / 1440) + ' j';
  };

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') e.className = props[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
      else if (k in e) e[k] = props[k];
      else e.setAttribute(k, props[k]);
    }
    for (const k of kids.flat(5)) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
    return e;
  }

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    .fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#10b981;color:#04130d;border:0;
      border-radius:999px;padding:10px 16px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px #0008}
    .fab:hover{background:#34d399}
    .back{position:fixed;inset:0;z-index:2147483001;background:#000a;display:none}
    .back.open{display:block}
    .panel{position:absolute;inset:4vh 4vw;background:#0f1412;color:#e5e7eb;border:1px solid #26302c;border-radius:14px;
      display:flex;flex-direction:column;overflow:hidden;font-size:13px}
    header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #26302c}
    h1{font-size:17px;margin:0;flex:1;font-weight:700}
    h2{font-size:14px;margin:16px 0 8px;font-weight:700}
    .sub{color:#8b9a94;font-size:12px}
    .tabs{display:flex;gap:4px;padding:8px 14px 0;border-bottom:1px solid #26302c;flex-wrap:wrap}
    .tab{background:none;border:0;border-bottom:2px solid transparent;color:#8b9a94;padding:8px 12px;font-size:13px;font-weight:600;cursor:pointer}
    .tab:hover{color:#e5e7eb}
    .tab.on{color:#34d399;border-bottom-color:#34d399}
    .body{padding:14px 18px;overflow:auto;flex:1}
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
    .tile{background:#151c19;border:1px solid #26302c;border-radius:10px;padding:10px 12px}
    .tile b{display:block;font-size:20px;margin-top:2px;color:#34d399;font-variant-numeric:tabular-nums}
    .tile span{color:#8b9a94;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
    .tile small{display:block;color:#8b9a94;font-size:12px;margin-top:2px}
    .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
    button.b,a.b{background:#1c2622;color:#e5e7eb;border:1px solid #33413b;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer}
    a.b{display:inline-block;text-decoration:none;line-height:normal}
    button.b:hover:not(:disabled),a.b:hover{border-color:#34d399}
    button.b.pri,a.b.pri{background:#10b981;color:#04130d;border-color:#10b981;font-weight:700}
    button.b:disabled{opacity:.45;cursor:default}
    button.x{background:none;border:0;color:#8b9a94;font-size:22px;cursor:pointer;line-height:1}
    label.chk{display:inline-flex;gap:4px;align-items:center;color:#cbd5d1;cursor:pointer}
    input[type=text],input[type=number],select{background:#151c19;color:#e5e7eb;border:1px solid #33413b;border-radius:8px;padding:7px 10px;font-size:13px}
    input[type=text]{min-width:220px}
    input[type=number]{width:90px}
    input[type=file]{color:#8b9a94;font-size:12px}
    .status{color:#fbbf24;min-height:18px;margin-bottom:8px}
    .status:empty{min-height:0;margin:0}
    .tipbox{position:fixed;z-index:2147483647;display:none;max-width:340px;background:#1c2622;color:#e5e7eb;border:1px solid #3d4d46;
      border-radius:8px;padding:8px 10px;font-size:12.5px;line-height:1.45;box-shadow:0 6px 20px #000c;pointer-events:none;
      font-family:system-ui,-apple-system,"Segoe UI",sans-serif;white-space:normal;text-transform:none;letter-spacing:0;font-weight:400}
    .q{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;margin-left:5px;border-radius:50%;
      border:1px solid #4b5a54;color:#8b9a94;font-size:10px;font-weight:700;cursor:help;vertical-align:middle;text-transform:none;letter-spacing:0}
    .q:hover{border-color:#34d399;color:#34d399}
    [data-tip]{cursor:help}
    button[data-tip],label[data-tip],select[data-tip],input[data-tip]{cursor:pointer}
    .tools{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px;align-items:stretch}
    .grp{background:#121816;border:1px solid #232c28;border-radius:10px;padding:8px 10px 10px}
    .grp-t{color:#8b9a94;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;display:flex;align-items:center}
    .grp-b{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .run{display:flex;gap:10px;align-items:center;margin-bottom:10px;min-height:0}
    .run .status{margin:0;flex:1}
    details.fold{margin:4px 0 12px;border:1px solid #232c28;border-radius:10px;background:#121816}
    details.fold>summary{cursor:pointer;padding:8px 12px;color:#8b9a94;font-size:12.5px;user-select:none;list-style:none}
    details.fold>summary::before{content:"▸ ";color:#34d399}
    details.fold[open]>summary::before{content:"▾ "}
    details.fold>summary::-webkit-details-marker{display:none}
    .fold-b{padding:0 12px 10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .fold-b .note{margin:0;flex-basis:100%}
    .filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
    .home{grid-template-columns:repeat(auto-fill,minmax(360px,1fr))!important;align-items:start}
    .card li .grow.wrap{white-space:normal}
    .card h2 span{display:inline-flex;align-items:center}
    .warncard{border-color:#7c5a12;background:#1c180e}
    .barwrap{display:block;height:10px;background:#1c2622;border-radius:5px;overflow:hidden}
    .hbar{display:block;height:100%;border-radius:5px}
    .rar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;align-items:center}
    .pill{background:#151c19;border:1px solid #26302c;border-radius:999px;padding:4px 10px;font-variant-numeric:tabular-nums}
    .pill i{font-style:normal;color:#8b9a94}
    .scroll{overflow-x:auto}
    table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
    th,td{padding:6px 8px;border-bottom:1px solid #1f2925;text-align:right;white-space:nowrap}
    th:first-child,td:first-child{text-align:left;white-space:normal}
    td.l,th.l{text-align:left;white-space:normal}
    th{background:#0f1412;color:#8b9a94;font-weight:600}
    th.s{cursor:pointer;user-select:none}
    th.s:hover{color:#e5e7eb}
    tr.top td{background:#12241c}
    tr.click{cursor:pointer}
    tr.click:hover td{background:#183226}
    .caret{display:inline-block;width:16px;color:#34d399}
    tr.det>td{background:#0b100e;padding:6px 8px 10px 32px;text-align:left;white-space:normal}
    tr.det table{width:auto;max-width:100%}
    tr.det table td{border-bottom:0;padding:3px 22px 3px 0;text-align:left;color:#cbd5d1;white-space:normal;vertical-align:top;line-height:1.7}
    tr.det table td:first-child{white-space:nowrap}
    td a{color:#e5e7eb;text-decoration:none}
    td a:hover{color:#34d399}
    a.go{color:#34d399;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}
    a.go:hover{color:#6ee7b7}
    .card a:not(.go){color:inherit}
    .est{color:#8b9a94;font-style:italic}
    .r{display:inline-block;min-width:26px;text-align:center;border-radius:5px;padding:1px 5px;font-weight:700;font-size:11px;background:#33413b}
    .r-L{background:#fde047;color:#111}.r-UR{background:#fb923c;color:#111}.r-SR{background:#f472b6;color:#111}
    .r-R{background:#c4b5fd;color:#111}.r-PC{background:#7dd3fc;color:#111}.r-C{background:#4b5563}
    .adv{display:inline-block;border-radius:999px;padding:3px 9px;font-weight:700;font-size:12px;white-space:nowrap}
    .adv.sell{background:#10b981;color:#04130d}.adv.drop{background:#374151;color:#e5e7eb}.adv.unk{background:#1c2622;color:#8b9a94}
    .rel{white-space:nowrap;cursor:help}
    .rel::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:#6b7280}
    .rel.l2::before{background:#34d399}.rel.l1::before{background:#fbbf24}.rel.l0::before{background:#f87171}
    .tag.deal{border-color:#10b981;color:#34d399;font-weight:700}
    .tag.warn{border-color:#f59e0b;color:#fbbf24;font-weight:700}
    .tag.bad{border-color:#ef4444;color:#f87171;font-weight:700}
    .trade{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-bottom:8px}
    .trade ul{list-style:none;margin:0;padding:0}
    .trade li{display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid #1d2622}
    .trade li .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .trade .tot{display:flex;justify-content:space-between;margin-top:6px;font-weight:700}
    .balance{padding:8px 12px;border-radius:8px;background:#151c19;border:1px solid #26302c;margin-bottom:12px}
    .home{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
    .card{background:#151c19;border:1px solid #26302c;border-radius:10px;padding:12px 14px}
    .card h2{margin:0 0 8px;display:flex;justify-content:space-between;align-items:center}
    .card .more{background:none;border:0;color:#34d399;cursor:pointer;font-size:12px}
    .card ul{list-style:none;margin:0;padding:0}
    .card li{display:flex;gap:8px;align-items:center;padding:4px 0;border-top:1px solid #1f2925}
    .card li:first-child{border-top:0}
    .card li .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tag{display:inline-block;border:1px solid #33413b;border-radius:5px;padding:0 5px;font-size:11px;color:#8b9a94;margin-left:6px}
    .pull{position:fixed;right:18px;bottom:66px;z-index:2147483000;width:min(440px,calc(100vw - 36px));background:#0f1412;
      color:#e5e7eb;border:1px solid #26302c;border-radius:12px;box-shadow:0 8px 28px #000a;font-size:13px;display:none}
    .pull.open{display:block}
    .pull header{padding:9px 12px;border-bottom:0}
    .pull h1{font-size:14px}
    .pull .row{display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid #1f2925}
    .pull .t{flex:1;min-width:0}
    .pull .t b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
    .pull .t span{color:#8b9a94;font-size:12px}
    .empty{padding:30px;text-align:center;color:#8b9a94}
    .note{color:#8b9a94;font-size:12px;margin-top:10px}
    p.line{margin:4px 0;color:#cbd5d1}
    .chart{position:relative;background:#151c19;border:1px solid #26302c;border-radius:10px;padding:10px 6px 4px;margin-bottom:12px}
    .chart svg{display:block;width:100%;height:auto}
    .chart text{font-size:11px;fill:#8b9a94;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    .tip{position:absolute;top:6px;transform:translateX(-50%);background:#1c2622;border:1px solid #33413b;border-radius:6px;
      padding:4px 8px;font-size:12px;color:#e5e7eb;white-space:nowrap;pointer-events:none;display:none}
  `;

  const REL = ['Douteux', 'Moyen', 'Fiable'];
  const ARROW = { '1': ' ↑', '-1': ' ↓', '0': '' };
  function relCell(p) {
    if (!p || !p.n) return '—';
    const age = Number.isFinite(p.rel.age) ? 'dernière il y a ' + Math.round(p.rel.age) + ' j' : 'date inconnue';
    const title = p.n + ' vente' + (p.n > 1 ? 's' : '') + ', ' + age + ', écart ×' + fmt(p.rel.spread) +
      (p.trend ? (p.trend > 0 ? ', prix en hausse' : ', prix en baisse') : '') + (p.own ? ', d’après tes propres ventes et achats' : '') +
      (p.obs ? (p.exact ? ', d’après les prix finaux d’enchères relevés sur le marché'
        : ', d’après des fins d’enchères observées (en partie la dernière offre vue, donc un minimum : « Relever les prix finaux » les précise)') : '') +
      (p.by ? ', relevé partagé par ' + p.by : '') +
      (p.mixed ? ', aucune vente connue à cette rareté : prix d’autres raretés, à prendre avec prudence' : (p.r ? ', ventes en ' + p.r : ''));
    return h('span', { class: 'rel l' + p.rel.level, title }, REL[p.rel.level] + ARROW[p.trend]);
  }
  const rarBadge = r => h('span', { class: 'r r-' + r }, r);
  // Lien vers la page d'une enchère sur le site, ouverte dans un nouvel onglet pour garder la liste sous les yeux.
  // Sans identifiant d'enchère connu, on rend le contenu tel quel.
  const auctionLink = (id, kids, title) => (okKey(id)
    ? h('a', { class: 'go', href: '/marketplace/' + encodeURIComponent(id), target: '_blank', rel: 'noopener', title: (title ? title + ' · ' : '') + 'Ouvrir l’annonce' }, kids, ' ↗')
    : h('span', { title: title || '' }, kids));
  const TIP_VALUE = 'Médiane des 10 dernières ventes de la carte. En italique : aucune vente connue, la carte compte pour 1 ₩ (ce que rapporte la défausse).';
  const TIP_REL = 'Fiable : au moins 5 ventes, la dernière de moins de 30 jours. Moyen : au moins 2 ventes de moins de 90 jours. Douteux sinon. ' +
    'Des prix très dispersés font descendre d’un cran. La flèche dit si les ventes récentes montent ou baissent ; survole le mot pour le détail.';
  const estCell = (r, v) => h('span', { class: r.est ? 'est' : '' }, fmt(v));
  const pr = (r, k) => (r.price ? r.price[k] : undefined);
  const COLS = [
    { k: 'title', t: 'Carte', get: r => r.title.toLowerCase(),
      cell: r => [r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.title) : r.title,
        r.shiny ? ' ✨' : '', r.starred ? ' ★' : ''] },
    { k: 'rarity', t: 'Rareté', get: r => { const i = RARITIES.indexOf(r.rarity); return i < 0 ? 99 : i; }, cell: r => rarBadge(r.rarity) },
    { k: 'count', t: 'Ex.', get: r => r.count, cell: r => r.count },
    { k: 'atk', t: 'ATK', get: r => r.atk, cell: r => fmt(r.atk) },
    { k: 'def', t: 'DEF', get: r => r.def, cell: r => fmt(r.def) },
    { k: 'q', t: 'Q-Score', tip: 'Indice de qualité de l’article Wikipédia, donné par le site.', get: r => r.q, cell: r => fmt(r.q) },
    { k: 'views', t: 'Vues 30j', tip: 'Vues de l’article Wikipédia sur 30 jours. Plus il est lu, plus la carte est rare.', get: r => r.views, cell: r => fmt(r.views) },
    { k: 'value', t: 'Valeur', tip: TIP_VALUE, price: true, get: r => r.value, cell: r => estCell(r, r.value) },
    { k: 'rel', t: 'Fiabilité', tip: TIP_REL, price: true, get: r => (pr(r, 'n') ? r.price.rel.level : null), cell: r => relCell(r.price) },
    { k: 'last', t: 'Dernière', price: true, get: r => pr(r, 'last'), cell: r => fmt(pr(r, 'last')) },
    { k: 'min', t: 'Min', price: true, get: r => pr(r, 'min'), cell: r => fmt(pr(r, 'min')) },
    { k: 'max', t: 'Max', price: true, get: r => pr(r, 'max'), cell: r => fmt(pr(r, 'max')) },
    { k: 'n', t: 'Ventes', price: true, get: r => pr(r, 'n'), cell: r => (r.price ? r.price.n : '—') },
    { k: 'total', t: 'Total', price: true, get: r => r.total, cell: r => estCell(r, r.total) },
    { k: 'adv', t: 'Conseil', tip: 'Vendre si la valeur dépasse 1 ₩ (ce que rapporte la défausse), sinon défausser.', price: true, get: r => (pr(r, 'n') ? r.price.med : null),
      cell: r => { const a = advice(r.price); return r.price ? h('span', { class: 'adv ' + a.cls }, a.text) : '—'; } },
    { k: 'ask', t: 'En vente à', tip: 'Annonce la moins chère d’un autre joueur sur cette carte, en ce moment. Un point = une offre a déjà été faite ; entre parenthèses, le nombre d’annonces. Rempli par « Trouver les annonces ».', ask: true, get: r => (r.ask ? r.ask.a : null),
      cell: r => (r.ask ? auctionLink(r.ask.i, fmt(r.ask.a) + (r.ask.b ? ' •' : '') + (r.ask.list.length > 1 ? ' (' + r.ask.list.length + ')' : ''),
        (r.ask.list.length > 1 ? r.ask.list.length + ' annonces, de ' + fmt(r.ask.a) + ' à ' + fmt(r.ask.list[r.ask.list.length - 1].a) + ' ₩ ; la moins chère : ' : '') +
        (r.ask.b ? 'une offre a déjà été faite' : 'mise de départ, sans offre')) : '—') }
  ];

  function setStatus(msg, where) { const el = ui.el[where || 'status']; if (el) el.textContent = msg || ''; }
  // Le compte connecté et le nombre de comptes dont ce navigateur garde les données (onglet Réglages).
  // Où sont rangées les données, et combien de place elles prennent (onglet Sauvegarde).
  function storeLine() {
    const mo = (store.size() / 1e6).toFixed(1).replace('.', ',');
    return (store.mode === 'idb' ? 'Rangées dans IndexedDB : ' : 'Rangées dans le stockage du site (limité à 5 Mo) : ') + mo + ' Mo.';
  }
  function accountLine() {
    const n = store.keys().filter(k => k.startsWith(KEY + '.u.') && k !== acctKey('')).length;
    const who = db.me ? db.me : db.userId ? 'compte ' + db.userId.slice(0, 8) : 'pas encore reconnu (recharge la page du site)';
    return 'Compte connecté : ' + who + ' · ' + plural(Math.max(n, db.userId ? 1 : 0), 'compte connu', 'comptes connus') + ' dans ce navigateur.';
  }
  // État du pool, affiché dans Réglages.
  function poolLine() {
    const p = db.pool, now = Date.now();
    if (!p.on) return 'Désactivé.';
    if (!poolOn()) return 'Remplis l’adresse (https://…) et la clé, puis « Tester ».';
    const parts = [];
    if (p.err) parts.push('Dernière erreur : ' + p.err + (num(p.retryAt) > now ? ' (nouvel essai dans ' + Math.ceil((p.retryAt - now) / 6e4) + ' min)' : ''));
    parts.push(plural(num(p.sent), 'prix envoyé', 'prix envoyés') + ', ' + plural(num(p.recv), 'reçu', 'reçus') + (db.poolQ.length ? ', ' + fmt(db.poolQ.length) + ' en attente' : ''));
    if (p.pushAt) parts.push('dernier envoi ' + ago(p.pushAt));
    return parts.join(' · ') + '.';
  }
  const poolUi = { testing: false };
  async function poolTest() {
    const el = ui.el.poolInfo;
    const say = t => { if (el) el.textContent = t; };
    if (!poolUrlOk(db.pool.url || '') || !db.pool.key) return say('Remplis d’abord l’adresse (https://…) et la clé.');
    poolUi.testing = true;
    say('Test en cours…');
    try {
      const s = await poolFetch('/v1/stats');
      say('Connecté : ' + plural(num(s.sales), 'vente', 'ventes') + ', ' + plural(num(s.cards), 'carte', 'cartes') + ', ' + plural(num(s.members), 'membre', 'membres') + '.');
      db.pool.err = '';
      saveDb();
      if (poolOn()) poolPullMine(true);
    } catch (e) {
      say('Échec : ' + ((e && e.message) || 'pool injoignable') + '. Vérifie l’adresse et la clé.');
    }
    setTimeout(() => { poolUi.testing = false; }, 8000);
  }
  function syncButtons() {
    const e = ui.el;
    if (e.poolInfo && !poolUi.testing) e.poolInfo.textContent = poolLine();
    if (e.acctInfo) e.acctInfo.textContent = accountLine();
    if (e.storeInfo) e.storeInfo.textContent = storeLine();
    for (const el of [e.autoInfo, e.autoInfo2]) if (el) el.textContent = autoLine();
    for (const b of [e.updAll, e.updAll2]) if (b) b.disabled = job.running;
    if (!e.load) return;
    const pro = proState();
    e.load.disabled = e.scan.disabled = e.mine.disabled = e.mine2.disabled = e.wishLoad.disabled = e.tradeLoad.disabled = job.running;
    const wp = wishPricesToFetch().length;
    e.wishPrices.disabled = job.running || pro !== true || !wp;
    e.wishPrices.textContent = 'Relever les valeurs (' + wp + ')';
    const sc = db.collectionAt ? sellCompToSearch().length : 0;
    e.sellComp.disabled = job.running || !sc;
    e.sellComp.textContent = 'Trouver la concurrence (' + sc + ')';
    const pending = alertsToCheck().length;
    e.wishCheck.disabled = job.running || !pending;
    e.wishCheck.textContent = 'Vérifier les alertes (' + pending + ')';
    const live = wishLive().length;
    const cLive = colLive().length, cSearch = colToSearch().length;
    e.colRefresh.disabled = job.running || !cLive;
    e.colRefresh.textContent = 'Rafraîchir les annonces (' + cLive + ')';
    e.colSearch.disabled = job.running || !cSearch;
    e.colSearch.textContent = 'Trouver les annonces (' + cSearch + ')';
    e.wishRefresh.disabled = job.running || !live;
    e.wishRefresh.textContent = 'Rafraîchir les annonces (' + live + ')';
    e.stop3.disabled = !job.running;
    if (job.running) e.tradeFill.disabled = true;
    const toSearch = wishToSearch().length;
    e.wishSearch.disabled = job.running || !toSearch;
    e.wishSearch.textContent = 'Trouver les annonces (' + toSearch + ')';
    e.stop2.disabled = !job.running;
    e.stop4.disabled = !job.running;
    // Le bouton Stop n'apparaît que pendant un traitement.
    for (const s of [e.stop, e.stop2, e.stop3, e.stop4]) if (s) s.style.display = job.running ? '' : 'none';
    e.fill.disabled = job.running || pro !== true;
    e.stop.disabled = !job.running;
    e.fill.textContent = pro === true ? 'Relever les prix (' + missingIds().length + ')' : 'Relever les prix (Pro)';
    const nf = finalsToFetch().length;
    e.finals.textContent = 'Relever les prix finaux' + (nf ? ' (' + nf + ')' : '');
    e.finals.disabled = job.running || !nf;
    e.pro.textContent = pro === true ? ''
      : pro === false
        ? 'Compte non Pro : le site ne donne pas l’historique des ventes. Pour avoir des prix quand même : « Relever les fins d’enchères », ' +
          'puis quelques minutes plus tard « Relever les prix finaux », qui lit le prix exact de chaque enchère terminée. ' +
          'S’y ajoutent tes propres ventes et achats, et les prix que tes amis partagent, y compris leur historique Pro. Refais-le de temps en temps : les prix s’accumulent.'
        : 'Statut Pro pas encore détecté : recharge la page (F5).';
  }

  function mount() {
    if (ui.el.host) return;
    const host = h('div', { id: 'wm-stats-host' });
    const root = host.attachShadow({ mode: 'open' });
    const e = ui.el;
    e.host = host;
    for (const k of ['status', 'sellStatus', 'frStatus', 'salesStatus', 'wishStatus', 'dataStatus']) e[k] = h('div', { class: 'status' });
    for (const k of ['tiles', 'pullTiles', 'salesTiles', 'wishTiles']) e[k] = h('div', { class: 'tiles' });
    for (const k of ['rar', 'market']) e[k] = h('div', { class: 'rar' });
    for (const k of ['table', 'sellTable', 'pullBody', 'frBody', 'salesBody', 'wishBody', 'trendBody']) e[k] = h('div', { class: 'scroll' });
    // ----- boutons : un libellé court, et une bulle qui dit exactement ce que fait chacun -----
    const btn = (label, tip, onclick, cls) => h('button', { class: 'b' + (cls ? ' ' + cls : ''), 'data-tip': tip, onclick }, label);
    const stopBtn = () => btn('Stop', 'Arrête le traitement en cours. Ce qui a déjà été relevé est gardé.', () => { job.stop = true; });
    const chk = (label, tip, checked, onchange) => h('label', { class: 'chk', 'data-tip': tip },
      h('input', { type: 'checkbox', checked: !!checked, onchange }), label);

    const UPD_TIP = 'Fait tout de suite, et sans limite, ce que fait la mise à jour automatique : collection et liste de souhaits si elles ont plus d’un jour, ' +
      'souhaits signalés en vente, prix à relire, prix finaux. Une requête par seconde ; Stop l’arrête.';
    e.load = btn('Recharger ma collection',
      'Relit toute ta collection sur le site (une dizaine de requêtes). Retire aussi les cartes vendues, données ou défaussées depuis la dernière fois.',
      loadCollection, 'pri');
    e.fill = btn('Relever les prix',
      'Compte Pro. Lit l’historique des 10 dernières ventes de chaque carte des raretés cochées qui n’a pas de prix récent (moins de 24 h). ' +
      'C’est ce qui remplit la colonne « Valeur ». Une carte par seconde.', fillPrices);
    e.colSearch = btn('Trouver les annonces',
      'Cherche sur le marché qui vend en ce moment tes cartes des raretés cochées, et à quel prix. Remplit la colonne « En vente à ». ' +
      'Saute les cartes cherchées il y a moins d’une heure. Le plus complet, mais le plus long.', searchCol);
    e.colRefresh = btn('Rafraîchir les annonces',
      'Ne relit que les cartes qui ont déjà une annonce connue, pour mettre à jour leur prix et leur fin. Plus rapide que « Trouver les annonces ».', refreshCol);
    e.scan = btn('Relever les fins d’enchères',
      'Lit les 500 enchères du marché qui se terminent bientôt, toutes cartes confondues (pas seulement les tiennes), ' +
      'plus 150 de chaque rareté L, UR et SR, qui sinon se perdent dans la masse. ' +
      'À leur fin, leur dernière offre devient un « prix observé » : utile sans compte Pro, et pour le niveau de prix par rareté.',
      () => scanMarket(MARKET_PAGES, 'status', 'ending_soon', RARE_PAGES));
    e.finals = btn('Relever les prix finaux',
      'Pour tous les comptes, Pro ou non. Relit la page de chaque enchère suivie qui vient de finir, celle qu’on ouvre en cliquant sur une annonce : ' +
      'elle donne le prix final exact, qui remplace la dernière offre vue. Une enchère par seconde. ' +
      'À faire quelques minutes après « Relever les fins d’enchères ».', () => fetchFinals('status'));
    e.stop = stopBtn();

    e.mine = btn('Mes places de vente',
      'Relit tes ventes en cours sur le marché : combien de places il te reste, et quelles cartes sont déjà en vente (elles sont retirées de la liste).',
      () => scanMarket(1, 'sellStatus'));
    e.sellComp = btn('Trouver la concurrence',
      'Cherche sur le marché les annonces d’autres joueurs pour les cartes de cette liste. Remplit la colonne « Concurrence ». ' +
      'Saute les cartes cherchées il y a moins d’une heure.',
      () => { if (job.running) return; const t = sellCompToSearch(); if (!t.length) return setStatus('Concurrence déjà relevée il y a moins d’une heure.', 'sellStatus');
        marketSearch(t, 'Concurrence', 'sans concurrent', 'sellStatus'); });
    e.stop4 = stopBtn();

    e.mine2 = btn('Recharger mes enchères',
      'Relit tes enchères récentes sur la page Marché (ventes, invendus, achats). Le site n’en donne que les plus récentes : le script les accumule à chaque passage.',
      () => scanMarket(1, 'salesStatus'));

    e.wishLoad = btn('Recharger ma liste',
      'Relit ta liste de souhaits sur le site : les cartes pour lesquelles tu as demandé une alerte dans « Toutes les cartes ».', loadWish, 'pri');
    e.wishSearch = btn('Trouver les annonces',
      'Cherche sur le marché TOUTES les cartes de ta liste, une par seconde, en commençant par celles jamais cherchées. ' +
      'Le plus complet, mais le plus long. Saute les cartes cherchées il y a moins d’une heure.', searchWish);
    e.wishCheck = btn('Vérifier les alertes',
      'Ne cherche que les cartes dont le site t’a signalé la mise en vente ces 12 dernières heures. Rapide, et suffisant au quotidien.', checkAlerts);
    e.wishRefresh = btn('Rafraîchir les annonces',
      'Relit seulement les annonces déjà trouvées, pour voir si le prix a monté ou si l’enchère est finie. À faire juste avant d’enchérir.', refreshWish);
    e.wishPrices = btn('Relever les valeurs',
      'Compte Pro. Lit la valeur médiane des souhaits actuellement en vente : c’est elle qui permet de repérer les bonnes affaires.',
      () => fetchPricesFor(wishPricesToFetch(), 'wishStatus', 'souhait en vente', 'souhaits en vente'));
    e.wishFold = btn('Tout déplier', 'Ouvre ou ferme le détail de toutes les cartes qui ont plusieurs annonces.',
      () => { ui.wishAll = !ui.wishAll; ui.wishOpen.clear(); renderWish(); });
    e.stop2 = stopBtn();

    e.tradeLoad = btn('Recharger mes échanges', 'Relit tes échanges sur la page Échanges du site (une seule requête).', loadTrades, 'pri');
    e.tradeFill = btn('Relever les prix',
      'Compte Pro. Lit la valeur des cartes passées dans tes échanges. Celles que tu as données ne sont plus dans ta collection : ' +
      'l’onglet Collection ne relève jamais leur prix.', fillTradePrices);
    e.stop3 = stopBtn();

    e.sub = h('div', { class: 'sub' });
    e.pro = h('div', { class: 'sub', style: 'margin-bottom:10px' });
    e.sellInfo = h('div', { class: 'sub', style: 'margin-bottom:10px' });
    const checks = RARITIES.map(r => h('label', { class: 'chk' },
      h('input', {
        type: 'checkbox', checked: ui.chosen.has(r),
        onchange: ev => { ev.target.checked ? ui.chosen.add(r) : ui.chosen.delete(r); syncButtons(); }
      }), r));
    const rarSelect = onchange => h('select', { onchange, 'data-tip': 'N’affiche que les cartes de cette rareté.' },
      h('option', { value: '' }, 'Toutes les raretés'), RARITIES.map(r => h('option', { value: r }, r)));
    const sellOpt = (key, label, tip) => chk(label, tip, db.sell[key], ev => { db.sell[key] = ev.target.checked; saveDb(); refresh(); });

    // ----- Collection -----
    e.view_col = h('div', null,
      e.tiles, e.rar, e.market, e.pro,
      h('div', { class: 'tools' },
        group('Ma collection', null, e.load, e.fill),
        group('Annonces du marché sur mes cartes', null, e.colSearch, e.colRefresh),
        group('Prix observés', 'Pour tous, avec ou sans compte Pro. 1. « Relever les fins d’enchères » suit les enchères sur le point de finir. ' +
          '2. Quelques minutes plus tard, « Relever les prix finaux » lit le prix exact de chacune.', e.scan, e.finals),
        group('Raretés concernées', '« Relever les prix » et « Trouver les annonces » ne traitent que les raretés cochées ici.', checks),
        group('Étiquetage par lots', 'Ajoute une de tes étiquettes à un lot de cartes choisi par une règle. Rien ne part sans ton clic (deux fois), ' +
          'et le script ne fait qu’ajouter : il ne crée, ne retire et ne supprime aucune étiquette. Le lot part en une seule requête, ' +
          'comme quand tu étiquettes plusieurs cartes en mode « Sélectionner » sur le site. 200 cartes au plus par lot.',
          (e.tagRule = h('select', { 'data-tip': 'Quelles cartes étiqueter.', onchange: ev => { ui.tagRule = ev.target.value; renderTagBatch(); } },
            TAG_RULES.map(([v, l]) => h('option', { value: v }, l)))),
          (e.tagRar = h('select', { 'data-tip': 'La rareté à étiqueter.', onchange: ev => { ui.tagRar = ev.target.value; renderTagBatch(); } },
            RARITIES.map(r => h('option', { value: r }, r)))),
          (e.tagMin = h('input', { type: 'number', min: 0, value: 100, style: 'width:80px', 'data-tip': 'Valeur médiane minimale, en wikibidous.',
            oninput: ev => { ui.tagMin = Number(ev.target.value) || 0; renderTagBatch(); } })),
          (e.tagSel = h('select', { 'data-tip': 'L’étiquette à ajouter, parmi les tiennes.', onchange: ev => { ui.tagId = ev.target.value; renderTagBatch(); } })),
          (e.tagApply = btn('Appliquer ce lot', 'Premier clic : demande confirmation. Second clic (dans les 5 s) : ajoute l’étiquette aux cartes du lot.', onTagApply)),
          (e.tagInfo = h('span', { class: 'sub' })))),
      h('div', { class: 'run' }, e.status, e.stop),
      h('div', { class: 'filters' },
        h('input', { type: 'text', placeholder: 'Filtrer par titre, catégorie, étiquette…', 'data-tip': 'Ne garde que les cartes dont le titre, la catégorie ou une étiquette contient ce texte.',
          oninput: ev => { ui.text = ev.target.value.toLowerCase(); renderTable(); } }),
        rarSelect(ev => { ui.rarity = ev.target.value; renderTable(); })),
      fold('Export',
        h('div', { class: 'sub' }, 'Les pastilles sur les cartes du site et les autres options se règlent dans l’onglet Réglages.'),
        btn('Exporter en CSV', 'Télécharge le tableau tel qu’il est filtré et trié, à ouvrir dans Excel ou LibreOffice.', exportCsv),
        btn('Oublier les prix', 'Efface tous les prix relevés (pas ta collection). Utile seulement pour tout relever de zéro.', clearPrices)),
      e.table,
      fold('Comment lire ce tableau ?', h('div', { class: 'note' },
        'Valeur = médiane des 10 dernières ventes (moins sensible qu’une moyenne aux enchères qui s’emballent). ',
        'En italique : carte sans vente connue, comptée à 1 wikibidou, ce que rapporte la défausse. ',
        'Fiabilité = assez de ventes, assez récentes, pas trop dispersées ; survole-la pour le détail. ',
        'Les prix se remplissent aussi tout seuls quand tu ouvres l’onglet Marché d’une carte sur le site.')));

    e.homeBody = h('div', { class: 'home' });
    e.homeTiles = h('div', { class: 'tiles' });
    e.view_home = h('div', null,
      h('div', { class: 'tools' }, (e.updAll = btn('Tout mettre à jour maintenant', UPD_TIP, updateAll, 'pri')), (e.autoInfo = h('span', { class: 'sub' }, autoLine()))),
      e.homeTiles, e.homeBody);

    // ----- À vendre -----
    e.view_sell = h('div', null,
      h('div', { class: 'tools' },
        group('Réglages de la liste', null,
          h('label', { class: 'chk', 'data-tip': 'Une carte n’est proposée que si sa valeur atteint ce montant.' }, 'Valeur minimale',
            h('input', { type: 'number', min: 2, step: 1, value: db.sell.min, style: 'margin-left:6px',
              onchange: ev => { db.sell.min = Math.max(2, Math.floor(Number(ev.target.value) || 2)); ev.target.value = db.sell.min; saveDb(); refresh(); } }), ' ₩'),
          sellOpt('favs', 'Mes favoris ★', 'Inclut les cartes que tu as mises en favori sur le site. Décochée, elles sont protégées de la liste.'),
          sellOpt('doubt', 'Prix douteux', 'Inclut les cartes dont le prix est peu sûr : moins de 2 ventes, ventes de plus de 90 jours, ou prix très dispersés.'),
          sellOpt('dupFirst', 'Doublons d’abord', 'Fait passer devant les cartes que tu as en plusieurs exemplaires. Décochée, les plus chères passent d’abord.')),
        group('Mettre à jour', null, e.mine, e.sellComp)),
      e.sellInfo,
      h('div', { class: 'run' }, e.sellStatus, e.stop4),
      e.sellTable,
      fold('Comment lire cette liste ?', h('div', { class: 'note' },
        'Les cartes déjà mises en vente sont retirées. Les lignes surlignées tiennent dans tes places de vente libres. ',
        '« Concurrence » montre l’annonce la moins chère d’un autre joueur sur la même carte. Le prix conseillé reste la médiane des ventes : ' +
        'une mise de départ n’est pas un prix final. Une étiquette signale seulement un concurrent qui a déjà une offre sous la médiane. ',
        'Un clic sur le nom d’une carte ouvre son formulaire de mise en vente sur le site. Le script ne met rien en vente : c’est toi qui valides.')));

    // ----- Boosters -----
    e.view_pulls = h('div', null, e.pullTiles, e.pullBody,
      fold('Options',
        btn('Effacer l’historique des boosters', 'Oublie tous les boosters enregistrés. Irréversible, sauf si tu as une sauvegarde.',
          () => { db.pulls = []; saveDb(); refresh(); }),
        h('div', { class: 'note' },
          'Seuls les boosters ouverts depuis l’installation de la version 1.3 sont comptés. ',
          'La valeur utilise les prix connus aujourd’hui ; une carte sans vente connue compte pour 1.')));

    // ----- Amis -----
    e.frSelect = h('select', { onchange: ev => { ui.friend = ev.target.value; renderFriends(); }, 'data-tip': 'L’ami dont tu veux comparer la collection avec la tienne.' });
    e.view_friends = h('div', null,
      h('div', { class: 'tools' },
        group('Partager ma collection', 'Le fichier contient tes cartes, leur nombre d’exemplaires, ta liste de souhaits et tous les prix que tu as accumulés : ' +
          'ton historique Pro, les prix observés, tes ventes et achats. Chez ton ami, ils s’ajoutent à ses prix.',
          h('input', { type: 'text', value: db.me || '', style: 'min-width:140px', placeholder: 'ton pseudo', 'data-tip': 'Le nom sous lequel tes amis verront ta collection.',
            oninput: ev => { db.me = ev.target.value.slice(0, 40); saveDb(); } }),
          btn('Exporter pour mes amis', 'Télécharge un fichier à envoyer à tes amis.', exportMine, 'pri')),
        group('Ajouter un ami', 'Ses cartes et ses souhaits servent à la comparaison. Ses prix (historique Pro, prix observés, ventes et achats) ' +
          's’ajoutent aux tiens et remplissent tes tableaux : pour chaque carte, le relevé le plus récent est gardé.',
          h('input', { type: 'file', accept: '.json,application/json', 'data-tip': 'Choisis le fichier que ton ami t’a envoyé.',
            onchange: ev => { importFriend(ev.target.files[0]); ev.target.value = ''; } })),
        group('Comparer', null, e.frSelect,
          rarSelect(ev => { ui.frRarity = ev.target.value; renderFriends(); }),
          chk('Cartes en un seul exemplaire', 'Décochée, l’échange proposé ne contient que des doublons : personne ne perd une carte. Cochée, il peut aussi contenir des cartes que l’un de vous n’a qu’en un exemplaire.',
            !!ui.frSingles, ev => { ui.frSingles = ev.target.checked; renderFriends(); }),
          (e.frRemove = btn('Retirer cet ami', 'Oublie le fichier de cet ami.', () => {
            if (ui.friend && !(db.friends[ui.friend] && db.friends[ui.friend].src === 'pool')) { delete db.friends[ui.friend]; ui.friend = ''; saveDb(); refresh(); }
          })))),
      e.frStatus, e.frBody);

    // ----- Mes ventes -----
    e.view_sales = h('div', null,
      h('div', { class: 'tools' }, group('Mettre à jour', null, e.mine2)),
      e.salesStatus, (e.sellingBody = h('div')), e.salesTiles, e.salesBody,
      fold('Comment lire ce bilan ?', h('div', { class: 'note' },
        'Le site ne donne que tes enchères les plus récentes. Le script les garde en mémoire à chaque passage sur la page Marché, donc le bilan s’allonge avec le temps. ',
        'La comparaison à la valeur médiane est indicative : cette médiane inclut ta propre vente.')));

    // ----- Échanges -----
    e.tradeStatus = h('div', { class: 'status' });
    e.tradeTiles = h('div', { class: 'tiles' });
    e.tradeBody = h('div', { class: 'scroll' });
    e.view_trades = h('div', null,
      h('div', { class: 'tools' }, group('Mettre à jour', null, e.tradeLoad, e.tradeFill)),
      h('div', { class: 'run' }, e.tradeStatus, e.stop3),
      e.tradeTiles, e.tradeBody,
      fold('Comment lire ce bilan ?', h('div', { class: 'note' },
        'Les valeurs sont celles d’aujourd’hui, pas celles du jour de l’échange. Une carte sans prix connu n’est pas comptée : ' +
        'elle apparaît comme « + 1 ? » et rend le bilan incomplet. Clique sur un échange pour voir les cartes.')));

    // ----- Souhaits -----
    e.view_wish = h('div', null,
      h('div', { class: 'tools' },
        group('Ma liste', null, e.wishLoad),
        group('Trouver les annonces', 'Trois façons de chercher les annonces de tes souhaits, de la plus complète à la plus rapide. Survole chaque bouton.',
          e.wishSearch, e.wishCheck, e.wishRefresh),
        group('Bonnes affaires', 'Une bonne affaire est une annonce au moins 30 % sous la valeur médiane de la carte. Il faut donc connaître cette valeur.',
          e.wishPrices)),
      h('div', { class: 'run' }, e.wishStatus, e.stop2),
      (e.bidBody = h('div')),
      h('div', { class: 'filters' },
        rarSelect(ev => { ui.wishRarity = ev.target.value; syncButtons(); renderWish(); }),
        chk('Disponibles maintenant', 'Ne garde que les cartes en vente, signalées par le site, ou possédées par un ami.', false,
          ev => { ui.wishAvail = ev.target.checked; renderWish(); }),
        chk('Bonnes affaires seulement', 'Ne garde que les annonces au moins 30 % sous la valeur médiane.', false,
          ev => { ui.wishDeals = ev.target.checked; renderWish(); }),
        chk('Cacher mes cartes', 'Cache les souhaits que tu possèdes déjà, d’après ta collection chargée. Ils sont aussi exclus des recherches.',
          db.wishHideOwned, ev => { db.wishHideOwned = ev.target.checked; saveDb(); syncButtons(); renderWish(); }),
        e.wishFold),
      e.wishTiles, e.wishBody,
      fold('Comment ça marche ?', h('div', { class: 'note' },
        'Ta liste de souhaits est celle du site. Le script retient aussi les alertes de mise en vente que le site t’envoie. ',
        'Une carte cherchée depuis moins d’une heure est sautée. Si le site demande de ralentir, le script fait une pause puis reprend seul. ',
        'Clique sur une ligne qui a plusieurs annonces pour les voir toutes. « Chez un ami » vient des fichiers importés dans l’onglet Amis.')));

    // ----- Évolution -----
    e.view_trend = h('div', null,
      h('div', { class: 'filters' },
        h('select', { onchange: ev => { ui.metric = Number(ev.target.value); renderTrend(); }, 'data-tip': 'Ce que montre la courbe.' },
          h('option', { value: 0 }, 'Valeur totale'), h('option', { value: 1 }, 'Nombre de cartes'),
          h('option', { value: 3 }, 'Cartes déjà vendues aux enchères'))),
      e.trendBody,
      h('div', { class: 'note' },
        'Une photo est prise chaque jour où ta collection est chargée ou consultée sur le site. Les jours sans visite n’ont pas de point.'));

    // ----- Réglages -----
    const ovChk = (k, label, tip) => chk(label, tip, ov(k), ev => { db.ov[k] = ev.target.checked; saveDb(); overlaySoon(); });
    e.view_opts = h('div', null,
      h('p', { class: 'line' }, 'Ce que le script ajoute aux pages du site. Tout reste en lecture seule : il affiche, il ne clique sur rien.'),
      h('div', { class: 'tools' },
        group('Pastilles sur les cartes', 'Une petite étiquette sur chaque carte affichée par le site : Collection, Marché, Toutes les cartes, boosters, échanges.',
          chk('Afficher la valeur', 'Valeur médiane de la carte. Le contour donne la fiabilité : vert fiable, orange moyen, gris douteux.',
            db.overlay !== false, ev => { db.overlay = ev.target.checked; saveDb(); overlaySoon(); }),
          ovChk('cmp', 'Comparer au prix de l’annonce', 'Sur le Marché : « −40 % » pour une bonne affaire, « trop cher » quand l’annonce atteint déjà la valeur.'),
          ovChk('outbid', 'Conseil quand je suis surenchéri', 'Dans Mes enchères : « ↑ jusqu’à X ₩ » si tu peux encore remonter sans dépasser la valeur, « laisse filer » sinon.'),
          ovChk('have', 'Marquer les cartes que j’ai déjà (✓)', 'Ajoute ✓ aux cartes présentes dans ta collection chargée.'),
          ovChk('tip', 'Bulle détaillée au survol', 'Une bulle immédiate avec le détail et une petite courbe des dernières ventes. Décochée : la bulle simple du navigateur, plus lente à apparaître.')),
        group('Sur le Marché', null,
          ovChk('glow', 'Faire ressortir les bonnes affaires', 'Entoure de vert les annonces au moins 30 % sous la valeur.'),
          ovChk('dim', 'Griser les annonces trop chères', 'Rend pâles les annonces qui atteignent déjà la valeur de la carte. Elles redeviennent normales au survol. Tes propres enchères ne sont jamais grisées.')),
        group('Échanges', null,
          ovChk('trade', 'Valeur des échanges sur la page Échanges', 'Sous chaque échange, et en haut de la fenêtre « Échanger avec… » pendant que tu choisis les cartes : valeur donnée, valeur reçue, écart.')),
        group('Relevés automatiques (compte Pro)', 'Ces relevés se font tout seuls, une carte à la fois, et jamais deux fois la même carte en 24 h.',
          chk('Prix des cartes tirées après chaque booster', 'Après chaque paquet que tu ouvres toi-même, un petit panneau donne la valeur de chaque carte tirée.',
            db.autoPull !== false, ev => { db.autoPull = ev.target.checked; saveDb(); }),
          ovChk('bidAuto', 'Prix des cartes de Mes enchères', 'Quand le site affiche l’onglet Mes enchères, relève le prix des cartes où tu enchéris qui n’en ont pas de récent.')),
        group('Mise à jour automatique (tous comptes)', 'Garde à jour la valeur de ta collection et les prix de tes souhaits, sans cliquer bouton après bouton. ' +
          'Sans compte Pro, les prix viennent du pool et des fins d’enchères.',
          ovChk('autoObs', 'Mise à jour automatique',
            'Toutes les 30 min, tant qu’un onglet du site est ouvert (même en arrière-plan) : relit ta collection et ta liste de souhaits une fois par jour, ' +
            'vérifie les souhaits que le site signale en vente, puis relit les prix à refaire en commençant par ceux qui pèsent le plus dans ta valeur ' +
            '(chaque jour pour les cartes de plus de 50 ₩, les L et les UR ; tous les 2 jours les SR, 4 jours les R, 7 jours les C et PC), et enfin les prix finaux. ' +
            '60 requêtes au plus par passage, un seul onglet à la fois. Elle s’arrête dès que tu lances un relevé toi-même, et se met en pause 24 h si le site signale trop d’automatisation.'),
          (e.updAll2 = btn('Tout mettre à jour maintenant', UPD_TIP, updateAll)),
          (e.autoInfo2 = h('span', { class: 'sub' }, autoLine()))),
        group('Compte', 'Chaque compte WikiMasters utilisé dans ce navigateur a ses propres données : collection, ventes et achats, échanges, boosters, évolution, souhaits, amis. ' +
          'Les prix du marché sont communs à tous les comptes. Le script reconnaît tout seul le compte connecté.',
          (e.acctInfo = h('span', { class: 'sub' }, accountLine())),
          btn('Effacer les données de ce compte', 'Vide la collection, les ventes, les échanges, les boosters, l’évolution, les souhaits et les amis du compte connecté. ' +
            'Les prix restent. Un second clic dans les 5 secondes confirme.', ev => {
            const b = ev.currentTarget, idle = 'Effacer les données de ce compte';
            if (b.dataset.armed) {
              delete b.dataset.armed;
              clearAccount();
              b.textContent = 'Effacé ✓';
              setTimeout(() => { b.textContent = idle; }, 3000);
              return;
            }
            b.dataset.armed = '1';
            b.textContent = 'Confirmer l’effacement ?';
            setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.textContent = idle; } }, 5000);
          })),
        group('Pool partagé du groupe (tous comptes)', 'Une base commune, hébergée par un membre du groupe : chaque prix relevé par l’un sert à tous, Pro et non-Pro mélangés. ' +
          'Seuls des prix partent, jamais ta collection ni la clé. Désactivé par défaut. Pour l’héberger : server/README.md dans le dépôt du script.',
          h('input', { type: 'text', value: db.pool.url || '', placeholder: 'https://pool.exemple.fr', style: 'min-width:200px',
            'data-tip': 'L’adresse du pool, donnée par la personne qui l’héberge.',
            oninput: ev => { db.pool.url = ev.target.value.trim().slice(0, 200); saveDb(); syncButtons(); } }),
          h('input', { type: 'password', value: db.pool.key || '', placeholder: 'clé du groupe', style: 'min-width:150px', autocomplete: 'off',
            'data-tip': 'La clé du groupe. Ne la donne qu’aux membres.',
            oninput: ev => { db.pool.key = ev.target.value.trim().slice(0, 200); saveDb(); syncButtons(); } }),
          btn('Tester', 'Vérifie l’adresse et la clé, et affiche ce que contient le pool.', poolTest),
          chk('Partager ma collection et mes souhaits avec le groupe', 'Seulement ta collection et ta liste de souhaits, rien d’autre de ton compte. ' +
            'Tous les membres qui ont la clé les voient dans leur onglet Amis, et tu vois ceux qui partagent. Il faut un pseudo (onglet Amis). Décocher retire ton profil du pool.',
            !!db.pool.share, ev => { const el = ev.target; setProfileShare(el.checked).then(() => { el.checked = !!db.pool.share; }); }),
          chk('Partager et recevoir les prix', 'Envoie les prix que tu relèves, y compris ceux déjà accumulés, et reçoit ceux du groupe pour ta collection, tes souhaits et les cartes affichées.',
            !!db.pool.on, ev => { db.pool.on = ev.target.checked; if (poolOn()) { poolBackfill(); poolPullMine(true); } saveDb(); syncButtons(); }),
          (e.poolInfo = h('span', { class: 'sub' }, poolLine()))),
        group('Mise à jour', 'Tampermonkey met le script à jour tout seul, une fois par jour. Ces boutons servent à ne pas attendre.',
          h('span', { class: 'sub' }, 'Version installée : ' + VERSION),
          btn('Vérifier', 'Compare ta version à la dernière publiée sur GitHub.', () => checkUpdate(true)),
          h('a', { class: 'b pri', href: SCRIPT_URL, target: '_blank', rel: 'noopener',
            'data-tip': 'Ouvre la dernière version : Tampermonkey affiche sa page de mise à jour, il reste à cliquer sur « Mettre à jour ». Recharge ensuite la page du site.' },
          'Installer la dernière version ↗'),
          (e.updInfo = h('span', { class: 'sub' })))));

    // ----- Sauvegarde -----
    e.view_data = h('div', null,
      h('p', { class: 'line' }, 'Tes données sont rangées dans ce navigateur. Chrome et Zen ont donc chacun les leurs.'),
      (e.storeInfo = h('p', { class: 'line' }, storeLine())),
      h('div', { class: 'tools' },
        group('Exporter', null, btn('Exporter toutes mes données',
          'Télécharge un fichier avec ta collection, les prix, tes boosters, tes enchères, l’évolution, tes souhaits et les fichiers de tes amis.', exportBackup, 'pri')),
        group('Importer', 'L’import fusionne : il ajoute ce qui manque et ne remplace un prix ou une collection que par plus récent.',
          h('input', { type: 'file', accept: '.json,application/json', 'data-tip': 'Choisis un fichier de sauvegarde exporté depuis un autre navigateur.',
            onchange: ev => { importBackup(ev.target.files[0]); ev.target.value = ''; } }))),
      e.dataStatus,
      h('div', { class: 'note' }, 'Garde ce fichier pour toi : il contient des prix issus de ton compte.'));

    const views = TABS.map(([k]) => e['view_' + k]);
    e.back = h('div', { class: 'back', onclick: ev => { if (ev.target === e.back) toggle(false); } },
      h('div', { class: 'panel' },
        h('header', null,
          h('div', { style: 'flex:1' }, h('h1', null, 'Stats WikiMasters'), e.sub,
            (e.updBanner = h('a', { class: 'tag deal', href: SCRIPT_URL, target: '_blank', rel: 'noopener', style: 'display:none;margin-top:4px;text-decoration:none',
              'data-tip': 'Tampermonkey affiche sa page de mise à jour : clique sur « Mettre à jour », puis recharge la page du site.' }, ''))),
          h('button', { class: 'x', title: 'Fermer', onclick: () => toggle(false) }, '×')),
        h('div', { class: 'tabs' }, TABS.map(([k, label]) =>
          (e['tab_' + k] = h('button', { class: 'tab', onclick: () => setTab(k) }, label)))),
        h('div', { class: 'body' }, views)));
    e.pullList = h('div');
    e.pull = h('div', { class: 'pull' },
      h('header', null, h('h1', null, 'Dernier booster'),
        h('button', { class: 'x', title: 'Fermer', onclick: () => { pull.open = false; renderPull(); } }, '×')),
      e.pullList);
    // Bulle d'aide : une seule, flottante, placée sous l'élément survolé qui porte data-tip.
    // Elle est en position fixe, donc jamais coupée par un tableau qui défile.
    e.tip = h('div', { class: 'tipbox' });
    let tipFor = null;
    const showTip = el => {
      tipFor = el;
      e.tip.textContent = el.getAttribute('data-tip');
      e.tip.style.display = 'block';
      const r = el.getBoundingClientRect(), w = e.tip.offsetWidth, hgt = e.tip.offsetHeight;
      let x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
      let y = r.bottom + 6;
      if (y + hgt > window.innerHeight - 8) y = Math.max(8, r.top - hgt - 6);
      e.tip.style.left = x + 'px';
      e.tip.style.top = y + 'px';
    };
    root.addEventListener('mouseover', ev => {
      const el = ev.composedPath().find(n => n && n.getAttribute && n.getAttribute('data-tip'));
      if (el && el !== tipFor) showTip(el);
      else if (!el && tipFor) { tipFor = null; e.tip.style.display = 'none'; }
    });
    root.addEventListener('mouseleave', () => { tipFor = null; e.tip.style.display = 'none'; }, true);
    root.append(h('style', null, CSS),
      h('button', { class: 'fab', onclick: () => toggle() }, '📊 Stats'), e.pull, e.back, e.tip);
    document.documentElement.append(host);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && ui.open) toggle(false); });
    setTab(ui.tab);
  }

  function setTab(t) {
    ui.tab = t;
    for (const [k] of TABS) {
      ui.el['view_' + k].style.display = k === t ? '' : 'none';
      ui.el['tab_' + k].classList.toggle('on', k === t);
    }
    refresh();
  }
  function toggle(force) {
    ui.open = force == null ? !ui.open : force;
    ui.el.back.classList.toggle('open', ui.open);
    if (ui.open) { checkUpdate(false); renderUpdate(); poolPullMine(); }
    refresh();
  }

  let rowsCache = [];
  function refresh() {
    if (!ui.el.host) return;
    resetPrices();
    renderPull();
    overlaySoon();
    if (!ui.open) return;
    rowsCache = buildRows();
    snapshot(rowsCache);
    ui.el.sub.textContent = (db.collectionAt
      ? 'Collection vue le ' + new Date(db.collectionAt).toLocaleString('fr-FR')
      : 'Collection pas encore chargée') + saveWarning();
    syncButtons();
    ({ home: renderHome, col: renderCol, sell: renderSell, sales: renderSales, trades: renderTrades, wish: renderWish, pulls: renderPulls,
      trend: renderTrend, friends: renderFriends, opts: () => {}, data: () => {} })[ui.tab]();
  }
  const simpleTable = (heads, rows, leftCols) => h('table', null,
    h('thead', null, h('tr', null, heads.map((t, i) => h('th', { class: (leftCols || []).includes(i) ? 'l' : '' }, t)))),
    h('tbody', null, rows));
  const rarOrder = r => { const i = RARITIES.indexOf(r); return i < 0 ? 99 : i; };
  // Tableau triable : un clic sur un en-tête trie selon cette colonne, un second clic inverse le sens.
  // Tant qu'aucun en-tête n'a été cliqué, l'ordre fourni est conservé. Les valeurs absentes vont à la fin.
  // Une colonne : { t: titre, get: valeur de tri, cell: contenu, left: aligné à gauche, asc: premier clic croissant }
  // Petit « ? » qui affiche une explication au survol.
  function help(text) { return h('span', { class: 'q', 'data-tip': text }, '?'); }
  // Bloc de boutons avec un titre : regroupe ce qui sert à la même chose.
  function group(title, tipText, ...kids) {
    return h('div', { class: 'grp' }, h('div', { class: 'grp-t' }, title, tipText ? help(tipText) : null), h('div', { class: 'grp-b' }, kids));
  }
  // Section repliable, fermée par défaut.
  function fold(title, ...kids) {
    return h('details', { class: 'fold' }, h('summary', null, title), h('div', { class: 'fold-b' }, kids));
  }
  function sortTable(key, cols, items, rerender, opts) {
    cols = cols.filter(Boolean);
    opts = opts || {};
    const st = ui.sorts[key];
    let list = items;
    if (st && cols[st.i] && cols[st.i].get) {
      const get = cols[st.i].get;
      list = [...items].sort((a, b) => {
        const x = get(a), y = get(b);
        const nx = x == null || x === '', ny = y == null || y === '';
        if (nx || ny) return nx && ny ? 0 : nx ? 1 : -1;
        return (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : x < y ? -1 : x > y ? 1 : 0) * st.dir;
      });
    }
    const head = h('tr', null, cols.map((c, i) => h('th', {
      class: (c.get ? 's' : '') + (c.left ? ' l' : ''),
      onclick: () => {
        if (!c.get) return;
        const cur = ui.sorts[key];
        ui.sorts[key] = cur && cur.i === i ? { i, dir: -cur.dir } : { i, dir: c.asc ? 1 : -1 };
        rerender();
      }
    }, c.t + (st && st.i === i ? (st.dir > 0 ? ' ▲' : ' ▼') : ''), c.tip ? help(c.tip) : null)));
    const shown = opts.limit ? list.slice(0, opts.limit) : list;
    // opts.onRow rend la ligne cliquable (sauf sur ses liens) ; opts.after peut glisser une ligne de détail juste dessous.
    return h('table', null, h('thead', null, head), h('tbody', null, shown.map(it => {
      const canClick = opts.onRow && (!opts.canClick || opts.canClick(it));
      const row = h('tr', {
        class: (opts.rowClass ? opts.rowClass(it) : '') + (canClick ? ' click' : ''),
        onclick: ev => { if (canClick && !ev.target.closest('a,button,input,select')) opts.onRow(it); }
      }, cols.map(c => h('td', { class: c.left ? 'l' : '' }, c.cell(it))));
      return [row, opts.after ? opts.after(it, cols.length) : null];
    })));
  }

  // ----- onglet Mes ventes -----
  // ----- Mes ventes en cours -----
  // Tes annonces en cours, avec la valeur de chaque carte à la rareté de son exemplaire (une shiny n'est pas comparée).
  // cur : le prix actuel de l'annonce, l'offre s'il y en a une, sinon la mise de départ.
  // D'où vient une carte : sa dernière acquisition à cette rareté (ou à rareté inconnue), datée avant `before` (la mise en vente).
  // Achetée aux enchères : le prix payé (une shiny ne compte que pour une shiny). Tirée d'un booster : 0 ₩.
  // Reçue par échange accepté : ≈ ce que tu as donné (valeur actuelle des cartes données, plus les wikibidous donnés, moins ceux
  // reçus), réparti entre les cartes reçues.
  // Rien de connu : « booster probable » (0 ₩, approximatif). Les achats et les échanges viennent d'historiques que le site
  // renvoie, alors qu'un booster n'est vu qu'au moment où tu ouvres le paquet avec le script actif sur la page.
  function originOf(cardId, rarity, shiny, before) {
    const lim = before || Infinity;
    const sameRar = r => !rarOk(rarity) || !rarOk(r) || r === rarity;
    let best = null;
    const keep = o => { if (o.t <= lim && (!best || o.t > best.t)) best = o; };
    for (const a of Object.values(db.auctions)) {
      if (!Array.isArray(a) || a[0] !== 'b' || a[1] !== cardId || typeof a[6] !== 'number' || !!a[8] !== !!shiny || !sameRar(a[3])) continue;
      const t = Date.parse(a[7]);
      if (Number.isFinite(t)) keep({ kind: 'buy', t, cost: a[6] });
    }
    for (const p of db.pulls || []) {
      if (p && num(p.t) && Array.isArray(p.c) && p.c.some(c => Array.isArray(c) && c[0] === cardId && sameRar(c[2]))) keep({ kind: 'pull', t: p.t, cost: 0 });
    }
    for (const tr of Object.values(db.trades)) {
      if (!tr || tr.s !== 'accepted' || !Array.isArray(tr.r) || !tr.r.some(c => c[0] === cardId && sameRar(c[2]))) continue;
      const t = Date.parse(tr.t);
      if (!Number.isFinite(t)) continue;
      const given = (tr.g || []).reduce((sum, c) => sum + valueOf(c[0], c[2]), 0) + num(tr.wg) - num(tr.wr);
      keep({ kind: 'trade', t, cost: Math.max(0, Math.round(given / Math.max(1, tr.r.length))), approx: true, who: tr.w || '?' });
    }
    return best || { kind: 'guess', t: 0, cost: 0, approx: true };
  }
  // Ce que dit la colonne « Origine ».
  const originText = o => (!o ? 'origine inconnue' : o.kind === 'buy' ? 'achetée ' + fmt(o.cost) + ' ₩ le ' + fmtDate(o.t)
    : o.kind === 'pull' ? 'booster du ' + fmtDate(o.t) : o.kind === 'guess' ? 'booster probable'
      : 'échange avec ' + o.who + ' (≈ ' + fmt(o.cost) + ' ₩)');
  const GUESS_TIP = 'Ni achat ni échange connu pour cette carte : elle vient très probablement d’un booster ouvert pendant que le script ' +
    'ne tournait pas sur la page (bouton 📊 absent). Comptée à 0 ₩.';
  // Un profit, signé, en vert ou en rouge.
  const profitTag = (d, approx, tip) => h('span', { class: 'tag ' + (d >= 0 ? 'deal' : 'bad'), title: tip || '' },
    (approx ? '≈ ' : '') + (d >= 0 ? '+' : '−') + fmt(Math.abs(d)) + ' ₩');
  function sellingRows() {
    const now = Date.now();
    return (db.selling || []).map(x => {
      const price = x.s ? null : priceOf(x.c, x.r);
      const cur = x.o != null ? x.o : x.base, origin = originOf(x.c, x.r, x.s, x.at || now);
      return Object.assign({}, x, { price, value: price && price.n ? Math.max(price.med, DISCARD) : null,
        live: !x.e || x.e > now, cur, origin, profit: origin ? cur - origin.cost : null });
    });
  }
  function sellingStats(rows) {
    const live = rows.filter(r => r.live), withOffer = live.filter(r => r.b);
    const priced = live.filter(r => !r.s && r.value != null);
    const max = num(db.market.max);
    return {
      live, withOffer, overBase: withOffer.filter(r => r.o > r.base),
      revenue: withOffer.reduce((a, r) => a + r.o, 0),
      value: priced.reduce((a, r) => a + r.value, 0), unknown: live.filter(r => !r.s && r.value == null).length,
      below: priced.filter(r => r.cur < r.value), highBase: priced.filter(r => !r.b && r.base > r.value),
      profit: live.reduce((a, r) => a + (r.profit == null ? 0 : r.profit), 0),
      guessed: live.filter(r => r.origin && r.origin.kind === 'guess').length,
      max, free: max ? Math.max(0, max - live.length) : null
    };
  }
  // Le bloc en haut de l'onglet Mes ventes. Renvoie true s'il est affiché.
  function renderSelling(hasHistory) {
    const e = ui.el;
    if (!e.sellingBody) return false;
    if (!db.selling || !db.selling.length) { e.sellingBody.replaceChildren(); return false; }
    const rows = sellingRows(), s = sellingStats(rows), now = Date.now();
    const gapCell = r => {
      if (r.s) return h('span', { title: 'Shiny : le site ne distingue pas les ventes shiny, pas de comparaison possible.' }, '✦');
      if (r.value == null) return '—';
      // Pas d'arrondi avant de choisir le signe : avec une valeur de 100,5 ₩, une offre à 100 ₩ est bien en dessous (−0,5 ₩).
      const d = r.cur - r.value;
      return [h('span', { class: 'tag' + (d < 0 ? ' bad' : r.b ? ' deal' : ''), title: (r.b ? 'Offre actuelle' : 'Mise de départ') + ' moins la valeur médiane de la carte' },
        (d >= 0 ? '+' : '−') + fmt(Math.abs(d)) + ' ₩'),
        !r.b && r.base > r.value ? [' ', h('span', { class: 'tag bad', title: 'Mise de départ au-dessus de la valeur médiane : l’annonce risque de rester invendue.' }, 'mise > valeur')] : null];
    };
    const kids = [
      h('h2', null, 'Mes ventes en cours', help('Tes annonces en cours, telles que le site les montrait ' + (db.sellingAt ? ago(db.sellingAt) : '') +
        '. Ouvre la page Marché du site, ou clique sur « Actualiser », pour les mettre à jour. Valeur : médiane des ventes à la rareté de l’exemplaire.')),
      h('div', { class: 'tiles' },
        tile('En vente', fmt(s.live.length) + (s.max ? ' / ' + s.max : ''), s.free == null ? null : plural(s.free, 'place libre', 'places libres')),
        tile('Avec une offre', fmt(s.withOffer.length), s.withOffer.length
          ? plural(s.overBase.length, 'au-dessus de sa mise de départ', 'au-dessus de leur mise de départ') : 'aucune pour l’instant'),
        tile('Si tout part maintenant', fmt(s.revenue) + ' ₩', 'somme des offres actuelles', 'Ce que tu toucherais si les enchères se terminaient sur les offres actuelles.'),
        tile('Valeur de ces cartes', fmt(Math.round(s.value)) + ' ₩', s.unknown ? plural(s.unknown, 'carte sans prix', 'cartes sans prix') : 'valeur médiane',
          'Somme des valeurs médianes, chacune à la rareté de son exemplaire. Les shiny ne sont pas comptées.'),
        tile('Profit si tout part maintenant', (s.profit > 0 ? '+' : s.profit < 0 ? '−' : '') + fmt(Math.abs(s.profit)) + ' ₩',
          s.guessed ? 'dont ' + plural(s.guessed, 'origine devinée (booster probable)', 'origines devinées (booster probable)')
            : 'prix actuel moins ce que les cartes t’ont coûté',
          'Pour chaque annonce : le prix actuel (l’offre, sinon la mise de départ) moins ce que la carte t’a coûté. Achetée : le prix payé. Booster : 0 ₩. ' +
          'Échange : ≈ ce que tu as donné, réparti entre les cartes reçues. Ni achat ni échange connu : booster probable, 0 ₩. ' +
          'Aucune commission n’est connue sur le Marché.'),
        tile('Sous la valeur', fmt(s.below.length), s.below.length ? s.below.slice(0, 2).map(r => r.t).join(', ') + (s.below.length > 2 ? '…' : '') : 'aucune',
          'Annonces dont le prix actuel (l’offre, sinon la mise de départ) est encore sous la valeur médiane : elles risquent de partir en dessous de leur prix.')),
      h('div', { class: 'scroll', style: 'margin-bottom:18px' }, sortTable('selling', [
        { t: 'Carte', left: true, asc: true, get: r => r.t.toLowerCase(), cell: r => [rarBadge(r.r), ' ', r.t, r.s ? ' ✦' : ''] },
        { t: 'Mise de départ', get: r => r.base, cell: r => fmt(r.base) + ' ₩' + (r.l && r.l !== r.base ? ' (au départ ' + fmt(r.l) + ' ₩)' : '') },
        { t: 'Offre actuelle', get: r => r.o, cell: r => (r.b ? auctionLink(r.i, h('b', null, fmt(r.o) + ' ₩ •'), 'Une offre a été faite')
          : auctionLink(r.i, h('span', { class: 'est' }, 'pas d’offre'), 'Pas encore d’offre')) },
        { t: 'Valeur', get: r => r.value, cell: r => (r.value == null ? '—' : (r.price.rel.level === 0 ? '≈ ' : '') + fmt(Math.round(r.value)) + ' ₩') },
        { t: 'Écart', get: r => (r.value == null || r.s ? null : r.cur - r.value), cell: gapCell },
        { t: 'Origine', asc: true, get: r => (r.origin ? r.origin.t : null),
          cell: r => (r.origin && r.origin.kind !== 'guess' ? originText(r.origin) : h('span', { class: 'est', title: GUESS_TIP }, 'booster probable')) },
        { t: 'Profit', get: r => r.profit, cell: r => (r.profit == null ? '—' : profitTag(r.profit, r.origin.approx, 'Prix actuel moins coût : ' + originText(r.origin))) },
        { t: 'Fin', asc: true, get: r => r.e || null, cell: r => (!r.live ? 'terminée' : r.e ? 'dans ' + leftTime(r.e - now) : '—') }
      ], rows.sort((a, b) => (b.live - a.live) || ((a.e || Infinity) - (b.e || Infinity))), renderSales))
    ];
    // replaceChildren, contrairement à h(), afficherait une valeur vide comme le texte « null » : on n'ajoute le titre que s'il sert.
    if (hasHistory) kids.push(h('h2', null, 'Tes enchères terminées'));
    e.sellingBody.replaceChildren(...kids);
    return true;
  }
  function renderSales() {
    const e = ui.el;
    const A = Object.values(db.auctions)
      .map(a => ({ kind: a[0], cardId: a[1], title: a[2], rarity: a[3], list: a[4], base: a[5], final: a[6], t: a[7], shiny: !!a[8] }))
      .sort(byDateDesc);
    const live = renderSelling(A.length > 0);
    if (!A.length) {
      e.salesTiles.replaceChildren();
      e.salesBody.replaceChildren(h('div', { class: 'empty' }, live
        ? 'Aucune enchère terminée en mémoire pour l’instant : le bilan de tes ventes passées s’affichera ici.'
        : 'Aucune enchère en mémoire. Clique sur « Actualiser depuis la page Marché », ou ouvre simplement la page Marché du site.'));
      return;
    }
    const sold = A.filter(a => a.kind === 's'), unsold = A.filter(a => a.kind === 'u'), bought = A.filter(a => a.kind === 'b');
    const listed = sold.length + unsold.length;
    const sum = l => l.reduce((x, a) => x + a.final, 0);
    const revenue = sum(sold), spent = sum(bought);
    e.salesTiles.replaceChildren(
      tile('Ventes réussies', fmt(sold.length), listed
        ? 'sur ' + plural(listed, 'mise en vente', 'mises en vente') + ' · ' + fmt(100 * unsold.length / listed) + ' % d’invendus' : null),
      tile('Revenus', fmt(revenue) + ' ₩', sold.length ? 'prix médian ' + fmt(median(sold.map(a => a.final))) + ' ₩' : null),
      tile('Achats', fmt(bought.length), bought.length ? fmt(spent) + ' ₩ dépensés' : null),
      tile('Solde', (revenue > spent ? '+' : '') + fmt(revenue - spent) + ' ₩', 'revenus moins achats'));
    const kids = [];
    const rars = RARITIES.concat('?').filter(r => sold.some(a => a.rarity === r) || unsold.some(a => a.rarity === r));
    if (rars.length) {
      const byRar = rars.map(r => {
        const sl = sold.filter(a => a.rarity === r);
        return { r, sold: sl.length, unsold: unsold.filter(a => a.rarity === r).length, rev: sum(sl), med: sl.length ? median(sl.map(a => a.final)) : null };
      });
      kids.push(h('h2', null, 'Tes ventes par rareté'), sortTable('salesRar', [
        { t: 'Rareté', asc: true, get: x => rarOrder(x.r), cell: x => rarBadge(x.r) },
        { t: 'Vendues', get: x => x.sold, cell: x => x.sold },
        { t: 'Invendues', get: x => x.unsold, cell: x => x.unsold },
        { t: 'Revenus', get: x => x.rev, cell: x => fmt(x.rev) + ' ₩' },
        { t: 'Prix médian', get: x => x.med, cell: x => (x.med == null ? '—' : fmt(x.med) + ' ₩') }
      ], byRar, renderSales));
    }
    const lines = [];
    if (sold.length) {
      lines.push('Cartes vendues : mise de départ médiane ' + fmt(median(sold.map(a => a.list))) + ' ₩, prix final médian ' +
        fmt(median(sold.map(a => a.final))) + ' ₩. ' + plural(sold.filter(a => a.final > a.base).length, 'vente a', 'ventes ont') +
        ' dépassé la mise de départ.');
    }
    if (unsold.length) lines.push('Cartes invendues : mise de départ médiane ' + fmt(median(unsold.map(a => a.list))) + ' ₩.');
    const ratios = sold.map(a => { const p = priceOf(a.cardId, a.rarity); return p && p.n && p.med ? a.final / p.med : null; }).filter(x => x != null);
    if (ratios.length >= 3) {
      lines.push('Tes ventes se sont conclues, en médiane, à ' + fmt(100 * median(ratios)) + ' % de la valeur médiane actuelle de la carte (sur ' +
        ratios.length + ' ventes).');
    }
    // Profit d'une vente réussie : prix final moins ce que la carte t'avait coûté (origine datée avant la vente).
    // Mémorisé par vente pour ce rendu (null compris) : le tri par profit compare chaque ligne de nombreuses fois.
    const profitMemo = new Map();
    const profitOf = a => {
      if (profitMemo.has(a)) return profitMemo.get(a);
      let out = null;
      if (a.kind === 's' && a.final != null) {
        // Une shiny ne se compare qu'à un achat shiny (et inversement).
        const o = originOf(a.cardId, a.rarity, a.shiny, Date.parse(a.t) || Date.now());
        if (o) out = { d: a.final - o.cost, o };
      }
      profitMemo.set(a, out);
      return out;
    };
    const withProfit = sold.map(profitOf).filter(Boolean);
    if (withProfit.length) {
      const total = withProfit.reduce((x, p) => x + p.d, 0);
      lines.push('Profit sur tes ventes dont l’origine est connue : ' + (total >= 0 ? '+' : '−') + fmt(Math.abs(total)) + ' ₩ (' +
        plural(withProfit.length, 'vente', 'ventes') + ' sur ' + sold.length + ').');
    }
    if (lines.length) kids.push(h('h2', null, 'Mise de départ et prix obtenu'), lines.map(t => h('p', { class: 'line' }, t)));
    const withPrices = showPrices();
    const medOf = a => { const p = priceOf(a.cardId, a.rarity); return p && p.n ? p.med : null; };
    kids.push(h('h2', null, 'Tes enchères (' + fmt(A.length) + ')'),
      sortTable('sales', [
        { t: 'Date', get: a => a.t, cell: a => fmtDate(a.t) },
        { t: 'Carte', left: true, asc: true, get: a => a.title.toLowerCase(), cell: a => a.title },
        { t: 'Rareté', asc: true, get: a => rarOrder(a.rarity), cell: a => rarBadge(a.rarity) },
        { t: 'Type', asc: true, get: a => (a.kind === 'b' ? 'Achat' : 'Vente'), cell: a => (a.kind === 'b' ? 'Achat' : 'Vente') },
        { t: 'Mise de départ', get: a => a.list, cell: a => fmt(a.list) + ' ₩' + (a.base !== a.list ? ' → ' + fmt(a.base) + ' ₩' : '') },
        { t: 'Résultat', get: a => a.final, cell: a => (a.final == null ? h('span', { class: 'est' }, 'Invendue') : h('b', null, fmt(a.final) + ' ₩')) },
        withPrices ? { t: 'Valeur médiane', get: medOf, cell: a => (medOf(a) == null ? '—' : fmt(medOf(a)) + ' ₩') } : null,
        { t: 'Profit', get: a => { const p = profitOf(a); return p ? p.d : null; },
          cell: a => { const p = profitOf(a); return p ? profitTag(p.d, p.o.approx, 'Prix final moins coût : ' + originText(p.o)) : '—'; } }
      ], A, renderSales, { limit: 200 }));
    e.salesBody.replaceChildren(...kids.flat(2));
  }

  // ----- onglet Échanges -----
  const TRADE_STATUS = { accepted: 'Accepté', declined: 'Refusé', countered: 'Contre-proposé', pending: 'En attente',
    cancelled: 'Annulé', canceled: 'Annulé', expired: 'Expiré' };
  function renderTrades() {
    const e = ui.el;
    // Une carte dont le script ne connaît aucune vente n'a pas de valeur ici : on la compte à part, sans l'inventer.
    // Une carte analysée récemment et jamais vendue vaut la défausse ; une carte jamais analysée reste « inconnue ».
    const known = c => {
      const p = priceOf(c[0], c[2]);
      if (p && p.n) return Math.max(p.med, DISCARD);
      return db.prices[c[0]] && !priceDue(c[0], c[2]) ? DISCARD : null;
    };
    const cardsValue = l => l.reduce((a, c) => a + (known(c) || 0), 0);
    const unknown = l => l.filter(c => known(c) == null).length;
    const T = Object.entries(db.trades)
      .map(([id, t]) => ({ id, ...t, vg: cardsValue(t.g) + t.wg, vr: cardsValue(t.r) + t.wr, ug: unknown(t.g), ur: unknown(t.r) }))
      .sort(byDateDesc);
    const toPrice = tradeCardsToPrice().length;
    e.tradeFill.disabled = job.running || proState() !== true || !toPrice;
    e.tradeFill.textContent = proState() === true ? 'Relever les prix (' + toPrice + ')' : 'Relever les prix (Pro)';
    e.stop3.disabled = !job.running;
    if (!T.length) {
      e.tradeTiles.replaceChildren();
      e.tradeBody.replaceChildren(h('div', { class: 'empty' },
        'Aucun échange en mémoire. Clique sur « Actualiser mes échanges », ou ouvre la page Échanges du site.'));
      return;
    }
    const withPrices = showPrices();
    const done = T.filter(t => t.s === 'accepted');
    const count = s => T.filter(t => t.s === s).length;
    const sum = (l, f) => l.reduce((a, t) => a + f(t), 0);
    const given = sum(done, t => t.g.length), got = sum(done, t => t.r.length);
    const vg = sum(done, t => t.vg), vr = sum(done, t => t.vr);
    const signed = v => (v > 0 ? '+' : '') + fmt(v) + ' ₩';
    const missing = sum(done, t => t.ug + t.ur);
    // « + 2 ? » : deux cartes de ce côté n'ont pas de prix connu et ne sont pas comptées.
    const withGap = (v, n) => fmt(v) + ' ₩' + (n ? ' + ' + n + ' ?' : '');
    const gapTitle = n => (n ? plural(n, 'carte sans prix connu, non comptée', 'cartes sans prix connu, non comptées') : '');
    e.tradeTiles.replaceChildren(...[
      tile('Échanges conclus', fmt(done.length), 'sur ' + plural(T.length, 'proposition', 'propositions') + ' · ' +
        plural(count('declined'), 'refusée', 'refusées') + ', ' + plural(count('countered'), 'contre-proposée', 'contre-proposées')),
      tile('Cartes données', fmt(given), sum(done, t => t.wg) ? fmt(sum(done, t => t.wg)) + ' ₩ donnés en plus' : null),
      tile('Cartes reçues', fmt(got), sum(done, t => t.wr) ? fmt(sum(done, t => t.wr)) + ' ₩ reçus en plus' : null),
      withPrices ? tile('Bilan en valeur', signed(vr - vg) + (missing ? ' ?' : ''), 'reçu ' + fmt(vr) + ' ₩, donné ' + fmt(vg) + ' ₩' +
        (missing ? ' · incomplet : ' + gapTitle(missing) : '')) : null
    ].filter(Boolean));
    const kids = [];
    // Par joueur
    const byWho = {};
    for (const t of T) {
      const w = byWho[t.w] = byWho[t.w] || { w: t.w, ok: 0, no: 0, g: 0, r: 0, bal: 0, miss: 0 };
      if (t.s === 'accepted') { w.ok++; w.g += t.g.length; w.r += t.r.length; w.bal += t.vr - t.vg; w.miss += t.ug + t.ur; }
      else if (t.s === 'declined') w.no++;
    }
    kids.push(h('h2', null, 'Avec qui tu échanges'), sortTable('tradeWho', [
      { t: 'Joueur', left: true, asc: true, get: x => x.w.toLowerCase(), cell: x => x.w },
      { t: 'Conclus', get: x => x.ok, cell: x => x.ok },
      { t: 'Refusés', get: x => x.no, cell: x => x.no },
      { t: 'Cartes données', get: x => x.g, cell: x => x.g },
      { t: 'Cartes reçues', get: x => x.r, cell: x => x.r },
      withPrices ? { t: 'Bilan en valeur', get: x => x.bal,
        cell: x => h('span', { title: x.miss ? 'Incomplet : ' + gapTitle(x.miss) : '' }, signed(x.bal) + (x.miss ? ' ?' : '')) } : null
    ], Object.values(byWho).sort((a, b) => b.ok - a.ok), renderTrades));
    // Par rareté, sur les échanges conclus
    const rc = {};
    for (const t of done) {
      for (const c of t.g) (rc[c[2]] = rc[c[2]] || { r: c[2], g: 0, got: 0 }).g++;
      for (const c of t.r) (rc[c[2]] = rc[c[2]] || { r: c[2], g: 0, got: 0 }).got++;
    }
    const rarRows = RARITIES.concat('?').filter(r => rc[r]).map(r => rc[r]);
    if (rarRows.length) {
      kids.push(h('h2', null, 'Ce que tu donnes et reçois'), sortTable('tradeRar', [
        { t: 'Rareté', asc: true, get: x => rarOrder(x.r), cell: x => rarBadge(x.r) },
        { t: 'Données', get: x => x.g, cell: x => x.g },
        { t: 'Reçues', get: x => x.got, cell: x => x.got },
        { t: 'Écart', get: x => x.got - x.g, cell: x => (x.got - x.g > 0 ? '+' : '') + (x.got - x.g) }
      ], rarRows, renderTrades));
    }
    // Liste des échanges, dépliable
    const cardList = (label, l, wb) => h('tr', null,
      h('td', null, label),
      h('td', null, l.length || wb
        ? [l.map((c, i) => [i ? ' · ' : '', rarBadge(c[2]), ' ', c[1],
          withPrices ? (known(c) == null ? h('span', { class: 'est' }, ' (prix inconnu)') : ' (' + fmt(known(c)) + ' ₩)') : '']),
        wb ? (l.length ? ' · ' : '') + fmt(wb) + ' ₩' : '']
        : 'rien'));
    kids.push(h('h2', null, 'Tes échanges (' + fmt(T.length) + ')'), sortTable('trades', [
      { t: 'Date', get: t => t.t, cell: t => [h('span', { class: 'caret' }, ui.tradeOpen.has(t.id) ? '▾' : '▸'), fmtDate(t.t)] },
      { t: 'Avec', left: true, asc: true, get: t => t.w.toLowerCase(), cell: t => t.w },
      { t: 'Proposé par', asc: true, get: t => t.ini, cell: t => (t.ini ? 'toi' : t.w) },
      { t: 'Statut', asc: true, get: t => TRADE_STATUS[t.s] || t.s, cell: t => TRADE_STATUS[t.s] || t.s },
      { t: 'Données', get: t => t.g.length, cell: t => t.g.length + (t.wg ? ' + ' + fmt(t.wg) + ' ₩' : '') },
      { t: 'Reçues', get: t => t.r.length, cell: t => t.r.length + (t.wr ? ' + ' + fmt(t.wr) + ' ₩' : '') },
      withPrices ? { t: 'Valeur donnée', get: t => t.vg, cell: t => h('span', { title: gapTitle(t.ug) }, withGap(t.vg, t.ug)) } : null,
      withPrices ? { t: 'Valeur reçue', get: t => t.vr, cell: t => h('span', { title: gapTitle(t.ur) }, withGap(t.vr, t.ur)) } : null,
      withPrices ? { t: 'Écart', get: t => t.vr - t.vg,
        cell: t => h('b', { title: t.ug + t.ur ? 'Incomplet : ' + gapTitle(t.ug + t.ur) : '' }, signed(t.vr - t.vg) + (t.ug + t.ur ? ' ?' : '')) } : null
    ], T, renderTrades, {
      limit: 300,
      rowClass: t => (t.s === 'accepted' ? 'top' : ''),
      onRow: t => { ui.tradeOpen.has(t.id) ? ui.tradeOpen.delete(t.id) : ui.tradeOpen.add(t.id); renderTrades(); },
      after: (t, n) => (ui.tradeOpen.has(t.id) ? h('tr', { class: 'det' }, h('td', { colspan: n },
        h('table', null, h('tbody', null, cardList('Tu donnes', t.g, t.wg), cardList('Tu reçois', t.r, t.wr))))) : null)
    }));
    e.tradeBody.replaceChildren(...kids);
  }

  // ----- onglet Souhaits -----
  // ----- Mes enchères : bilan des enchères où tu as fait une offre (lu sur l'onglet Mes enchères du site) -----
  function bidRows() {
    const now = Date.now();
    return db.bids.map(b => {
      const price = priceOf(b.c, b.r);
      const live = b.e > now;
      return Object.assign({}, b, { price, live, status: !live ? (b.m ? 'Gagnée ?' : 'Terminée') : b.m ? 'Tu mènes' : 'Surenchéri',
        value: price && price.n ? Math.max(price.med, DISCARD) : null });
    });
  }
  function bidStats(rows) {
    const lead = rows.filter(r => r.live && r.m), out = rows.filter(r => r.live && !r.m);
    const engaged = lead.reduce((a, r) => a + r.a, 0);
    const value = lead.reduce((a, r) => a + (r.value || 0), 0);
    return { lead, out, engaged, value, over: lead.filter(r => r.value != null && r.a > r.value), unknown: lead.filter(r => r.value == null).length };
  }
  const leftTime = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); };
  function renderBids() {
    const e = ui.el;
    if (!e.bidBody) return;
    if (!db.bids.length) { e.bidBody.replaceChildren(); return; }
    const rows = bidRows(), s = bidStats(rows), now = Date.now(), gain = s.value - s.engaged;
    const statusTag = r => h('span', { class: 'tag' + (r.status === 'Tu mènes' ? ' deal' : r.status === 'Surenchéri' ? ' bad' : '') }, r.status);
    e.bidBody.replaceChildren(
      h('h2', null, 'Mes enchères', help('Les enchères où tu as fait une offre, telles que le site les montrait dans l’onglet Mes enchères du Marché ' +
        (db.bidsAt ? ago(db.bidsAt) : '') + '. Ouvre cet onglet sur le site pour les mettre à jour.')),
      h('div', { class: 'tiles' },
        tile('En cours', fmt(s.lead.length + s.out.length), s.lead.length + ' où tu mènes · ' + s.out.length + ' surenchéri' + (s.out.length > 1 ? 's' : '')),
        tile('Wikibidous engagés', fmt(s.engaged) + ' ₩', 'sur les enchères où tu mènes', 'Ce que tu paieras si toutes les enchères où tu mènes se terminent ainsi.'),
        tile('Valeur de ces cartes', fmt(Math.round(s.value)) + ' ₩', s.unknown ? plural(s.unknown, 'carte sans prix', 'cartes sans prix') : 'valeur médiane',
          'Somme des valeurs médianes des cartes où tu mènes.'),
        tile('Si tu gagnes tout', (gain > 0 ? '+' : '') + fmt(Math.round(gain)) + ' ₩', gain >= 0 ? 'tu paies moins que la valeur' : 'tu paies plus que la valeur',
          'Valeur des cartes moins tes offres, pour les enchères où tu mènes.'),
        tile('Au-dessus de la valeur', fmt(s.over.length), s.over.length ? s.over.slice(0, 2).map(r => r.t).join(', ') + (s.over.length > 2 ? '…' : '') : 'aucune',
          'Enchères où ton offre dépasse déjà la valeur médiane de la carte.')),
      h('div', { class: 'scroll', style: 'margin-bottom:18px' }, sortTable('bids', [
        { t: 'Carte', left: true, asc: true, get: r => r.t.toLowerCase(), cell: r => [rarBadge(r.r), ' ', r.t, r.s ? ' ✦' : ''] },
        { t: 'Statut', get: r => r.status, cell: statusTag },
        { t: 'Enchère', get: r => r.a, cell: r => auctionLink(r.i, fmt(r.a) + ' ₩') },
        { t: 'Valeur', get: r => r.value, cell: r => (r.value == null ? '—' : [(r.price.rel.level === 0 ? '≈ ' : '') + fmt(Math.round(r.value)) + ' ₩']) },
        { t: 'Enchère max', get: r => maxBid(r.price), cell: r => (r.price && r.price.n ? [fmt(maxBid(r.price)) + ' ₩ ', r.live ? roomTag(r.price, r) : null] : '—') },
        { t: 'Fin', asc: true, get: r => r.e, cell: r => (r.live ? leftTime(r.e - now) : 'terminée') }
      ], rows.sort((a, b) => (b.live - a.live) || (a.e - b.e)), renderBids)));
  }
  function renderWish() {
    const e = ui.el;
    renderBids();
    // Les cartes de la liste, plus celles que le site a signalées même si la liste n'a pas encore été chargée.
    const known = {};
    for (const id in db.wish) known[id] = [db.wish[id][0], db.wish[id][1]];
    for (const a of Object.values(db.alerts)) {
      if (!known[a[0]] && alertOf(a[0])) known[a[0]] = [a[1], (askOf(a[0]) || {}).r || '?'];
    }
    const ids = Object.keys(known);
    if (!ids.length) {
      e.wishTiles.replaceChildren();
      e.wishBody.replaceChildren(h('div', { class: 'empty' },
        'Liste de souhaits pas encore lue. Clique sur « Charger ma liste de souhaits ».'));
      return;
    }
    const withPrices = showPrices();
    const now = Date.now();
    const owned = ownedIds();
    const all = ids.map(id => ({
      id, title: known[id][0], rarity: known[id][1], ask: askOf(id, known[id][1]), alert: alertOf(id), price: priceOf(id, known[id][1]), owned: owned.has(id),
      friends: Object.keys(db.friends).filter(n => db.friends[n].cards && db.friends[n].cards[id])
    }));
    const nOwned = all.filter(c => c.owned).length;
    // Rang d'intérêt : en vente avec prix connu, puis signalée mais pas vérifiée, puis chez un ami, puis le reste.
    const rank = c => (c.ask ? 0 : c.alert ? 1 : c.friends.length ? 2 : 3);
    const onSale = all.filter(c => c.ask).length, atFriends = all.filter(c => c.friends.length).length;
    const toCheck = all.filter(c => !c.ask && c.alert).length;
    e.wishTiles.replaceChildren(
      tile('Cartes souhaitées', fmt(Object.keys(db.wish).length), (db.wishAt ? 'liste lue ' + ago(db.wishAt) : 'liste pas encore chargée') +
        (nOwned ? ' · ' + nOwned + ' déjà dans ta collection' + (db.wishHideOwned ? ', cachées' : '') : '')),
      tile('En vente, prix connu', fmt(onSale), onSale
        ? plural(all.reduce((n, c) => n + (c.ask ? c.ask.list.length : 0), 0), 'annonce', 'annonces') + ' · relevé ' + ago(db.market.at)
        : db.market.at ? 'dernier relevé ' + ago(db.market.at) : 'marché pas encore relevé'),
      tile('Signalées, à vérifier', fmt(toCheck), 'alertes du site des 12 dernières heures'),
      withPrices ? tile('Bonnes affaires', fmt(all.filter(c => isDeal(c)).length), 'au moins ' + DEAL_PCT + ' % sous la valeur médiane') : null,
      tile('Chez un ami', fmt(atFriends), plural(Object.keys(db.friends).length, 'ami importé', 'amis importés')));
    const left = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + ' min' : Math.round(m / 60) + ' h'; };
    const list = all
      .filter(c => (!ui.wishRarity || c.rarity === ui.wishRarity) && (!ui.wishAvail || rank(c) < 3) && !(db.wishHideOwned && c.owned) &&
        (!ui.wishDeals || isDeal(c)))
      .sort((a, b) => rank(a) - rank(b) || dealOf(b) - dealOf(a) || (a.ask && b.ask ? a.ask.a - b.ask.a : 0) ||
        rarOrder(a.rarity) - rarOrder(b.rarity) || a.title.localeCompare(b.title));
    if (!list.length) {
      e.wishBody.replaceChildren(h('div', { class: 'empty' }, 'Aucune carte avec ces filtres.'));
      return;
    }
    const LIMIT = 400;
    // Une ligne par carte. Quand elle a plusieurs annonces, un clic sur la ligne les déplie juste dessous.
    const multi = c => !!c.ask && c.ask.list.length > 1;
    const isOpen = c => multi(c) && (ui.wishAll ? !ui.wishOpen.has(c.id) : ui.wishOpen.has(c.id));
    // La ligne d'une carte décrit toujours UNE annonce, prix et fin ensemble. Laquelle dépend du tri en cours :
    // la moins chère par défaut, la plus chère si on trie par prix décroissant,
    // celle qui finit le plus tôt ou le plus tard si on trie par fin d'enchère.
    const iPrice = withPrices ? 3 : 2, iEnd = iPrice + 1;
    const st = ui.sorts.wish;
    const mode = st && st.i === iEnd ? (st.dir > 0 ? 'soon' : 'late') : st && st.i === iPrice && st.dir < 0 ? 'max' : 'min';
    // Les annonces à la rareté de la ligne passent d'abord : un exemplaire UR ne donne pas le prix d'une ligne L.
    const pool = c => { const l = c.ask.list, s = l.filter(x => !rarOk(x.r) || x.r === c.rarity); return s.length ? s : l; };
    const feat = c => {
      if (!c.ask) return null;
      const l = pool(c);
      if (mode === 'max') return l[l.length - 1];
      if (mode === 'soon' || mode === 'late') {
        const live = l.filter(x => x.e > now);
        if (live.length) return live.reduce((a, b) => ((mode === 'soon' ? b.e < a.e : b.e > a.e) ? b : a));
      }
      return l[0];
    };
    const WHICH = { min: 'la moins chère', max: 'la plus chère', soon: 'celle qui finit le plus tôt', late: 'celle qui finit le plus tard' };
    const anyMulti = list.some(multi);
    e.wishFold.style.display = anyMulti ? '' : 'none';
    e.wishFold.textContent = ui.wishAll ? 'Tout replier' : 'Tout déplier';
    const detail = (c, n) => (isOpen(c) ? h('tr', { class: 'det' }, h('td', { colspan: n },
      h('table', null, h('tbody', null, c.ask.list.map((au, k) => h('tr', null,
        h('td', null, 'Annonce ' + (k + 1)),
        h('td', null, auctionLink(au.i, h('b', null, fmt(au.a) + ' ₩'), 'Annonce ' + (k + 1))),
        h('td', null, au.b ? 'une offre a déjà été faite' : 'pas encore d’offre'),
        h('td', null, au.e > now ? 'fin dans ' + left(au.e - now) : 'fin inconnue'),
        h('td', { title: 'Rareté de cet exemplaire : son prix se compare à la valeur de cette rareté.' }, rarOk(au.r) ? rarBadge(au.r) : ''),
        withPrices && maxBid(priceForAsk(c.id, au, c.price)) != null ? h('td', null, roomTag(priceForAsk(c.id, au, c.price), au)) : null)))))) : null);
    e.wishBody.replaceChildren(
      sortTable('wish', [
        { t: 'Carte', left: true, asc: true, get: c => c.title.toLowerCase(),
          cell: c => [multi(c) ? h('span', { class: 'caret' }, isOpen(c) ? '▾' : '▸') : h('span', { class: 'caret' }), c.title,
            multi(c) ? h('span', { class: 'tag', title: c.ask.other ? 'Dont ' + plural(c.ask.other, 'annonce', 'annonces') + ' d’une autre rareté : déplie la ligne pour les voir.' : '' },
              c.ask.list.length + ' annonces' + (c.ask.other ? ' (' + c.ask.other + ' autre rareté)' : '')) : null,
            isDeal(c) ? h('span', { class: 'tag deal', title: 'L’annonce la moins chère est ' + dealOf(c) + ' % sous la valeur médiane de sa rareté (' +
              fmt(priceForAsk(c.id, c.ask, c.price).med) + ' ₩, ' + priceForAsk(c.id, c.ask, c.price).n + ' ventes)' }, 'bonne affaire −' + dealOf(c) + ' %') : null,
            c.owned ? h('span', { class: 'tag', title: 'Cette carte est déjà dans ta collection' }, 'possédée') : null] },
        { t: 'Rareté', asc: true, get: c => rarOrder(c.rarity), cell: c => rarBadge(c.rarity) },
        withPrices ? { t: 'Valeur médiane', tip: 'Médiane des dernières ventes de la carte : sert à juger si une annonce est une bonne affaire.', get: c => (c.price && c.price.n ? c.price.med : null),
          cell: c => (c.price && c.price.n ? fmt(c.price.med) + ' ₩' : '—') } : null,
        { t: 'En vente à', tip: 'Prix de l’annonce affichée sur la ligne. Un point = une offre a déjà été faite. Le lien ouvre l’annonce. « à vérifier » : signalée par le site, prix pas encore lu.', asc: true, get: c => (c.ask ? feat(c).a : null),
          cell: c => {
            if (!c.ask) return c.alert ? auctionLink(c.alert[4], h('span', { class: 'est' }, 'à vérifier'), 'Prix pas encore lu') : '—';
            const f = feat(c);
            const lead = !multi(c) ? '' : mode === 'min' ? 'dès ' : mode === 'max' ? 'jusqu’à ' : '';
            const link = auctionLink(f.i, h('b', null, lead + fmt(f.a) + ' ₩' + (f.b ? ' •' : '')),
              (multi(c) ? 'Sur ' + c.ask.list.length + ' annonces, ' + WHICH[mode] + ' · ' : '') +
              (f.b ? 'une offre a déjà été faite' : 'mise de départ, pas encore d’offre'));
            // Aucune annonce à la rareté de la ligne : on dit de quelle rareté est celle qu'on montre.
            return rarOk(f.r) && f.r !== c.rarity ? [link, ' ', h('span', { title: 'Exemplaire d’une autre rareté' }, rarBadge(f.r))] : link;
          } },
        { t: 'Fin de l’enchère', tip: 'Temps restant avant la fin de l’enchère affichée sur la ligne.', asc: true, get: c => (c.ask && feat(c).e > now ? feat(c).e : null),
          cell: c => {
            const f = c.ask ? feat(c) : null;
            return f && f.e > now ? h('span', { title: multi(c) ? 'Fin de l’annonce affichée sur cette ligne : ' + WHICH[mode] : '' }, 'dans ' + left(f.e - now)) : '—';
          } },
        withPrices ? { t: 'Enchère max', tip: 'Jusqu’à ce montant, tu paies la carte au plus sa valeur médiane : au-delà, tu la paies plus cher qu’elle ne se vend d’habitude. ' +
            'L’étiquette verte dit combien il te reste de marge sur l’annonce de la ligne, la rouge qu’elle est déjà trop chère. « ≈ » : prix douteux, à prendre avec prudence.',
          get: c => maxBid(c.price),
          cell: c => {
            const mx = maxBid(c.price);
            if (mx == null) return '—';
            return [h('b', null, (c.price.rel.level === 0 ? '≈ ' : '') + fmt(mx) + ' ₩'), c.ask ? roomTag(priceForAsk(c.id, feat(c), c.price), feat(c)) : null];
          } } : null,
        { t: 'Alerte du site', tip: 'Depuis quand le site t’a signalé la mise en vente de cette carte.', get: c => (c.alert ? c.alert[2] : null), cell: c => (c.alert ? ago(c.alert[2]) : '—') },
        { t: 'Cherchée', tip: 'Quand le script a cherché cette carte sur le marché pour la dernière fois.', get: c => db.wishSeen[c.id] || null, cell: c => (db.wishSeen[c.id] ? ago(db.wishSeen[c.id]) : '—') },
        { t: 'Chez un ami', asc: true, get: c => c.friends.join(', '), cell: c => (c.friends.length ? c.friends.join(', ') : '—') }
      ], list, renderWish, {
        limit: LIMIT, rowClass: c => (rank(c) < 3 ? 'top' : ''), canClick: multi, after: detail,
        onRow: c => { ui.wishOpen.has(c.id) ? ui.wishOpen.delete(c.id) : ui.wishOpen.add(c.id); renderWish(); }
      }),
      ...(list.length > LIMIT ? [h('div', { class: 'sub' }, '… et ' + fmt(list.length - LIMIT) + ' autres. Filtre par rareté pour les voir.')] : []));
  }

  // ----- onglet Évolution -----
  const METRICS = { 0: ['Valeur totale', ' ₩'], 1: ['Nombre de cartes', ''], 3: ['Cartes déjà vendues aux enchères', ''] };
  function renderTrend() {
    const e = ui.el;
    const days = Object.keys(db.history).sort();
    if (!days.length) {
      e.trendBody.replaceChildren(h('div', { class: 'empty' }, 'Pas encore de relevé. Charge ta collection dans l’onglet Collection.'));
      return;
    }
    const [label, unit] = METRICS[ui.metric] || METRICS[0];
    const pts = days.map(d => ({ d, t: Date.parse(d + 'T12:00:00'), v: db.history[d][ui.metric] || 0 }));
    const dayLabel = d => new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    const kids = [];
    if (pts.length < 2) {
      kids.push(h('div', { class: 'tiles' }, tile(label, fmt(pts[0].v) + unit, 'relevé du ' + dayLabel(pts[0].d))),
        h('div', { class: 'sub', style: 'margin-bottom:12px' }, 'La courbe apparaîtra à partir du deuxième jour de relevé.'));
    } else {
      const W = 820, H = 240, L = 62, R = 18, T = 30, B = 26;
      const vmin = Math.min(...pts.map(p => p.v)), vmax = Math.max(...pts.map(p => p.v));
      const pad = (vmax - vmin) * 0.1 || Math.max(1, vmax * 0.05);
      const y0 = Math.max(0, vmin - pad), y1 = vmax + pad;
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
      const X = t => L + (t - t0) / (t1 - t0) * (W - L - R);
      const Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
      const path = pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
      const cross = s('line', { y1: T, y2: H - B, stroke: '#8b9a94', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
      const focus = s('circle', { r: 5, fill: '#34d399', stroke: '#151c19', 'stroke-width': 2, visibility: 'hidden' });
      const tip = h('div', { class: 'tip' });
      const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': label + ' au fil des jours' },
        [y0, (y0 + y1) / 2, y1].map(v => [
          s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: '#26302c', 'stroke-width': 1 }),
          s('text', { x: L - 8, y: Y(v) + 4, 'text-anchor': 'end' }, fmt(Math.round(v)))]),
        s('text', { x: L, y: H - 6, 'text-anchor': 'start' }, dayLabel(pts[0].d)),
        s('text', { x: W - R, y: H - 6, 'text-anchor': 'end' }, dayLabel(pts[pts.length - 1].d)),
        s('path', { d: path + ' L' + X(t1).toFixed(1) + ' ' + (H - B) + ' L' + X(t0).toFixed(1) + ' ' + (H - B) + ' Z', fill: '#34d399', 'fill-opacity': 0.1 }),
        s('path', { d: path, fill: 'none', stroke: '#34d399', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
        pts.length <= 45 ? pts.map(p => s('circle', { cx: X(p.t), cy: Y(p.v), r: 4, fill: '#34d399', stroke: '#151c19', 'stroke-width': 2 })) : null,
        cross, focus);
      const show = ev => {
        const box = svg.getBoundingClientRect();
        const x = (ev.clientX - box.left) / box.width * W;
        let best = pts[0];
        for (const p of pts) if (Math.abs(X(p.t) - x) < Math.abs(X(best.t) - x)) best = p;
        const px = X(best.t);
        cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
        focus.setAttribute('cx', px); focus.setAttribute('cy', Y(best.v)); focus.setAttribute('visibility', 'visible');
        tip.textContent = dayLabel(best.d) + ' : ' + fmt(best.v) + unit;
        tip.style.left = Math.min(92, Math.max(8, px / W * 100)) + '%';
        tip.style.display = 'block';
      };
      svg.addEventListener('mousemove', show);
      svg.addEventListener('mouseleave', () => {
        cross.setAttribute('visibility', 'hidden'); focus.setAttribute('visibility', 'hidden'); tip.style.display = 'none';
      });
      const first = pts[0].v, last = pts[pts.length - 1].v, delta = last - first;
      kids.push(h('div', { class: 'tiles' },
        tile(label, fmt(last) + unit, 'au ' + dayLabel(pts[pts.length - 1].d)),
        tile('Depuis le ' + dayLabel(pts[0].d), (delta > 0 ? '+' : '') + fmt(delta) + unit, first ? (delta > 0 ? '+' : '') + fmt(100 * delta / first) + ' %' : null)),
        h('div', { class: 'chart' }, svg, tip));
    }
    const dayRows = days.map((d, i) => {
      const v = db.history[d], prev = i ? db.history[days[i - 1]] : null;
      return { d, v, dv: prev ? v[0] - prev[0] : null };
    }).reverse();
    kids.push(sortTable('trend', [
      { t: 'Jour', get: x => x.d, cell: x => new Date(x.d + 'T12:00:00').toLocaleDateString('fr-FR') },
      { t: 'Valeur totale', get: x => x.v[0], cell: x => fmt(x.v[0]) + ' ₩' },
      { t: 'Variation', get: x => x.dv, cell: x => (x.dv == null ? '—' : (x.dv > 0 ? '+' : '') + fmt(x.dv) + ' ₩') },
      { t: 'Cartes', get: x => x.v[1], cell: x => fmt(x.v[1]) },
      { t: 'Cartes différentes', get: x => x.v[2], cell: x => fmt(x.v[2]) },
      { t: 'Déjà vendues aux enchères', get: x => x.v[3], cell: x => fmt(x.v[3]) }
    ], dayRows, renderTrend, { limit: 60 }));
    e.trendBody.replaceChildren(...kids);
  }
  const tile = (label, val, sub, tip) => h('div', { class: 'tile' },
    h('span', null, label, tip ? help(tip) : null), h('b', null, val), sub ? h('small', null, sub) : null);
  const plural = (n, one, many) => fmt(n) + ' ' + (n > 1 ? many : one);
  // Marge entre l'enchère max conseillée et le prix actuel d'une annonce.
  function roomTag(price, au) {
    const mx = maxBid(price);
    if (mx == null || !au) return null;
    const room = mx - au.a;
    return room > 0
      ? h('span', { class: 'tag deal', 'data-tip': 'Tu peux monter jusqu’à ' + fmt(mx) + ' ₩, soit ' + fmt(room) + ' ₩ au-dessus du prix actuel (' + fmt(au.a) + ' ₩).' }, '+' + fmt(room) + ' ₩')
      : h('span', { class: 'tag bad', 'data-tip': 'Le prix actuel (' + fmt(au.a) + ' ₩) atteint déjà la valeur médiane : enchérir revient à payer la carte plus cher qu’elle ne se vend d’habitude.' }, 'trop cher');
  }

  // ----- onglet Collection -----
  // Le lot en préparation, d'après les choix du groupe « Étiquetage par lots ».
  const currentTagBatch = () => tagBatch(ui.tagRule || 'sell', ui.tagId || '', { rarity: ui.tagRar || 'L', min: ui.tagMin == null ? 100 : ui.tagMin });
  function renderTagBatch() {
    const e = ui.el;
    if (!e.tagSel) return;
    const cat = db.tagCat || [];
    if (!cat.some(t => t.id === ui.tagId)) ui.tagId = cat.length ? cat[0].id : '';
    e.tagSel.replaceChildren(...(cat.length ? cat.map(t => h('option', { value: t.id, selected: t.id === ui.tagId }, t.name)) : [h('option', { value: '' }, 'aucune étiquette connue')]));
    const rule = ui.tagRule || 'sell';
    e.tagRar.style.display = rule === 'rarity' ? '' : 'none';
    e.tagMin.style.display = rule === 'value' ? '' : 'none';
    if (e.tagApply.dataset.armed) return;
    if (!cat.length) {
      e.tagApply.disabled = true;
      e.tagInfo.textContent = 'Aucune étiquette connue : ouvre la page Collection du site (le script lit tes étiquettes au passage), ou crée-en une sur le site.';
      return;
    }
    const b = currentTagBatch();
    e.tagApply.disabled = !b.items.length || job.running;
    e.tagInfo.textContent = b.items.length
      ? plural(b.items.length, 'carte', 'cartes') + ' → « ' + b.tag.name + ' »' + (b.total > b.items.length ? ' (sur ' + fmt(b.total) + ' : un lot à la fois)' : '')
      : 'Aucune carte à étiqueter avec cette règle.';
    e.tagInfo.title = b.items.slice(0, 25).map(x => x.rarity + ' · ' + x.title).join('\n') + (b.items.length > 25 ? '\n…' : '');
  }
  async function onTagApply(ev) {
    const btnEl = ev.currentTarget, e = ui.el, idle = 'Appliquer ce lot';
    const b = currentTagBatch();
    if (!b.items.length) return;
    if (!btnEl.dataset.armed) {
      btnEl.dataset.armed = '1';
      btnEl.textContent = 'Confirmer : étiqueter ' + plural(b.items.length, 'carte', 'cartes') + ' ?';
      setTimeout(() => { if (btnEl.dataset.armed) { delete btnEl.dataset.armed; btnEl.textContent = idle; renderTagBatch(); } }, 5000);
      return;
    }
    delete btnEl.dataset.armed;
    btnEl.textContent = idle;
    btnEl.disabled = true;
    e.tagInfo.textContent = 'Étiquetage en cours…';
    try {
      const res = await applyTagBatch(b);
      e.tagInfo.textContent = plural(res.n, 'carte étiquetée', 'cartes étiquetées') + ' « ' + b.tag.name + ' ».';
    } catch (err) {
      e.tagInfo.textContent = 'Échec : ' + err.message + '. Rien n’a été modifié.';
    }
    btnEl.disabled = false;
    setTimeout(renderTagBatch, 4000);
  }
  function renderCol() {
    renderTagBatch();
    const rows = rowsCache, e = ui.el;
    const nCards = rows.reduce((a, r) => a + r.count, 0);
    const total = rows.reduce((a, r) => a + r.total, 0);
    const estTotal = rows.reduce((a, r) => a + (r.est ? r.total : 0), 0);
    const known = rows.filter(r => r.price && r.price.n > 0).length;
    const withPrices = showPrices();
    const avg = k => (rows.length ? rows.reduce((a, r) => a + (r[k] || 0), 0) / rows.length : null);
    if (!withPrices && (COLS.find(c => c.k === ui.sortKey) || {}).price) { ui.sortKey = 'rarity'; ui.sortDir = 1; }
    e.tiles.replaceChildren(...(withPrices ? [
      tile('Cartes', fmt(nCards)),
      tile('Valeur totale', fmt(total) + ' ₩'),
      tile('Déjà vendues aux enchères', fmt(known), 'sur ' + plural(rows.length, 'carte', 'cartes'),
        'Cartes pour lesquelles au moins une vente aux enchères est connue : leur valeur est la médiane de ces ventes.'),
      tile('Sans vente connue', fmt(rows.length - known),
        'comptées à 1 ₩ · ' + (total ? fmt(100 * estTotal / total) : '0') + ' % de la valeur totale',
        'Cartes qui n’ont jamais été vendues aux enchères à notre connaissance. Elles comptent pour 1 ₩, ce que rapporte la défausse.'),
      proState() === true ? tile('Pas encore analysées', fmt(rows.filter(r => !db.prices[r.cardId]).length), null,
        'Cartes dont le script n’a jamais demandé l’historique des ventes. « Relever les prix » s’en occupe.') : null
    ].filter(Boolean) : [
      tile('Cartes', fmt(nCards)),
      tile('Cartes différentes', fmt(rows.length)),
      tile('ATK moyenne', fmt(avg('atk'))),
      tile('DEF moyenne', fmt(avg('def')))
    ]));
    e.rar.replaceChildren(...RARITIES.filter(r => rows.some(x => x.rarity === r)).map(r => {
      const g = rows.filter(x => x.rarity === r);
      const n = g.reduce((a, x) => a + x.count, 0);
      return h('span', { class: 'pill' }, rarBadge(r), ' ',
        n, h('i', null, n > 1 ? ' cartes' : ' carte'),
        withPrices ? [h('i', null, ' · '), fmt(g.reduce((a, x) => a + x.total, 0)), ' ₩'] : null);
    }));
    // De préférence les fins d'enchères observées (prix presque définitifs) ; sinon les offres en cours.
    const seenRar = observedByRarity();
    const mk = seenRar.length ? seenRar : marketByRarity();
    const nSeen = Object.keys(db.obsSales).length;
    e.market.replaceChildren(...(mk.length
      ? [h('span', { class: 'sub' }, seenRar.length ? 'Prix de vente observés sur 7 jours :' : 'Enchères avec offre en ce moment :'),
        ...mk.map(x => h('span', { class: 'pill', title: x.n + (seenRar.length ? ' fins d’enchères observées' : ' enchères avec offre') },
          rarBadge(x.r), ' ', h('i', null, 'autour de '), fmt(x.med), ' ₩')),
        h('span', { class: 'sub' }, '(' + (nSeen ? plural(nSeen, 'carte avec un prix observé', 'cartes avec un prix observé') + ', ' : '') + 'relevé ' + ago(db.market.at) + ')')]
      : [h('span', { class: 'sub' }, db.market.at
        ? 'Marché relevé ' + ago(db.market.at) + ' : pas assez d’enchères avec offre pour donner un niveau de prix.'
        : 'Marché pas encore relevé : clique sur « Relever les fins d’enchères » ou ouvre la page Marché du site.')]));
    renderTable();
  }

  function visibleRows() {
    const col = COLS.find(c => c.k === ui.sortKey) || COLS[0];
    return rowsCache
      .filter(r => (!ui.rarity || r.rarity === ui.rarity) &&
        (!ui.text || (r.title + ' ' + r.cat + ' ' + r.tags.join(' ')).toLowerCase().includes(ui.text)))
      .sort((a, b) => {
        const x = col.get(a), y = col.get(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * ui.sortDir;
      });
  }

  function renderTable() {
    const e = ui.el;
    if (!rowsCache.length) {
      e.table.replaceChildren(h('div', { class: 'empty' },
        'Aucune carte en mémoire. Clique sur « Recharger ma collection », ou ouvre simplement la page Collection du site.'));
      return;
    }
    const rows = visibleRows();
    const withPrices = showPrices();
    const withAsks = rowsCache.some(r => r.ask);
    const cols = COLS.filter(c => (c.price ? withPrices : c.ask ? withAsks : true));
    const head = h('tr', null, cols.map(c => h('th', {
      class: 's',
      onclick: () => {
        if (ui.sortKey === c.k) ui.sortDir = -ui.sortDir;
        else { ui.sortKey = c.k; ui.sortDir = c.k === 'title' || c.k === 'rarity' ? 1 : -1; }
        renderTable();
      }
    }, c.t + (ui.sortKey === c.k ? (ui.sortDir > 0 ? ' ▲' : ' ▼') : ''), c.tip ? help(c.tip) : null)));
    const body = rows.map(r => h('tr', null, cols.map(c => h('td', null, c.cell(r)))));
    e.table.replaceChildren(h('table', null, h('thead', null, head), h('tbody', null, body)));
  }

  // ----- onglet Accueil : l'essentiel de chaque onglet, en une page -----
  function renderHome() {
    const e = ui.el, now = Date.now();
    const card = (title, tab, kids, tipText, cls) => h('div', { class: 'card' + (cls ? ' ' + cls : '') },
      h('h2', null, h('span', null, title, tipText ? help(tipText) : null),
        tab ? h('button', { class: 'more', onclick: () => setTab(tab) }, 'voir →') : null), kids);
    const line = (...kids) => h('li', null, ...kids);
    const none = text => h('div', { class: 'sub' }, text);
    const left = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + ' min' : Math.round(m / 60) + ' h'; };
    if (!rowsCache.length) {
      e.homeTiles.replaceChildren();
      e.homeBody.replaceChildren(card('Bienvenue', 'col', none('Collection pas encore chargée : ouvre l’onglet Collection et clique sur « Recharger ma collection ».')));
      return;
    }
    const withPrices = showPrices();
    // ----- chiffres clés -----
    const total = rowsCache.reduce((a, r) => a + r.total, 0);
    const days = Object.keys(db.history).sort();
    const prevDay = days.filter(d => d < dayKey(new Date())).pop();
    const delta = prevDay ? Math.round(total) - db.history[prevDay][0] : null;
    const m = db.market, used = m.selling ? m.selling.length : null;
    const free = used != null && m.max ? Math.max(0, m.max - used) : null;
    const sl = withPrices ? sellList() : [];
    const owned = db.wishHideOwned ? ownedIds() : null;
    const wish = Object.keys(db.wish).filter(id => !(owned && owned.has(id)))
      .map(id => ({ id, title: db.wish[id][0], rarity: db.wish[id][1], ask: askOf(id, db.wish[id][1]), price: priceOf(id, db.wish[id][1]) })).filter(c => c.ask);
    const deals = wish.filter(isDeal).sort((a, b) => dealOf(b) - dealOf(a));
    const A = Object.values(db.auctions);
    const sold = A.filter(a => a[0] === 's');
    const weekAgo = new Date(now - 7 * DAY).toISOString();
    const soldWeek = sold.filter(a => a[7] > weekAgo);
    e.homeTiles.replaceChildren(
      tile('Valeur de la collection', fmt(total) + ' ₩', delta == null ? 'variation visible dès demain' :
        (delta >= 0 ? '+' : '') + fmt(delta) + ' ₩ depuis le ' + new Date(prevDay + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
      'Somme des valeurs de tes cartes : médiane des ventes de chacune, 1 ₩ pour une carte sans vente connue.'),
      tile('Cartes', fmt(rowsCache.reduce((a, r) => a + r.count, 0)), plural(new Set(rowsCache.map(r => r.cardId)).size, 'différente', 'différentes')),
      tile('Places de vente libres', free == null ? '—' : fmt(free), free == null ? 'ouvre la page Marché du site' : 'sur ' + m.max + ' · ' + plural(sl.length, 'carte à vendre', 'cartes à vendre'),
        'Le site limite le nombre d’enchères en cours. Les places libres sont celles que tu peux encore remplir.'),
      tile('Revenus des 7 derniers jours', fmt(soldWeek.reduce((a, s) => a + s[6], 0)) + ' ₩', plural(soldWeek.length, 'vente', 'ventes') + ' · ' + plural(sold.length, 'vente en mémoire', 'ventes en mémoire'),
        'D’après tes enchères lues sur la page Marché. Le site ne donne que les plus récentes, l’historique se construit avec le temps.'),
      tile('Bonnes affaires', fmt(deals.length), plural(wish.length, 'souhait en vente', 'souhaits en vente'),
        'Annonces de ta liste de souhaits au moins 30 % sous la valeur médiane de la carte.'));

    const cards = [];
    // ----- ce qui rend les chiffres douteux -----
    const warns = [];
    const fullAge = db.collectionFullAt ? now - db.collectionFullAt : Infinity;
    if (fullAge > DAY) {
      warns.push(line(h('span', { class: 'grow wrap' }, db.collectionFullAt
        ? 'Collection rechargée il y a ' + Math.round(fullAge / DAY) + ' j : les cartes vendues ou données depuis y sont encore.'
        : 'Collection jamais rechargée entièrement avec cette version : les cartes vendues ou données peuvent y être encore.'),
        h('button', { class: 'more', onclick: () => { setTab('col'); loadCollection(); } }, 'recharger')));
    }
    const noPrice = rowsCache.filter(r => ['L', 'UR', 'SR'].includes(r.rarity) && !db.prices[r.cardId]).length;
    if (noPrice && proState() === true) {
      warns.push(line(h('span', { class: 'grow wrap' }, plural(noPrice, 'carte L, UR ou SR sans prix relevé', 'cartes L, UR ou SR sans prix relevé') +
        ' : elles comptent pour 1 ₩ et n’apparaissent pas dans À vendre.'),
        h('button', { class: 'more', onclick: () => setTab('col') }, 'compléter')));
    }
    if (warns.length) cards.push(card('À vérifier', null, h('ul', null, warns), null, 'warncard'));

    // ----- à vendre -----
    cards.push(card('À vendre' + (free != null ? ' · ' + plural(free, 'place libre', 'places libres') : ''), 'sell',
      sl.length ? h('ul', null, sl.slice(0, 8).map(r => line(rarBadge(r.rarity),
        h('a', { class: 'grow', href: sellLink(r.cardId), target: '_blank', rel: 'noopener', 'data-tip': 'Ouvrir le formulaire de mise en vente de cette carte' }, r.title),
        r.count > 1 ? h('span', { class: 'tag' }, '×' + r.count) : null,
        h('b', null, fmt(Math.round(r.value)) + ' ₩'))))
        : none('Aucune carte à vendre avec les réglages actuels.'),
      'Tes cartes qui valent le plus, hors cartes déjà en vente. Un clic sur un nom ouvre sa mise en vente sur le site.'));

    // ----- souhaits en vente -----
    const soon = wish.filter(c => !isDeal(c) && c.ask.e > now).sort((a, b) => a.ask.e - b.ask.e);
    const pick = deals.concat(soon).slice(0, 8);
    cards.push(card('Souhaits en vente', 'wish',
      pick.length ? h('ul', null, pick.map(c => line(rarBadge(c.rarity), h('span', { class: 'grow' }, c.title),
        isDeal(c) ? h('span', { class: 'tag deal' }, '−' + dealOf(c) + ' %') : null,
        h('span', { class: 'sub', 'data-tip': 'Fin de l’enchère' }, c.ask.e > now ? left(c.ask.e - now) : ''),
        auctionLink(c.ask.i, h('b', null, fmt(c.ask.a) + ' ₩'), 'Ouvrir l’annonce'))))
        : none('Aucun souhait en vente connu. Onglet Souhaits : « Vérifier les alertes » ou « Trouver les annonces ».'),
      'Les bonnes affaires d’abord, puis les enchères qui finissent le plus tôt.'));

    // ----- mes enchères -----
    const bl = bidRows().filter(r => r.live).sort((a, b) => a.e - b.e);
    if (bl.length) {
      const s = bidStats(bl);
      cards.push(card('Mes enchères · ' + plural(bl.length, 'en cours', 'en cours'), 'wish', h('ul', null,
        bl.slice(0, 7).map(r => line(rarBadge(r.r), h('span', { class: 'grow' }, r.t),
          h('span', { class: 'tag' + (r.m ? (r.value != null && r.a > r.value ? ' bad' : ' deal') : ' bad'),
            'data-tip': r.m ? (r.value != null && r.a > r.value ? 'Tu mènes, mais ton offre dépasse la valeur (' + fmt(Math.round(r.value)) + ' ₩).' : 'Tu mènes.')
              : 'Quelqu’un est passé devant toi' + (r.value != null ? ' ; valeur ' + fmt(Math.round(r.value)) + ' ₩.' : '.') }, r.m ? 'tu mènes' : 'surenchéri'),
          h('span', { class: 'sub', 'data-tip': 'Fin de l’enchère' }, left(r.e - now)),
          auctionLink(r.i, h('b', null, fmt(r.a) + ' ₩'), 'Ouvrir l’annonce'))),
        line(h('span', { class: 'grow sub' }, fmt(s.engaged) + ' ₩ engagés pour ' + fmt(Math.round(s.value)) + ' ₩ de cartes'),
          h('b', { class: s.value - s.engaged >= 0 ? 'up' : 'down' }, (s.value - s.engaged > 0 ? '+' : '') + fmt(Math.round(s.value - s.engaged)) + ' ₩'))),
        'Les enchères où tu as fait une offre, d’après l’onglet Mes enchères du site. Le total compare tes offres à la valeur des cartes où tu mènes.'));
    }

    // ----- répartition de la valeur par rareté -----
    const byR = RARITIES.map(r => {
      const g = rowsCache.filter(x => x.rarity === r);
      return { r, n: g.reduce((a, x) => a + x.count, 0), v: g.reduce((a, x) => a + x.total, 0) };
    }).filter(x => x.n);
    const vmax = Math.max(1, ...byR.map(x => x.v));
    cards.push(card('Valeur par rareté', 'col', h('ul', null, byR.map(x => line(rarBadge(x.r),
      h('span', { class: 'grow barwrap', 'data-tip': plural(x.n, 'carte', 'cartes') + ' · ' + fmt(total ? 100 * x.v / total : 0) + ' % de la valeur' },
        h('span', { class: 'hbar r-' + x.r, style: 'width:' + Math.max(2, Math.round(100 * x.v / vmax)) + '%' })),
      h('span', { class: 'sub' }, fmt(x.n)), h('b', null, fmt(Math.round(x.v)) + ' ₩')))),
      'Ce que pèse chaque rareté dans la valeur totale. La barre est proportionnelle à la valeur ; le petit nombre, au nombre de cartes.'));

    // ----- top de la collection -----
    const top = [...rowsCache].sort((a, b) => b.value - a.value).slice(0, 8);
    cards.push(card('Mes cartes les plus chères', 'col', h('ul', null, top.map(r => line(rarBadge(r.rarity),
      h('span', { class: 'grow' }, r.title, r.starred ? ' ★' : ''), r.price ? relCell(r.price) : null,
      h('b', null, fmt(Math.round(r.value)) + ' ₩')))), 'Par valeur unitaire, y compris les cartes déjà en vente ou en favori.'));

    // ----- dernier booster -----
    const P = db.pulls, lastPull = P[P.length - 1];
    const pullAvg = P.length ? P.reduce((a, pl) => a + pl.c.reduce((s, [id]) => s + valueOf(id), 0), 0) / P.length : 0;
    cards.push(card('Dernier booster', 'pulls', lastPull
      ? h('ul', null, lastPull.c.map(([id, title, r]) => line(rarBadge(r), h('span', { class: 'grow' }, title),
        h('span', null, fmt(valueOf(id)) + ' ₩'))), line(h('span', { class: 'grow sub' }, 'ouvert ' + ago(lastPull.t) + ' · moyenne ' + fmt(pullAvg) + ' ₩ sur ' + P.length),
        h('b', null, fmt(lastPull.c.reduce((a, [id]) => a + valueOf(id), 0)) + ' ₩')))
      : none('Aucun booster enregistré : ouvre un paquet sur le site.')));

    // ----- dernières enchères -----
    const sales = A.filter(a => a[0] !== 'b').sort((x, y) => (x[7] < y[7] ? 1 : -1)).slice(0, 6);
    cards.push(card('Mes dernières ventes', 'sales', sales.length
      ? h('ul', null, sales.map(a => line(rarBadge(a[3]), h('span', { class: 'grow' }, a[2]),
        h('span', { class: 'sub' }, fmtDate(a[7])),
        a[6] == null ? h('span', { class: 'est' }, 'invendue') : h('b', null, fmt(a[6]) + ' ₩'))))
      : none('Aucune enchère en mémoire : ouvre la page Marché du site.')));

    // ----- échanges récents -----
    const T = Object.values(db.trades).filter(t => t.s === 'accepted').sort(byDateDesc).slice(0, 5);
    const tv = l => l.reduce((a, c) => { const p = priceOf(c[0], c[2]); return a + (p && p.n ? Math.max(p.med, DISCARD) : 0); }, 0);
    cards.push(card('Mes derniers échanges', 'trades', T.length
      ? h('ul', null, T.map(t => {
        const gap = tv(t.r) + t.wr - tv(t.g) - t.wg;
        return line(h('span', { class: 'grow' }, t.w), h('span', { class: 'sub' }, t.g.length + ' → ' + t.r.length + ' cartes'),
          withPrices ? h('b', { 'data-tip': 'Valeur reçue moins valeur donnée, aux prix d’aujourd’hui' }, (gap > 0 ? '+' : '') + fmt(gap) + ' ₩') : null);
      }))
      : none('Aucun échange en mémoire : ouvre la page Échanges du site.')));

    e.homeBody.replaceChildren(...cards);
  }

  // ----- onglet À vendre -----
  function sellList(rows) {
    const selling = new Set(db.market.selling || []);
    const s = db.sell;
    return (rows || rowsCache)
      .filter(r => r.price && r.price.n > 0 && r.value >= s.min && (s.favs || !r.starred) &&
        (s.doubt || r.price.rel.level > 0) && !selling.has(r.cardId))
      .sort((a, b) => (s.dupFirst ? (b.count > 1) - (a.count > 1) : 0) || b.value - a.value);
  }
  function renderSell() {
    const e = ui.el, m = db.market;
    const used = m.selling ? m.selling.length : null;
    const free = used != null && m.max ? Math.max(0, m.max - used) : null;
    if (!showPrices()) {
      e.sellInfo.textContent = '';
      e.sellTable.replaceChildren(h('div', { class: 'empty' },
        'Aucun prix connu pour l’instant. Avec un compte Pro, complète les prix dans l’onglet Collection. ' +
        'Sans compte Pro, ouvre la page Marché du site : tes propres ventes et achats serviront de prix.'));
      return;
    }
    const list = sellList();
    const top = free == null ? 0 : Math.min(free, list.length);
    const gain = list.slice(0, top).reduce((a, r) => a + Math.round(r.value), 0);
    e.sellInfo.textContent = (free == null
      ? 'Places de vente inconnues : clique sur « Actualiser mes ventes en cours » ou ouvre la page Marché. '
      : 'Ventes en cours : ' + used + ' / ' + m.max + ', soit ' + plural(free, 'place libre', 'places libres') + '. ') +
      plural(list.length, 'carte', 'cartes') + ' à vendre à partir de ' + fmt(db.sell.min) + ' ₩.' +
      (top > 1 ? ' Les ' + top + ' premières rapporteraient environ ' + fmt(gain) + ' ₩.'
        : top === 1 ? ' La première rapporterait environ ' + fmt(gain) + ' ₩.' : '');
    if (!list.length) {
      e.sellTable.replaceChildren(h('div', { class: 'empty' }, 'Aucune carte ne passe ce seuil avec les réglages actuels.'));
      return;
    }
    // Le rang et le surlignage suivent l'ordre conseillé, même quand tu tries autrement.
    const rankOf = new Map(list.map((r, i) => [r, i + 1]));
    // Prix conseillé : la médiane des ventes, toujours. Une annonce concurrente n'est qu'une indication :
    // sa mise de départ ou son offre en cours n'est pas son prix final, donc on ne s'aligne jamais dessus.
    // On signale seulement un concurrent qui a déjà reçu une offre sous la médiane.
    const advise = r => {
      const c = r.ask;
      const under = c ? c.list.filter(x => x.b && x.a < r.value) : [];
      return { p: Math.round(r.value), adj: under.length > 0, low: under.length ? Math.min(...under.map(x => x.a)) : null };
    };
    e.sellTable.replaceChildren(sortTable('sell', [
      { t: '#', asc: true, get: r => rankOf.get(r), cell: r => rankOf.get(r) },
      { t: 'Carte', left: true, asc: true, get: r => r.title.toLowerCase(),
        cell: r => [h('a', { class: 'go', href: sellLink(r.cardId), target: '_blank', rel: 'noopener',
          title: 'Ouvrir le formulaire de mise en vente sur le site' }, r.title, ' ↗'),
        r.shiny ? ' ✨' : '', r.starred ? ' ★' : '', r.count > 1 ? h('span', { class: 'tag' }, 'doublon') : null] },
      { t: 'Rareté', asc: true, get: r => rarOrder(r.rarity), cell: r => rarBadge(r.rarity) },
      { t: 'Ex.', get: r => r.count, cell: r => r.count },
      { t: 'Prix conseillé', tip: 'La médiane des ventes de la carte. Une étiquette orange signale un concurrent qui a déjà une offre en dessous.', get: r => advise(r).p, cell: r => {
        const a = advise(r);
        return [h('b', null, fmt(a.p) + ' ₩'), a.adj ? h('span', { class: 'tag warn', title: 'Un concurrent a déjà une offre à ' + fmt(a.low) +
          ' ₩, sous la médiane : ton annonce risque de partir moins cher ou de ne pas partir' }, 'concurrent à ' + fmt(a.low) + ' ₩') : null];
      } },
      { t: 'Médiane', tip: 'Médiane des 10 dernières ventes de la carte.', get: r => r.value, cell: r => fmt(Math.round(r.value)) + ' ₩' },
      { t: 'Concurrence', tip: 'Annonce la moins chère d’un autre joueur sur cette carte. Mise de départ ou offre en cours, pas un prix final. « aucune » : cherchée, rien en vente.', asc: true, get: r => (r.ask ? r.ask.a : null), cell: r => {
        if (!r.ask) return db.wishSeen[r.cardId] ? h('span', { class: 'est', title: 'Cherchée ' + ago(db.wishSeen[r.cardId]) }, 'aucune') : '—';
        return auctionLink(r.ask.i, fmt(r.ask.a) + ' ₩' + (r.ask.b ? ' •' : '') + (r.ask.list.length > 1 ? ' (' + r.ask.list.length + ')' : ''),
          r.ask.list.length > 1 ? r.ask.list.length + ' annonces, la moins chère affichée' : 'Annonce concurrente');
      } },
      { t: 'Fiabilité', tip: TIP_REL, get: r => r.price.rel.level, cell: r => relCell(r.price) },
      { t: 'Dernière vente', get: r => r.price.lastT, cell: r => fmtDate(r.price.lastT) },
      { t: 'Fourchette', get: r => r.price.max, cell: r => fmt(r.price.min) + ' à ' + fmt(r.price.max) },
      { t: 'Ventes', get: r => r.price.n, cell: r => r.price.n }
    ], list, renderSell, { rowClass: r => (rankOf.get(r) <= top ? 'top' : '') }));
  }

  // ----- onglet Boosters -----
  function renderPulls() {
    const e = ui.el, P = db.pulls;
    if (!P.length) {
      e.pullTiles.replaceChildren();
      e.pullBody.replaceChildren(h('div', { class: 'empty' },
        'Aucun booster enregistré pour l’instant. Ouvre un paquet sur le site : il sera compté ici.'));
      return;
    }
    const withPrices = showPrices();
    let nCards = 0, total = 0, best = 0;
    const byRar = {}, all = [];
    for (const pl of P) {
      let v = 0;
      for (const [id, title, r] of pl.c) {
        const x = valueOf(id);
        v += x; nCards++;
        byRar[r] = (byRar[r] || 0) + 1;
        all.push({ title, r, v: x, t: pl.t });
      }
      total += v;
      if (v > best) best = v;
    }
    e.pullTiles.replaceChildren(...[
      tile('Boosters ouverts', fmt(P.length)),
      tile('Cartes tirées', fmt(nCards)),
      withPrices ? tile('Valeur moyenne par booster', fmt(total / P.length) + ' ₩') : null,
      withPrices ? tile('Meilleur booster', fmt(best) + ' ₩') : null
    ].filter(Boolean));
    const kids = [
      h('h2', null, 'Ce que tu tires'),
      sortTable('pullRar', [
        { t: 'Rareté', asc: true, get: r => rarOrder(r), cell: r => rarBadge(r) },
        { t: 'Cartes', get: r => byRar[r], cell: r => fmt(byRar[r]) },
        { t: 'Part', get: r => byRar[r], cell: r => fmt(100 * byRar[r] / nCards) + ' %' },
        { t: 'Fréquence', asc: true, get: r => nCards / byRar[r], cell: r => '1 carte sur ' + fmt(nCards / byRar[r]) }
      ], RARITIES.concat('?').filter(r => byRar[r]), renderPulls)
    ];
    if (withPrices) {
      const bestCards = all.filter(c => c.v > DISCARD).sort((a, b) => b.v - a.v).slice(0, 50);
      if (bestCards.length) {
        kids.push(h('h2', null, 'Tes meilleurs tirages'),
          sortTable('pullBest', [
            { t: 'Carte', left: true, asc: true, get: c => c.title.toLowerCase(), cell: c => c.title },
            { t: 'Rareté', asc: true, get: c => rarOrder(c.r), cell: c => rarBadge(c.r) },
            { t: 'Valeur', get: c => c.v, cell: c => fmt(c.v) + ' ₩' },
            { t: 'Tirée le', get: c => c.t, cell: c => fmtDate(c.t) }
          ], bestCards, renderPulls, { limit: 20 }));
      }
    }
    const pullValue = pl => pl.c.reduce((a, [id]) => a + valueOf(id), 0);
    kids.push(h('h2', null, 'Derniers boosters'),
      sortTable('pullLast', [
        { t: 'Ouvert', get: pl => pl.t,
          cell: pl => new Date(pl.t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) },
        { t: 'Cartes', left: true, cell: pl => pl.c.map(([, title, r], i) => [i ? ' · ' : '', rarBadge(r), ' ', title]) },
        withPrices ? { t: 'Valeur', get: pullValue, cell: pl => fmt(pullValue(pl)) + ' ₩' } : null
      ], P.slice(-50).reverse(), renderPulls, { limit: 20 }));
    e.pullBody.replaceChildren(...kids);
  }

  // ----- onglet Amis -----
  function renderFriends() {
    const e = ui.el;
    const names = Object.keys(db.friends).sort();
    if (!names.includes(ui.friend)) ui.friend = names[0] || '';
    e.frSelect.replaceChildren(...(names.length
      ? names.map(n => h('option', { value: n, selected: n === ui.friend }, n + (db.friends[n].src === 'pool' ? ' (via le pool)' : '')))
      : [h('option', { value: '' }, 'aucun ami importé')]));
    const f = db.friends[ui.friend];
    if (e.frRemove) {
      const viaPool = !!(f && f.src === 'pool');
      e.frRemove.disabled = viaPool;
      e.frRemove.dataset.tip = viaPool ? 'Il partage sa collection par le pool : il réapparaîtrait.' : 'Oublie le fichier de cet ami.';
    }
    if (!f) {
      e.frBody.replaceChildren(h('div', { class: 'empty' },
        'Exporte ta collection et envoie le fichier à un ami. Quand il t’envoie le sien, importe-le ici pour voir qui a quoi. ' +
        'Avec le pool du groupe, c’est automatique : coche « Partager ma collection et mes souhaits avec le groupe » dans les Réglages.'));
      return;
    }
    const mine = myCards();
    if (!Object.keys(mine).length) {
      e.frBody.replaceChildren(h('div', { class: 'empty' }, 'Charge d’abord ta collection dans l’onglet Collection.'));
      return;
    }
    const withPrices = showPrices();
    const order = r => { const i = RARITIES.indexOf(r); return i < 0 ? 99 : i; };
    const sortFn = (a, b) => (b.count > 1) - (a.count > 1) || order(a.rarity) - order(b.rarity) || a.title.localeCompare(b.title);
    const keep = c => !ui.frRarity || c.rarity === ui.frRarity;
    const theirs = [], ours = [];
    let common = 0;
    for (const id in f.cards) {
      if (mine[id]) { common++; continue; }
      const c = { id, title: f.cards[id][0], rarity: f.cards[id][1], count: f.cards[id][2] };
      if (keep(c)) theirs.push(c);
    }
    for (const id in mine) {
      if (f.cards[id]) continue;
      const c = { id, title: mine[id].title, rarity: mine[id].rarity, count: mine[id].count };
      if (keep(c)) ours.push(c);
    }
    theirs.sort(sortFn); ours.sort(sortFn);
    const LIMIT = 300;
    const knownValue = c => { const p = priceOf(c.id, c.rarity); return p && p.n ? Math.max(p.med, DISCARD) : null; };
    const list = (title, items) => {
      return [h('h2', null, title + ' (' + fmt(items.length) + ')'),
        items.length ? sortTable('fr:' + title, [
          { t: 'Carte', left: true, asc: true, get: c => c.title.toLowerCase(),
            cell: c => [c.title, c.count > 1 ? h('span', { class: 'tag' }, 'doublon') : null] },
          { t: 'Rareté', asc: true, get: c => rarOrder(c.rarity), cell: c => rarBadge(c.rarity) },
          { t: 'Ex.', get: c => c.count, cell: c => c.count },
          withPrices ? { t: 'Valeur', get: knownValue, cell: c => (knownValue(c) == null ? '—' : fmt(knownValue(c)) + ' ₩') } : null
        ], items, renderFriends, { limit: LIMIT }) : h('div', { class: 'sub' }, 'Aucune.'),
        items.length > LIMIT ? h('div', { class: 'sub' }, '… et ' + fmt(items.length - LIMIT) + ' autres. Filtre par rareté pour les voir.') : null];
    };
    const dupT = theirs.filter(c => c.count > 1).length, dupO = ours.filter(c => c.count > 1).length;
    // Croisement avec les listes de souhaits : ce que tu cherches et qu'il a, ce qu'il cherche et que tu as.
    const iWant = [], theyWant = [];
    for (const id in db.wish) {
      if (!f.cards[id]) continue;
      const c = { id, title: f.cards[id][0], rarity: f.cards[id][1], count: f.cards[id][2] };
      if (keep(c)) iWant.push(c);
    }
    for (const id in (f.wish || {})) {
      if (!mine[id]) continue;
      const c = { id, title: mine[id].title, rarity: mine[id].rarity, count: mine[id].count };
      if (keep(c)) theyWant.push(c);
    }
    iWant.sort(sortFn); theyWant.sort(sortFn);
    const hasWish = Object.keys(db.wish).length > 0, friendHasWish = Object.keys(f.wish || {}).length > 0;
    // ----- tous les amis d'un coup d'œil -----
    const sumV = l => l.reduce((a, c) => a + c.v, 0);
    let overview = null;
    if (names.length > 1) {
      const rows = names.map(n => {
        const t = tradeFor(db.friends[n], mine, ui.frSingles);
        return { n, at: db.friends[n].at, gN: t.giveAll.length, gV: sumV(t.giveAll), rN: t.recvAll.length, rV: sumV(t.recvAll),
          bal: t.give.length && t.recv.length ? Math.min(t.gTot, t.rTot) : 0 };
      });
      overview = [h('h2', null, 'Tous mes amis', help('Pour chaque ami : ce que tu peux lui donner (cartes de sa liste de souhaits que tu as en double), ' +
        'ce qu’il peut te donner (cartes de ta liste qu’il a en double), et la valeur de l’échange équilibré proposé. Un clic sur une ligne ouvre cet ami.')),
      sortTable('frall', [
        { t: 'Ami', left: true, asc: true, get: r => r.n.toLowerCase(), cell: r => r.n },
        { t: 'Fichier du', get: r => r.at, cell: r => fmtDate(r.at) },
        { t: 'Tu peux lui donner', tip: 'Cartes de sa liste de souhaits que tu as en trop.', get: r => r.gN,
          cell: r => fmt(r.gN) + (withPrices && r.gN ? ' · ' + fmt(Math.round(r.gV)) + ' ₩' : '') },
        { t: 'Il peut te donner', tip: 'Cartes de ta liste de souhaits qu’il a en trop.', get: r => r.rN,
          cell: r => fmt(r.rN) + (withPrices && r.rN ? ' · ' + fmt(Math.round(r.rV)) + ' ₩' : '') },
        withPrices ? { t: 'Échange équilibré', tip: 'Valeur de chaque côté de l’échange proposé. 0 : aucune carte possible dans un des deux sens.',
          get: r => r.bal, cell: r => (r.bal ? fmt(Math.round(r.bal)) + ' ₩' : '—') } : null
      ], rows, renderFriends, { canClick: () => true, rowClass: r => (r.n === ui.friend ? 'top' : ''),
        onRow: r => { ui.friend = r.n; renderFriends(); } })];
    }
    // ----- échange proposé avec l'ami choisi -----
    const T = tradeFor(f, mine, ui.frSingles);
    const what = ui.frSingles ? '' : ' en double';
    const side = (title, tipText, items, tot, empty) => h('div', { class: 'card' },
      h('h2', null, h('span', null, title, help(tipText))),
      items.length ? h('ul', null, items.map(c => h('li', null, rarBadge(c.rarity), h('span', { class: 'grow' }, c.title),
        c.count > 1 ? h('span', { class: 'tag' }, '×' + c.count) : null,
        withPrices ? h('b', c.unknown ? { class: 'est', 'data-tip': 'Prix pas encore relevé : compté 1 ₩.' } : null, fmt(Math.round(c.v)) + ' ₩') : null)))
        : h('div', { class: 'sub' }, empty),
      withPrices && items.length ? h('div', { class: 'tot' }, h('span', null, 'Total'), h('span', null, fmt(Math.round(tot)) + ' ₩')) : null);
    const gap = T.rTot - T.gTot;
    let verdict;
    if (!T.give.length && !T.recv.length) verdict = null;
    else if (!T.give.length) verdict = 'Tu n’as aucune carte de sa liste' + what + ' : propose-lui des wikibidous contre ces cartes.';
    else if (!T.recv.length) verdict = 'Il n’a aucune carte de ta liste' + what + ' : propose-lui ces cartes contre des wikibidous.';
    else if (!withPrices) verdict = 'Prix inconnus : l’équilibre n’est pas calculé.';
    else if (Math.abs(gap) <= Math.max(2, 0.1 * Math.max(T.gTot, T.rTot))) verdict = 'Échange équilibré : ' + fmt(Math.round(T.gTot)) + ' ₩ contre ' + fmt(Math.round(T.rTot)) + ' ₩.';
    else if (gap > 0) verdict = 'Tu reçois ' + fmt(Math.round(gap)) + ' ₩ de plus que tu ne donnes : ajoute ' + fmt(Math.round(gap)) + ' wikibidous de ton côté pour équilibrer.';
    else verdict = 'Tu donnes ' + fmt(Math.round(-gap)) + ' ₩ de plus que tu ne reçois : demande ' + fmt(Math.round(-gap)) + ' wikibidous en retour.';
    const left = T.giveAll.length - T.give.length + T.recvAll.length - T.recv.length;
    const proposal = [
      h('h2', null, 'Échange proposé avec ' + ui.friend, help('Ce qu’il cherche et que tu as' + what + ', contre ce que tu cherches et qu’il a' + what +
        '. Le script garde le plus de cartes possible tout en équilibrant la valeur des deux côtés. Tes favoris ★ ne sont jamais proposés. ' +
        'Rien n’est envoyé : à toi de proposer l’échange sur le site.')),
      !hasWish || !friendHasWish
        ? h('div', { class: 'sub' }, !hasWish ? 'Charge ta liste de souhaits (onglet Souhaits) pour voir ce qu’il peut te donner.'
          : 'Le fichier de ' + ui.friend + ' ne contient pas sa liste de souhaits : demande-lui d’exporter à nouveau.')
        : null,
      hasWish || friendHasWish ? h('div', { class: 'trade' },
        side('Tu donnes', 'Cartes de la liste de souhaits de ' + ui.friend + ' que tu as' + what + '. Le ×N est ton nombre d’exemplaires.',
          T.give, T.gTot, friendHasWish ? 'Aucune carte de sa liste' + what + ' chez toi.' : '—'),
        side('Tu reçois', 'Cartes de ta liste de souhaits que ' + ui.friend + ' a' + what + '. Le ×N est son nombre d’exemplaires.',
          T.recv, T.rTot, hasWish ? 'Aucune carte de ta liste' + what + ' chez lui.' : '—')) : null,
      verdict ? h('div', { class: 'balance' }, verdict,
        left > 0 ? h('div', { class: 'sub' }, plural(left, 'autre carte possible a été laissée de côté', 'autres cartes possibles ont été laissées de côté') + ' pour équilibrer : voir les listes plus bas.') : null) : null];
    e.frBody.replaceChildren(...[
      overview,
      h('div', { class: 'tiles' },
        tile('En commun', fmt(common)),
        tile('Ses doublons qui te manquent', fmt(dupT)),
        tile('Tes doublons qui lui manquent', fmt(dupO)),
        tile('Tes souhaits dans sa collection', hasWish ? fmt(iWant.length) : '—', hasWish ? null : 'charge ta liste dans l’onglet Souhaits'),
        tile('Ses souhaits dans ta collection', friendHasWish ? fmt(theyWant.length) : '—', friendHasWish ? null : 'son fichier ne contient pas de liste')),
      h('div', { class: 'sub' }, 'Collection de ' + ui.friend + ' exportée le ' + fmtDate(f.at) + '. Les doublons sont en tête : ce sont les échanges les plus faciles.'),
      proposal,
      hasWish ? list('Sur ta liste de souhaits, chez ' + ui.friend, iWant) : null,
      friendHasWish ? list(ui.friend + ' les cherche, et tu les as', theyWant) : null,
      list('Chez ' + ui.friend + ', pas chez toi', theirs),
      list('Chez toi, pas chez ' + ui.friend, ours)
    ].flat(2).filter(Boolean));
  }

  function exportCsv() {
    refresh();
    const cell = v => {
      const s = v == null ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v);
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['Carte', 'Rareté', 'Exemplaires', 'Shiny', 'ATK', 'DEF', 'Q-Score', 'Vues 30j', 'Catégorie', 'Étiquettes',
      'Valeur', 'Sans vente connue', 'Fiabilité', 'Tendance', 'Moyenne', 'Dernière vente', 'Date dernière vente', 'Min', 'Max',
      'Nb ventes', 'Valeur totale', 'Conseil', 'En vente à', 'Prix relevé le', 'Obtenue le', 'Wikipédia'];
    const lines = visibleRows().map(r => {
      const p = r.price || {};
      const sold = p.n > 0;
      return [r.title, r.rarity, r.count, r.shiny ? 'oui' : 'non', r.atk, r.def, r.q, r.views, r.cat, r.tags.join(', '),
        r.value, r.est ? 'oui' : 'non', sold ? REL[p.rel.level] : '', sold ? (p.trend > 0 ? 'hausse' : p.trend < 0 ? 'baisse' : 'stable') : '',
        p.avg, p.last, sold ? fmtDate(p.lastT) : '', p.min, p.max, p.n, r.total, r.price ? advice(r.price).text : '',
        r.ask ? r.ask.a : '', p.at ? fmtDate(p.at) : '', r.obtained ? fmtDate(r.obtained) : '', r.url].map(cell).join(';');
    });
    // Le caractère 65279 en tête de fichier fait reconnaître les accents par Excel.
    download('wikimasters-collection-' + new Date().toISOString().slice(0, 10) + '.csv',
      String.fromCharCode(65279) + [head.join(';'), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
  }

  function clearPrices() {
    if (job.running) return;
    db.prices = {};
    saveDb();
    setStatus('Prix oubliés. La collection est conservée.');
    refresh();
  }

  // ---------- raccourci vers la mise en vente ----------
  // Le site n'a pas d'adresse pour mettre une carte en vente : le formulaire s'ouvre depuis la carte, page Collection.
  // Un lien « /collection#wm-sell=<carte> » fait ces gestes à ta place : chercher la carte, l'ouvrir,
  // cliquer « Mettre aux enchères ». Le script s'arrête au formulaire : mise de départ, durée et
  // « Lancer l'enchère » restent à toi.
  const sellLink = cardId => '/collection#wm-sell=' + encodeURIComponent(cardId);
  async function openSellForm() {
    const m = /^#wm-sell=([^&]+)$/.exec(location.hash);
    if (!m || location.pathname !== '/collection') return;
    const cardId = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    const card = Object.values(db.cards).find(c => c.cardId === cardId);
    if (!card) return;
    const until = async (fn, ms) => {
      for (let t = 0; t < ms; t += 200) { const v = fn(); if (v) return v; await sleep(200); }
      return null;
    };
    const mine = el => !el.closest('#wm-stats-host');
    const input = await until(() => [...document.querySelectorAll('input')].find(i => mine(i) && /Rechercher/i.test(i.placeholder || '')), 10000);
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, card.title);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const title = await until(() => [...document.querySelectorAll('h3')].find(h => mine(h) && h.textContent.trim() === card.title), 8000);
    if (!title) return;
    const sellBtn = () => [...document.querySelectorAll('button')].find(b => mine(b) && /Mettre aux enchères/.test(b.textContent));
    // Le clic se fait sur la carte, quelques niveaux au-dessus du titre ; on remonte jusqu'à ce que la fiche s'ouvre.
    let el = title;
    for (let i = 0; i < 5 && el && !sellBtn(); i++, el = el.parentElement) {
      el.click();
      await until(sellBtn, 700);
    }
    const btn = sellBtn();
    if (btn) btn.click();
  }
  window.addEventListener('hashchange', () => openSellForm());

  // Chaque minute, les enchères observées qui viennent de finir deviennent des prix.
  // Toutes les minutes : les enchères suivies qui viennent de finir, et le temps restant de tes ventes en cours si l'onglet
  // Mes ventes est affiché (une annonce terminée sort des tuiles sans attendre une nouvelle réponse du Marché).
  function minuteTick() {
    if (!job.running && settleObserved()) { saveDb(); refresh(); return; }
    if (ui.open && ui.tab === 'sales' && db.selling && db.selling.length) renderSales();
  }
  // Rien avant le chargement des données.
  setInterval(() => { if (store.loaded) minuteTick(); }, 60000);
  setInterval(() => { if (store.loaded && autoDue(Date.now())) autoRun(); }, 60000);
  setInterval(() => { if (store.loaded) poolTick(Date.now()); }, POOL_FLUSH_EVERY);

  // ---------- valeur affichée sur les cartes du site ----------
  // Une pastille sur chaque carte que le site affiche : Collection, Marché, Toutes les cartes, boosters…
  // Lecture seule : le script pose un petit élément par-dessus la carte, il ne clique sur rien.
  // Sur le Marché, la carte est reconnue par son annonce ; ailleurs, par son titre (le texte de son image).
  const BADGE = 'wmstats-badge';
  let titleIdx = null, scanTimer = 0;
  function cardByTitle(t) {
    if (seenTitle.has(t)) return seenTitle.get(t);
    if (!titleIdx) {
      titleIdx = new Map();
      const add = (id, title) => { if (okKey(id) && typeof title === 'string' && !titleIdx.has(title)) titleIdx.set(title, id); };
      for (const c of Object.values(db.cards)) add(c.cardId, c.title);
      for (const id in db.wish) add(id, db.wish[id][0]);
      for (const p of db.pulls) for (const c of p.c || []) add(c[0], c[1]);
      for (const a of Object.values(db.auctions)) add(a[1], a[2]);
      for (const t of Object.values(db.trades)) for (const c of (t.g || []).concat(t.r || [])) add(c[0], c[1]);
      for (const n in db.friends) {
        const f = db.friends[n];
        for (const id in f.cards || {}) add(id, f.cards[id][0]);
        for (const id in f.wish || {}) add(id, f.wish[id][0]);
      }
    }
    return titleIdx.get(t) || null;
  }
  function auctionInfo(id) {
    if (seenAuction.has(id)) return seenAuction.get(id);
    const o = db.obs[id];
    if (o) return { c: o[0], a: o[1], b: !!o[2], r: o[5] };
    for (const cid in db.market.asks) {
      const x = (db.market.asks[cid].list || []).find(y => y.i === id);
      if (x) return { c: cid, a: x.a, b: x.b, r: x.r };
    }
    return null;
  }
  // L'annonce d'une carte affichée : celle de son lien vers le Marché. Sur la page d'une enchère, la carte sans lien est celle
  // mise en vente : sans cela, la pastille la jugeait à la rareté d'un autre exemplaire (le tien, ou celui vu ailleurs).
  function auctionFor(link, title) {
    if (link) return auctionInfo(link.getAttribute('href').split('/')[2]);
    const m = location.pathname.match(/^\/marketplace\/([0-9a-f-]{36})$/);
    const au = m ? auctionInfo(m[1]) : null;
    const byTitle = title ? cardByTitle(title) : null;
    return au && (!title || au.c === byTitle) ? au : null;
  }
  function overlaySoon() {
    titleIdx = null;
    if (!scanTimer) scanTimer = setTimeout(scanCards, 250);
  }
  // Contenu de la pastille d'une carte. au = l'annonce quand la carte est affichée sur le Marché.
  // flag : 'dim' pour une annonce trop chère à griser, 'glow' pour une bonne affaire à faire ressortir.
  const BG_DEAL = 'rgba(6,95,70,.92)', BG_BAD = 'rgba(127,29,29,.92)', BG_UP = 'rgba(30,64,175,.92)';
  function badgeFor(cardId, au, mine) {
    // Une annonce se juge à la valeur de la rareté de son exemplaire.
    const p = au && rarOk(au.r) ? priceOf(cardId, au.r) : priceOf(cardId);
    if (!p) return null;
    const have = ov('have') ? mine[cardId] : null;
    const lines = [];
    let text, border = '#6b7280', bg = 'rgba(10,15,13,.85)', flag = null;
    if (!p.n) {
      text = '1 ₩';
      lines.push('Aucune vente connue : la carte vaut la défausse, 1 ₩.');
    } else {
      const med = Math.max(p.med, DISCARD), mx = maxBid(p);
      text = (p.rel.level === 0 ? '≈ ' : '') + fmt(Math.round(med)) + ' ₩';
      border = ['#6b7280', '#f59e0b', '#10b981'][p.rel.level];
      lines.push('Valeur médiane : ' + fmt(Math.round(med)) + ' ₩ (' + plural(p.n, 'vente', 'ventes') + (p.obs ? (p.exact ? ' relevées sur le marché' : ' observées') : '') + (p.by ? ', relevé partagé par ' + p.by : '') + (p.mixed ? ', ventes d’autres raretés' : p.r ? ', en ' + p.r : '') + ', fiabilité ' + REL[p.rel.level].toLowerCase() + ')');
      if (au && au.a != null) {
        lines.push('Prix de l’annonce : ' + fmt(au.a) + ' ₩' + (au.m ? ' (ton offre, tu mènes)' : au.bid ? ' (quelqu’un est passé devant toi)' : au.b ? ' (offre déjà faite)' : ' (mise de départ)'));
        if (au.s) {
          // Le site ne dit pas, dans l'historique des ventes, lesquelles étaient shiny : pas de comparaison possible.
          text += ' · ✦';
          lines.push('Carte shiny : le site ne distingue pas les ventes shiny, la valeur affichée est celle d’une carte normale.');
        } else if (au.bid && !au.m && ov('outbid')) {
          if (mx > au.a) {
            text += ' · ↑ ' + fmt(mx) + ' ₩'; bg = BG_UP;
            lines.push('Tu as été surenchéri. Tu peux encore monter jusqu’à ' + fmt(mx) + ' ₩ (marge ' + fmt(mx - au.a) + ' ₩).');
          } else {
            text += ' · laisse filer'; bg = BG_BAD;
            lines.push('Tu as été surenchéri, et l’enchère dépasse déjà la valeur : mieux vaut laisser filer.');
          }
        } else {
          lines.push('Enchère max conseillée : ' + fmt(mx) + ' ₩' + (mx > au.a ? ', marge ' + fmt(mx - au.a) + ' ₩' : ' : déjà atteinte'));
          const pct = au.own ? 0 : dealPct(au, p);
          if (pct) {
            lines.push('Bonne affaire : ' + pct + ' % sous la valeur.');
            if (ov('cmp')) { text += ' · −' + pct + ' %'; bg = BG_DEAL; }
            if (ov('glow')) flag = 'glow';
          } else if (!au.own && au.a >= med) {
            if (ov('cmp')) { text += ' · trop cher'; bg = BG_BAD; }
            if (ov('dim') && !au.bid) flag = 'dim';
          }
        }
      } else {
        lines.push('Enchère max conseillée : ' + fmt(mx) + ' ₩');
      }
    }
    if (have) { text += ' ✓'; lines.push('Tu l’as déjà' + (have.count > 1 ? ' (' + have.count + ' exemplaires)' : '') + '.'); }
    return { text, border, bg, lines, flag, sales: p.n ? p.sales : null, med: p.n ? Math.max(p.med, DISCARD) : 0 };
  }
  function scanCards() {
    scanTimer = 0;
    const on = db.overlay !== false && showPrices();
    const keep = new Set();
    flagged.clear();
    if (on) {
      const mine = myCards();
      for (const card of document.querySelectorAll('.rounded-2xl.cursor-pointer')) {
        // Le titre est dans le h3 de la carte ; à défaut, dans le texte de l'image (sauf le logo des cartes sans image).
        const h3 = card.querySelector('h3'), img = card.querySelector('img[alt]:not([alt=""]):not([alt="WikiMasters"])');
        const title = ((h3 && h3.textContent) || (img && img.alt) || '').trim();
        const link = card.closest('a[href^="/marketplace/"]');
        if (!title && !link) continue;
        const au = auctionFor(link, title);
        const cardId = au ? au.c : title ? cardByTitle(title) : null;
        if (cardId && !priceOf(cardId)) poolWant(cardId); // le groupe la connaît peut-être
        const b = cardId ? badgeFor(cardId, au, mine) : null;
        let el = card.querySelector(':scope > .' + BADGE);
        if (!b) { if (el) el.remove(); continue; }
        keep.add(card);
        if (b.flag) flagged.set(card, b.flag);
        const native = !ov('tip');
        const key = cardId + '|' + b.text + '|' + b.bg + '|' + b.border + '|' + b.lines.join('/') + '|' + native;
        if (el && el.dataset.key === key) continue;
        if (!el) {
          el = document.createElement('span');
          el.className = BADGE;
          if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
          card.append(el);
        }
        el.dataset.key = key;
        el.textContent = b.text;
        tipData.set(el, b);
        // Bulle détaillée (la nôtre) ou bulle simple du navigateur, selon le réglage.
        if (native) el.title = 'WikiMasters Stats\n' + b.lines.join('\n'); else el.removeAttribute('title');
        el.style.cssText = 'position:absolute;top:6px;right:6px;z-index:40;padding:1px 7px;border-radius:999px;' +
          'font:700 11px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;white-space:nowrap;pointer-events:auto;cursor:help;' +
          'box-shadow:0 1px 4px rgba(0,0,0,.6);background:' + b.bg + ';border:1.5px solid ' + b.border;
      }
    }
    for (const el of document.querySelectorAll('.' + BADGE)) if (!keep.has(el.parentElement)) el.remove();
    for (const [cls, f] of [['wmstats-dim', 'dim'], ['wmstats-glow', 'glow']]) {
      for (const el of document.querySelectorAll('.' + cls)) if (flagged.get(el) !== f) el.classList.remove(cls);
      for (const [el, v] of flagged) if (v === f && !el.classList.contains(cls)) el.classList.add(cls);
    }
    if (tipEl && tipFor && !tipFor.isConnected) hideTip();
    scanTrades(ov('trade') && showPrices());
  }

  // ---------- styles posés dans la page du site : cartes grisées, bonnes affaires, bulle, valeur des échanges ----------
  const PAGE_CSS = `
.wmstats-dim{opacity:.35;filter:grayscale(.8);transition:opacity .15s,filter .15s}
.wmstats-dim:hover{opacity:1;filter:none}
.wmstats-glow{box-shadow:0 0 0 2px #10b981,0 0 18px rgba(16,185,129,.55)!important}
#wmstats-tip{position:fixed;z-index:2147483646;display:none;width:max-content;max-width:300px;padding:8px 10px;border-radius:10px;
  background:#0b1210;color:#d1d5db;border:1px solid #23332c;box-shadow:0 8px 24px rgba(0,0,0,.6);
  font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:none;text-align:left}
#wmstats-tip .h{font-weight:700;color:#34d399;margin-bottom:3px}
#wmstats-tip .l{margin:1px 0}
#wmstats-tip .s{margin-top:6px;color:#9ca3af;font-size:11px}
#wmstats-tip svg{display:block;margin-top:2px}
.wmstats-tv{display:block;margin-top:6px;font:600 12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#d1d5db;text-align:left}
.wmstats-tvbar{flex-shrink:0;margin-left:6px;padding:1px 8px;border-radius:999px;background:rgba(16,185,129,.12);
  border:1px solid rgba(16,185,129,.35);color:#d1d5db;font:600 12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap}
.wmstats-tv .g,.wmstats-tvbar .g{color:#34d399}.wmstats-tv .r,.wmstats-tvbar .r{color:#f87171}
`;
  const flagged = new Map();
  const tipData = new WeakMap();
  let tipEl = null, tipFor = null;
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // Petite courbe des dernières ventes, de la plus ancienne à la plus récente, avec la médiane en pointillés.
  // Une vente très au-dessus du lot est écrêtée à 3 fois la médiane, pour que les autres restent lisibles.
  function sparkline(sales, med) {
    const NS = 'http://www.w3.org/2000/svg', W = 270, H = 46, pad = 4;
    const v = sales.slice().reverse().map(s => s.p);
    const top = Math.max(1, Math.min(Math.max(...v), med * 3)), bottom = Math.min(...v, med);
    const x = i => pad + (v.length > 1 ? i * (W - 2 * pad) / (v.length - 1) : (W - 2 * pad) / 2);
    const y = p => H - pad - (Math.min(p, top) - bottom) / Math.max(1, top - bottom) * (H - 2 * pad);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    const line = (attrs) => { const e = document.createElementNS(NS, attrs.tag); delete attrs.tag; for (const k in attrs) e.setAttribute(k, attrs[k]); svg.append(e); };
    line({ tag: 'line', x1: pad, x2: W - pad, y1: y(med), y2: y(med), stroke: '#f59e0b', 'stroke-width': 1, 'stroke-dasharray': '3 3' });
    if (v.length > 1) line({ tag: 'polyline', points: v.map((p, i) => x(i) + ',' + y(p)).join(' '), fill: 'none', stroke: '#10b981', 'stroke-width': 1.6 });
    v.forEach((p, i) => line({ tag: 'circle', cx: x(i), cy: y(p), r: 2.2, fill: p > top ? '#f87171' : '#34d399' }));
    return svg;
  }
  function showTip(el) {
    const b = tipData.get(el);
    if (!b) return;
    if (!tipEl) { tipEl = mk('div'); tipEl.id = 'wmstats-tip'; document.body.append(tipEl); }
    tipFor = el;
    const kids = [mk('div', 'h', 'WikiMasters Stats'), ...b.lines.map(t => mk('div', 'l', t))];
    if (b.sales && b.sales.length > 1) {
      const v = b.sales.map(s => s.p);
      kids.push(mk('div', 's', plural(v.length, 'dernière vente', 'dernières ventes') + ' · de ' + fmt(Math.min(...v)) + ' à ' + fmt(Math.max(...v)) + ' ₩ · médiane en pointillés'),
        sparkline(b.sales, b.med));
    }
    tipEl.replaceChildren(...kids);
    tipEl.style.display = 'block';
    const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, hgt = tipEl.offsetHeight;
    tipEl.style.left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8) + 'px';
    let y = r.bottom + 6;
    if (y + hgt > window.innerHeight - 8) y = Math.max(8, r.top - hgt - 6);
    tipEl.style.top = y + 'px';
  }
  function hideTip() { tipFor = null; if (tipEl) tipEl.style.display = 'none'; }

  // ---------- valeur des échanges sur la page Échanges du site ----------
  // Lecture seule : le script ajoute une ligne de texte, il ne touche ni aux cartes choisies ni aux boutons.
  const cardVal = id => { const p = id ? priceOf(id) : null; return p ? (p.n ? Math.max(p.med, DISCARD) : DISCARD) : null; };
  const wbIn = t => { const m = /(\d[\d\s ]*)\s*(?:wb|wikibidous?)\b/i.exec(t || ''); return m ? Number(m[1].replace(/\D/g, '')) : 0; };
  function tradeLine(give, recv, cls, unk) {
    const gap = Math.round(recv - give);
    const el = mk('span', cls);
    el.append('≈ ' + fmt(Math.round(give)) + ' ₩ donnés · ' + fmt(Math.round(recv)) + ' ₩ reçus · ',
      mk('b', gap > 0 ? 'g' : gap < 0 ? 'r' : '', (gap > 0 ? '+' : gap < 0 ? '−' : '') + fmt(Math.abs(gap)) + ' ₩ pour toi'),
      unk ? ' · ' + plural(unk, 'carte sans prix', 'cartes sans prix') : '');
    el.title = 'WikiMasters Stats : valeur médiane des cartes, aux prix connus aujourd’hui, wikibidous compris. ' +
      'Une carte sans vente connue compte pour 1 ₩ ; une carte jamais relevée n’est pas comptée.';
    return el;
  }
  function putLine(parent, cls, el) {
    const key = el.textContent;
    let cur = parent.querySelector(':scope > .' + cls);
    if (cur && cur.dataset.key === key) return;
    el.dataset.key = key;
    if (cur) cur.replaceWith(el); else parent.append(el);
  }
  const comp = { bar: null, give: new Map(), recv: new Map() };
  function scanTrades(on) {
    if (!on) { for (const el of document.querySelectorAll('.wmstats-tv,.wmstats-tvbar')) el.remove(); return; }
    // 1. Échanges déjà proposés (Reçues, Envoyées, Historique) : deux colonnes de cartes par échange.
    const boxes = new Map();
    for (const p of document.querySelectorAll('p')) {
      const t = p.textContent.trim();
      if (t.length > 60 || !/^(Vous offrez|En échange de|.+ offre)$/.test(t)) continue;
      const box = p.closest('button');
      if (!box || box.closest('#wm-stats-host')) continue;
      if (!boxes.has(box)) boxes.set(box, []);
      boxes.get(box).push({ t, col: p.parentElement });
    }
    for (const [box, cols] of boxes) {
      if (cols.length !== 2) continue;
      const role = c => (c.t === 'Vous offrez' ? 'g' : c.t === 'En échange de' ? '' : 'r');
      let r0 = role(cols[0]), r1 = role(cols[1]);
      if (!r0) r0 = r1 === 'g' ? 'r' : 'g';
      if (!r1) r1 = r0 === 'g' ? 'r' : 'g';
      if (r0 === r1) continue;
      const tot = { g: 0, r: 0 };
      let unk = 0;
      [[cols[0], r0], [cols[1], r1]].forEach(([c, r]) => {
        for (const s of c.col.querySelectorAll('span[title]')) {
          const v = cardVal(cardByTitle(s.title.trim()));
          if (v == null) unk++; else tot[r] += v;
        }
        tot[r] += wbIn(c.col.textContent);
      });
      putLine(box, 'wmstats-tv', tradeLine(tot.g, tot.r, 'wmstats-tv', unk));
    }
    // 2. Fenêtre « Échanger avec … » : les cartes choisies de chaque côté, au fur et à mesure.
    const me = [...document.querySelectorAll('span.truncate')].find(s => /^Moi\s*:/.test(s.textContent.trim()) && !s.closest('#wm-stats-host'));
    if (!me) { comp.bar = null; return; }
    const bar = me.parentElement;
    if (comp.bar !== bar) { comp.bar = bar; comp.give.clear(); comp.recv.clear(); }
    const spans = [...bar.children].filter(s => s.tagName === 'SPAN' && !s.classList.contains('wmstats-tvbar'));
    const meTxt = spans[0] ? spans[0].textContent : '', otTxt = spans[1] ? spans[1].textContent : '';
    let modal = bar;
    while (modal && !modal.querySelector('button[class*="border-b-2"]')) modal = modal.parentElement;
    if (modal) {
      const tab = [...modal.querySelectorAll('button[class*="border-b-2"]')].find(b => /^(Mes cartes|Cartes de)/.test(b.textContent.trim()));
      const side = tab ? (/^Mes cartes/.test(tab.textContent.trim()) ? comp.give : comp.recv) : null;
      // Le site regroupe les cartes choisies de l'onglet ouvert sous « Sélectionnées (n) ».
      const lab = side && [...modal.querySelectorAll('p,span,div,h2,h3,h4')].find(x => x.childElementCount === 0 && /^Sélectionnées\s*\(\d+\)$/.test(x.textContent.trim()));
      if (side) {
        side.clear();
        if (lab) for (const h3 of lab.parentElement.querySelectorAll('h3')) { const t = h3.textContent.trim(); side.set(t, cardByTitle(t)); }
      }
    }
    const count = t => { const m = /:\s*(\d+)\s*carte/.exec(t); return m ? Number(m[1]) : 0; };
    if (!count(meTxt)) comp.give.clear();
    if (!count(otTxt)) comp.recv.clear();
    let unk = 0;
    const sum = mp => { let s = 0; for (const id of mp.values()) { const v = cardVal(id); if (v == null) unk++; else s += v; } return s; };
    const g = sum(comp.give) + wbIn(meTxt), r = sum(comp.recv) + wbIn(otTxt);
    putLine(bar, 'wmstats-tvbar', tradeLine(g, r, 'wmstats-tvbar', unk));
  }

  function startOverlay() {
    const st = document.createElement('style');
    st.textContent = PAGE_CSS;
    (document.head || document.documentElement).append(st);
    // Nos propres ajouts (pastilles, bulle, lignes de valeur) ne relancent pas d'analyse.
    const OURS = '.' + BADGE + ',.wmstats-tv,.wmstats-tvbar,#wmstats-tip';
    const ours = n => n.nodeType === 1 && !!n.matches && n.matches(OURS);
    new MutationObserver(muts => {
      if (muts.every(m => (m.target.closest && m.target.closest(OURS)) ||
        (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(ours)))) return;
      if (!scanTimer) scanTimer = setTimeout(scanCards, 300);
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['alt', 'href', 'class'] });
    document.addEventListener('mouseover', ev => {
      const el = ev.target && ev.target.closest ? ev.target.closest('.' + BADGE) : null;
      if (el && !el.title) { if (el !== tipFor) showTip(el); } else if (tipFor) hideTip();
    }, true);
    window.addEventListener('scroll', () => { if (tipFor) hideTip(); }, true);
    overlaySoon();
  }

  const start = () => whenReady(() => { if (settleObserved()) saveDb(); mount(); openSellForm(); startOverlay(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
