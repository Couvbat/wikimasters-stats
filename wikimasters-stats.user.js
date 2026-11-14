// ==UserScript==
// @name         WikiMasters – Stats de collection
// @namespace    wm-stats
// @version      1.10.0
// @description  Valeur de ta collection WikiMasters, cartes à vendre, bilan de tes ventes, liste de souhaits, stats de boosters, comparaison entre amis. Lecture seule : ne joue pas, n'ouvre rien, n'échange rien.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
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
  const MARKET_PAGES = 4;   // pages d'enchères lues par « Relever le marché »
  const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const nativeFetch = window.fetch.bind(window);

  // ---------- stockage local (reste dans ton navigateur) ----------
  function defaults() {
    return {
      cards: {}, prices: {}, pro: {}, userId: '', collectionAt: 0, autoPull: true,
      pulls: [], mySales: {}, market: { at: 0, max: 0, selling: null, asks: {} },
      auctions: {}, history: {}, wish: {}, wishAt: 0, alerts: {}, wishSeen: {},
      obs: {}, obsSales: {}, obsRar: {}, trades: {}, tradesAt: 0,
      friends: {}, me: '', sell: { min: 10, favs: false, doubt: false }
    };
  }
  const MAX_AUCTIONS = 3000; // enchères personnelles gardées en mémoire
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const okKey = k => typeof k === 'string' && k.length > 0 && k.length <= 80 && !BAD_KEYS.has(k);
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const safeUrl = u => (typeof u === 'string' && /^https?:\/\//.test(u) ? u.slice(0, 500) : '');
  let db = loadDb();
  function loadDb() {
    const base = defaults();
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && typeof d === 'object' && d.cards && d.prices) {
        Object.assign(base, d);
        base.market = Object.assign(defaults().market, d.market || {});
        base.sell = Object.assign(defaults().sell, d.sell || {});
        if (!Array.isArray(base.pulls)) base.pulls = [];
        for (const k of ['auctions', 'history', 'wish', 'friends', 'mySales', 'alerts', 'wishSeen', 'obs', 'obsSales', 'obsRar', 'trades']) {
          if (!isObj(base[k])) base[k] = {};
        }
      }
    } catch (e) {}
    return base;
  }
  // Un autre onglet du site a enregistré des données : on les reprend pour ne pas les écraser.
  window.addEventListener('storage', ev => {
    if (ev.key === KEY && !job.running) { db = loadDb(); refresh(); }
  });
  function saveDb() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {
      // Plus de place : on sacrifie le relevé du marché, qui se refait en un clic.
      try { db.market.asks = {}; localStorage.setItem(KEY, JSON.stringify(db)); } catch (e2) {}
    }
  }
  const byDateDesc = (a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0);
  const rarOf = r => (typeof r === 'string' && /^[A-Z]{1,3}$/.test(r) ? r : '?');

  function ingestCollection(items, replace) {
    if (!Array.isArray(items)) return;
    if (replace) db.cards = {};
    for (const it of items) {
      const c = it && it.card;
      if (!c || !c.id) continue;
      if (it.user_id) db.userId = it.user_id;
      db.cards[it.id || c.id] = {
        cardId: c.id,
        title: c.wikipedia_title || '?',
        rarity: rarOf(c.rarity),
        atk: c.atk, def: c.def, q: c.q_score, views: c.pageviews,
        cat: c.category || '', url: safeUrl(c.wikipedia_url),
        count: it.count || 1, shiny: !!it.is_shiny, starred: !!it.starred,
        tags: (it.tags || []).map(t => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean),
        obtained: it.obtained_at || ''
      };
    }
    db.collectionAt = Date.now();
    saveDb();
    // Un chargement complet donne une photo fiable du jour ; une page isolée, non.
    if (replace) { priceCache = new Map(); snapshot(buildRows()); }
    refresh();
  }

  // Liste de souhaits : les cartes pour lesquelles tu as demandé une alerte sur la page « Toutes les cartes ».
  function ingestWish(j, replace) {
    if (!j || !Array.isArray(j.cards)) return;
    if (replace) db.wish = {};
    for (const c of j.cards) if (c && okKey(c.id)) db.wish[c.id] = [str(c.wikipedia_title || '?', 200), rarOf(c.rarity)];
    db.wishAt = Date.now();
    saveDb();
    refresh();
  }

  // Tes enchères passées, accumulées au fil des passages : le site ne renvoie que les plus récentes.
  // Chaque entrée : [type, carte, titre, rareté, mise de départ d'origine, mise finale, prix final ou null, date]
  // type : s = vendue, u = invendue, b = achetée
  function recordAuction(a, kind) {
    if (!a || !okKey(a.id) || !okKey(a.card_id)) return;
    const c = a.card || {};
    db.auctions[a.id] = [kind, a.card_id, str(c.wikipedia_title || '?', 200), rarOf(a.snapshot_rarity || c.rarity),
      num(a.listing_base_amount != null ? a.listing_base_amount : a.base_amount), num(a.base_amount),
      typeof a.final_price === 'number' ? a.final_price : null, str(a.settled_at || a.end_at, 40)];
  }
  function tidyAuctions() {
    const ids = Object.keys(db.auctions);
    if (ids.length > MAX_AUCTIONS) {
      ids.sort((x, y) => (db.auctions[x][7] < db.auctions[y][7] ? -1 : 1))
        .slice(0, ids.length - MAX_AUCTIONS).forEach(id => delete db.auctions[id]);
    }
    const mine = {};
    for (const a of Object.values(db.auctions)) {
      if (a[6] == null || !okKey(a[1])) continue;
      (mine[a[1]] = mine[a[1]] || []).push({ p: a[6], t: a[7] });
    }
    for (const id in mine) mine[id] = mine[id].sort(byDateDesc).slice(0, 10);
    db.mySales = mine;
  }

  function ingestSales(cardId, j) {
    if (!j || typeof j !== 'object') return;
    const src = Array.isArray(j.recent) && j.recent.length ? j.recent : (j.sales || []);
    const sales = src
      .filter(s => s && typeof s.final_price === 'number')
      .map(s => ({ p: s.final_price, t: s.settled_at || '' }))
      .sort(byDateDesc)
      .slice(0, 10);
    db.prices[cardId] = { at: Date.now(), sales };
    saveDb();
    refresh();
  }

  // Page Marché : enchères en cours, tes ventes en cours, et ton propre historique de ventes et d'achats.
  function ingestMarket(j) {
    if (!j || typeof j !== 'object') return;
    const m = db.market, now = Date.now();
    if (typeof j.maxConcurrentAuctions === 'number') m.max = j.maxConcurrentAuctions;
    if (Array.isArray(j.selling)) m.selling = j.selling.map(a => a && a.card_id).filter(Boolean);
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
        const end = Date.parse(a.end_at);
        // Enchère observée : on note où en est l'offre. Une fois l'enchère finie, la dernière offre vue sert de prix de vente.
        if (okKey(a.id) && Number.isFinite(end)) {
          db.obs[a.id] = [a.card_id, price, a.current_bid != null ? 1 : 0, end, now, rarOf(a.snapshot_rarity || (a.card && a.card.rarity))];
        }
        const item = { i: str(a.id, 80), a: price, b: a.current_bid != null, e: Number.isFinite(end) ? end : 0 };
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
  // Le site ne montre pas le prix final d'une enchère aux autres joueurs. On retient donc la dernière offre vue
  // avant la fin. C'est un minimum : l'offre a pu monter après. « g » dit combien de minutes avant la fin on l'a vue.
  const OBS_NEAR = 30;      // au-delà de 30 min avant la fin, le prix vu est trop incertain pour les niveaux par rareté
  const MAX_OBS = 6000;     // enchères en cours suivies
  const MAX_OBS_CARDS = 8000;
  function addObserved(cardId, sale, rarity) {
    if (!okKey(cardId) || typeof sale.p !== 'number' || sale.p <= 0) return false;
    const list = db.obsSales[cardId] || [];
    if (list.some(x => x.t === sale.t && x.p === sale.p)) return false;
    list.push({ p: sale.p, t: str(sale.t, 40), g: Math.max(0, Math.round(num(sale.g))) });
    db.obsSales[cardId] = list.sort(byDateDesc).slice(0, 10);
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
      if (o[2] && !db.auctions[id]) addObserved(o[0], { p: o[1], t: new Date(o[3]).toISOString(), g: (o[3] - o[4]) / 6e4 }, o[5]);
      delete db.obs[id];
      changed = true;
    }
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
  // Ce qu'on peut partager : uniquement des observations d'enchères publiques, jamais l'historique réservé au Pro.
  function observedExport() {
    const sales = [];
    for (const id in db.obsSales) for (const s of db.obsSales[id]) sales.push([id, s.p, s.t, s.g]);
    sales.sort((x, y) => (x[2] < y[2] ? 1 : -1));
    return { sales: sales.slice(0, 8000), rar: db.obsRar };
  }
  // Fusionne des observations venues d'un fichier (ami ou sauvegarde), champ par champ. Renvoie le nombre de prix ajoutés.
  function mergeObserved(seen) {
    if (!isObj(seen)) return 0;
    let added = 0;
    for (const s of (Array.isArray(seen.sales) ? seen.sales : []).slice(0, 20000)) {
      if (!Array.isArray(s) || !okKey(s[0]) || typeof s[1] !== 'number' || typeof s[2] !== 'string' || !Number.isFinite(Date.parse(s[2]))) continue;
      if (addObserved(s[0], { p: s[1], t: s[2], g: num(s[3]) }, null)) added++;
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
      if (a[0] === cardId && a[3] !== 2 && now - a[2] < DAY && (!best || a[2] > best[2])) best = [a[0], a[1], a[2], a[3], id];
    }
    return best;
  }

  // Statut Pro : lu dans la réponse que le site demande lui-même à chaque chargement de page.
  // L'historique des ventes est une fonction Pro, donc le script ne le demande que pour un compte Pro.
  function ingestPro(userId, j) {
    const row = Array.isArray(j) ? j[0] : j;
    if (!row || typeof row.is_pro !== 'boolean') return;
    db.userId = userId;
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

  // ---------- écoute passive : on lit ce que le site charge déjà ----------
  window.fetch = function (input, init) {
    const p = nativeFetch(input, init);
    try {
      const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
      const url = new URL(raw, location.href);
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'GET' && /\.supabase\.co$/.test(url.hostname) && url.pathname === '/rest/v1/profiles' &&
          url.searchParams.get('select') === 'is_pro') { // la requête que le site fait sur ton propre profil
        const u = /^eq\.(.+)$/.exec(url.searchParams.get('id') || '');
        if (u) p.then(r => r.ok && r.clone().json().then(j => ingestPro(u[1], j))).catch(() => {});
      } else if (url.origin === location.origin && method === 'POST' && /^\/api\/packs\//.test(url.pathname)) {
        // Tu viens d'ouvrir un paquet toi-même : on lit juste la liste des cartes tirées.
        const kind = url.pathname.split('/').pop();
        p.then(r => r.ok && r.clone().json().then(j => j && Array.isArray(j.cards) && onPull(j.cards, kind))).catch(() => {});
      } else if (url.origin === location.origin && method === 'GET') {
        const m = url.pathname.match(/^\/api\/marketplace\/cards\/([^/]+)\/sales$/);
        if (m) {
          p.then(r => r.ok && r.clone().json().then(j => ingestSales(m[1], j))).catch(() => {});
        } else if (url.pathname === '/api/my-collection') {
          p.then(r => r.ok && r.clone().json().then(j => ingestCollection(j.collection, false))).catch(() => {});
        } else if (url.pathname === '/api/marketplace') {
          p.then(r => r.ok && r.clone().json().then(ingestMarket)).catch(() => {});
        } else if (url.pathname === '/api/trades') {
          p.then(r => r.ok && r.clone().json().then(ingestTrades)).catch(() => {});
        } else if (url.pathname === '/api/notifications') {
          p.then(r => r.ok && r.clone().json().then(ingestAlerts)).catch(() => {});
        } else if (url.pathname === '/api/cards' && url.searchParams.get('wishlist') === '1') {
          p.then(r => r.ok && r.clone().json().then(j => ingestWish(j, false))).catch(() => {});
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
  let priceCache = new Map();
  function priceOf(cardId) {
    if (priceCache.has(cardId)) return priceCache.get(cardId);
    const rec = db.prices[cardId];
    let sales = rec ? rec.sales : null, at = rec ? rec.at : 0, own = false;
    const mine = db.mySales[cardId];
    // Sans relevé Pro, tes propres ventes et achats de cette carte servent de prix.
    if ((!sales || !sales.length) && mine && mine.length) { sales = mine; own = true; at = at || db.market.at; }
    // À défaut, les fins d'enchères observées par le script (ou par un ami qui a partagé les siennes).
    let obs = false;
    const seen = db.obsSales[cardId];
    if ((!sales || !sales.length) && seen && seen.length) { sales = seen; obs = true; at = at || db.market.at; }
    let out = null;
    if (sales && !sales.length) out = { n: 0, at };
    else if (sales) {
      const v = sales.map(s => s.p);
      out = {
        avg: v.reduce((a, b) => a + b, 0) / v.length, med: median(v),
        last: v[0], lastT: sales[0].t, min: Math.min(...v), max: Math.max(...v), n: v.length, at, own, obs,
        rel: reliability(sales), trend: trendOf(sales)
      };
      // Un prix observé est un minimum, jamais un prix final certain : il ne peut pas être « Fiable ».
      if (obs && out.rel.level > 1) out.rel.level = 1;
    }
    priceCache.set(cardId, out);
    return out;
  }
  // Valeur d'une carte : médiane de ses ventes, jamais moins que la défausse ; sans vente connue, la défausse.
  function valueOf(cardId) {
    const p = priceOf(cardId);
    return p && p.n ? Math.max(p.med, DISCARD) : DISCARD;
  }
  // Une enchère en cours sur cette carte : valable jusqu'à sa fin si elle est connue, sinon 48 h.
  // Renvoie la moins chère, avec dans « list » toutes les enchères encore en cours sur la carte.
  function askOf(cardId) {
    const a = db.market.asks[cardId];
    if (!a) return null;
    const now = Date.now();
    const list = (a.list || [{ i: a.i, a: a.a, b: a.b, e: a.e }]).filter(x => x && (x.e ? x.e > now : now - a.t < 2 * DAY));
    if (!list.length) return null;
    return { a: list[0].a, b: list[0].b, e: list[0].e, i: list[0].i, t: a.t, r: a.r, list };
  }
  // Les alertes récentes dont on ne connaît pas encore le prix, une par carte, les plus récentes d'abord.
  function alertsToCheck() {
    const now = Date.now(), seen = new Set(), todo = [];
    for (const [id, a] of Object.entries(db.alerts).sort((x, y) => y[1][2] - x[1][2])) {
      if (a[3] === 2 || now - a[2] > DAY || seen.has(a[0])) continue;
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
    const rows = Object.entries(db.cards).map(([id, c]) => ({ id, ...c, price: priceOf(c.cardId), ask: askOf(c.cardId) }));
    for (const r of rows) {
      const known = r.price && r.price.n > 0;
      r.value = valueOf(r.cardId);
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
  function priceStale(cardId, rarity) {
    const p = db.prices[cardId];
    if (!p) return true;
    const age = Date.now() - p.at;
    return age > DAY || (!p.sales.length && DOUBT_EMPTY.has(rarity) && age > 36e5);
  }
  async function fetchSales(cardId, rarity) {
    const url = '/api/marketplace/cards/' + encodeURIComponent(cardId) + '/sales';
    const empty = j => !j || !((Array.isArray(j.recent) && j.recent.length) || (Array.isArray(j.sales) && j.sales.length));
    let j = await getJSON(url);
    if (empty(j) && DOUBT_EMPTY.has(rarity)) {
      await sleep(1500);
      j = await getJSON(url);
    }
    ingestSales(cardId, j);
  }
  function missingIds() {
    const ids = new Set();
    for (const c of Object.values(db.cards)) {
      if (!ui.chosen.has(c.rarity)) continue;
      if (priceStale(c.cardId, c.rarity)) ids.add(c.cardId);
    }
    return [...ids];
  }

  // ---------- chargements à la demande ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const job = { running: false, stop: false };
  async function getJSON(path) {
    const r = await nativeFetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
    return r.json();
  }
  function startJob(msg, where) { job.running = true; job.stop = false; setStatus(msg, where); syncButtons(); }
  function endJob(msg, where) { job.running = false; setStatus(msg, where); syncButtons(); refresh(); }

  async function loadCollection() {
    if (job.running) return;
    startJob('Chargement de la collection…');
    try {
      const all = [];
      for (let page = 0; page < 400 && !job.stop; page++) {
        const j = await getJSON('/api/my-collection?sort=rarity&page=' + page + '&stats=0');
        const items = j.collection || [];
        all.push(...items);
        setStatus('Collection : ' + all.length + ' cartes…');
        if (items.length < PAGE_SIZE) break;
        await sleep(400);
      }
      if (job.stop) return endJob('Arrêté, collection inchangée.');
      ingestCollection(all, true);
      endJob('Collection chargée : ' + all.length + ' cartes.');
    } catch (e) {
      endJob('Erreur pendant le chargement (' + e.message + ').');
    }
  }

  async function fillPrices() {
    if (job.running || proState() !== true) return;
    const ids = missingIds();
    if (!ids.length) return setStatus('Rien à compléter pour les raretés cochées.');
    startJob('Prix : 0 / ' + ids.length);
    let i = 0;
    try {
      const rarById = {};
      for (const c of Object.values(db.cards)) rarById[c.cardId] = c.rarity;
      for (const id of ids) {
        if (job.stop) break;
        await fetchSales(id, rarById[id]);
        i++;
        setStatus('Prix : ' + i + ' / ' + ids.length);
        if (i < ids.length) await sleep(PRICE_DELAY + Math.random() * 500);
      }
      endJob(job.stop ? 'Arrêté à ' + i + ' / ' + ids.length + '.' : 'Prix complétés pour ' + i + ' cartes.');
    } catch (e) {
      if ([401, 402, 403].includes(e.status)) {
        return endJob('Le site refuse l’historique des ventes pour ce compte (réservé au Pro ?). ' +
          'Le tableau reste utilisable sans les prix : raretés, ATK, DEF, Q-Score, export CSV.');
      }
      endJob('Arrêt sur erreur (' + e.message + ') après ' + i + ' / ' + ids.length + '. Réessaie plus tard.');
    }
  }

  // Lit les premières pages de la page Marché, comme si tu les feuilletais.
  // sort : « recent » pour les dernières annonces, « ending_soon » pour les enchères sur le point de finir,
  // dont l'offre en cours est presque le prix final.
  async function scanMarket(pages, where, sort) {
    if (job.running) return;
    startJob('Lecture du marché…', where);
    let seen = 0;
    try {
      for (let page = 1; page <= pages && !job.stop; page++) {
        const j = await getJSON('/api/marketplace?page=' + page + '&limit=50&sort=' + (sort || 'recent') + (page === 1 ? '&mine=1' : ''));
        ingestMarket(j);
        seen += (j.auctions || []).length;
        setStatus('Marché : ' + seen + ' enchères lues…', where);
        if (!j.hasMore) break;
        if (page < pages) await sleep(PRICE_DELAY + Math.random() * 500);
      }
      endJob(pages === 1 ? 'Ventes en cours à jour.'
        : seen + ' enchères lues. Leur prix sera enregistré quand elles seront finies, d’ici quelques minutes.', where);
    } catch (e) {
      endJob('Lecture du marché impossible (' + e.message + ').', where);
    }
  }

  // Les cartes passées dans tes échanges dont l'historique de ventes manque ou date.
  // Une carte donnée n'est plus dans ta collection : « Compléter les prix manquants » ne la voit donc jamais.
  const TRADE_BATCH = 60;
  function tradeCardsToPrice() {
    const out = [], seen = new Set();
    const list = Object.values(db.trades).sort(byDateDesc).sort((a, b) => (b.s === 'accepted') - (a.s === 'accepted'));
    for (const t of list) for (const c of t.g.concat(t.r)) {
      if (seen.has(c[0]) || !priceStale(c[0], c[2])) continue;
      seen.add(c[0]);
      out.push([c[0], c[2]]);
    }
    return out;
  }
  async function fillTradePrices() {
    if (job.running || proState() !== true) return;
    const todo = tradeCardsToPrice().slice(0, TRADE_BATCH);
    if (!todo.length) return setStatus('Toutes les cartes échangées ont déjà un prix relevé.', 'tradeStatus');
    startJob('Prix : 0 / ' + todo.length, 'tradeStatus');
    let i = 0;
    try {
      for (const [id, rarity] of todo) {
        if (job.stop) break;
        await fetchSales(id, rarity);
        i++;
        setStatus('Prix : ' + i + ' / ' + todo.length, 'tradeStatus');
        if (i < todo.length) await sleep(PRICE_DELAY + Math.random() * 500);
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
  async function loadWish() {
    if (job.running) return;
    startJob('Lecture de la liste de souhaits…', 'wishStatus');
    try {
      const all = [];
      for (let page = 0; page < 100 && !job.stop; page++) {
        const j = await getJSON('/api/cards?page=' + page + '&sort=rarity&wishlist=1');
        const cards = j.cards || [];
        all.push(...cards);
        setStatus('Liste de souhaits : ' + all.length + ' cartes…', 'wishStatus');
        if (cards.length < PAGE_SIZE || (typeof j.total === 'number' && all.length >= j.total)) break;
        await sleep(PRICE_DELAY + Math.random() * 500);
      }
      if (job.stop) return endJob('Arrêté, liste inchangée.', 'wishStatus');
      ingestWish({ cards: all }, true);
      endJob('Liste de souhaits chargée : ' + all.length + ' cartes.', 'wishStatus');
    } catch (e) {
      endJob('Lecture impossible (' + e.message + ').', 'wishStatus');
    }
  }

  // Pour chaque alerte récente, cherche la carte sur le marché par son titre, comme avec la barre de recherche.
  const ALERT_BATCH = 40;
  const SEARCH_BATCH = 50;        // cartes cherchées par passage
  const SEARCH_FRESH = 60 * 6e4;  // une carte cherchée depuis moins d'une heure n'est pas recherchée à nouveau
  // Cherche une liste de cartes [identifiant, titre] sur le marché, une recherche par seconde.
  async function marketSearch(todo, label, noneText) {
    startJob(label + ' : 0 / ' + todo.length, 'wishStatus');
    let i = 0, live = 0;
    try {
      for (const [cardId, title] of todo) {
        if (job.stop) break;
        const j = await getJSON('/api/marketplace?page=1&limit=50&sort=recent&q=' + encodeURIComponent(title));
        // La recherche fait foi pour cette carte : on repart de ce qu'elle renvoie.
        delete db.market.asks[cardId];
        ingestMarket(j);
        const found = (j.auctions || []).some(x => x && x.card_id === cardId);
        if (found) live++;
        for (const id in db.alerts) if (db.alerts[id][0] === cardId) db.alerts[id][3] = found ? 1 : 2;
        db.wishSeen[cardId] = Date.now();
        i++;
        setStatus(label + ' : ' + i + ' / ' + todo.length + ' · ' + plural(live, 'carte en vente', 'cartes en vente'), 'wishStatus');
        if (i < todo.length) await sleep(PRICE_DELAY + Math.random() * 500);
      }
      saveDb();
      endJob((job.stop ? 'Arrêté à ' + i + ' / ' + todo.length + '. ' : '') + plural(live, 'carte en vente', 'cartes en vente') +
        ' sur ' + i + ', ' + (i - live) + ' ' + noneText + '.', 'wishStatus');
    } catch (e) {
      saveDb();
      endJob('Recherche interrompue (' + e.message + ') après ' + i + ' / ' + todo.length + '. Réessaie plus tard.', 'wishStatus');
    }
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
          if (priceStale(c.cardId, c.rarity) && !pull.queue.includes(c.cardId)) pull.queue.push(c.cardId);
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
  function renderPull() {
    const e = ui.el;
    if (!e.pull) return;
    e.pull.classList.toggle('open', pull.open && pull.cards.length > 0);
    if (!pull.open) return;
    const rows = pull.cards.map(c => {
      const p = priceOf(c.cardId);
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
      if (m) m.count += c.count;
      else mine[c.cardId] = { title: c.title, rarity: c.rarity, count: c.count };
    }
    return mine;
  }
  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    ui.el.host.shadowRoot.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportMine() {
    const pseudo = (db.me || '').trim();
    if (!pseudo) return setStatus('Écris d’abord ton pseudo.', 'frStatus');
    const mine = myCards();
    const ids = Object.keys(mine);
    if (!ids.length) return setStatus('Charge d’abord ta collection dans l’onglet Collection.', 'frStatus');
    // Volontairement sans les prix : seulement ce que chacun voit de sa propre collection.
    const data = {
      wmstats: 1, pseudo, at: Date.now(),
      cards: ids.map(id => [id, mine[id].title, mine[id].rarity, mine[id].count]),
      wish: Object.entries(db.wish).map(([id, w]) => [id, w[0], w[1]]),
      seen: observedExport()
    };
    download('wikimasters-collection-' + pseudo.replace(/[^\w-]+/g, '_') + '.json', JSON.stringify(data), 'application/json');
    setStatus('Fichier créé : envoie-le à tes amis.', 'frStatus');
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
    return { pseudo, at: typeof j.at === 'number' ? j.at : Date.now(), cards, wish, seen: isObj(j.seen) ? j.seen : null };
  }

  // ---------- sauvegarde : passer ses données d'un navigateur à l'autre ----------
  function exportBackup() {
    const data = {};
    for (const k of ['cards', 'collectionAt', 'prices', 'pulls', 'auctions', 'history', 'wish', 'wishAt', 'friends', 'me', 'sell']) data[k] = db[k];
    data.seen = observedExport();
    data.trades = db.trades;
    download('wikimasters-sauvegarde-' + dayKey(new Date()) + '.json',
      JSON.stringify({ wmstatsBackup: 1, at: Date.now(), data }), 'application/json');
    setStatus('Sauvegarde créée. Importe ce fichier dans ton autre navigateur.', 'dataStatus');
  }
  const cleanSales = a => (Array.isArray(a) ? a : []).filter(s => s && typeof s.p === 'number')
    .slice(0, 10).map(s => ({ p: s.p, t: str(s.t, 40) }));
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
      if (!cur || num(p.at) > cur.at) { db.prices[id] = { at: num(p.at), sales: cleanSales(p.sales) }; n.prix++; }
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
      db.auctions[id] = [a[0], a[1], str(a[2], 200), rarOf(a[3]), num(a[4]), num(a[5]), typeof a[6] === 'number' ? a[6] : null, str(a[7], 40)];
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
      if (file.size > 5e6) throw new Error('fichier trop gros');
      const f = parseFriend(await file.text());
      if (!db.friends[f.pseudo] && Object.keys(db.friends).length >= 10) throw new Error('10 amis au maximum, retire-en un');
      db.friends[f.pseudo] = { at: f.at, cards: f.cards, wish: f.wish };
      ui.friend = f.pseudo;
      const prices = mergeObserved(f.seen);
      saveDb();
      setStatus('Collection de ' + f.pseudo + ' importée : ' + plural(Object.keys(f.cards).length, 'carte différente', 'cartes différentes') +
        (prices ? ', et ' + plural(prices, 'prix observé ajouté', 'prix observés ajoutés') : '') + '.', 'frStatus');
    } catch (e) {
      setStatus('Import impossible : ' + e.message + '.', 'frStatus');
    }
    refresh();
  }

  // ---------- interface ----------
  const TABS = [['col', 'Collection'], ['sell', 'À vendre'], ['sales', 'Mes ventes'], ['trades', 'Échanges'], ['wish', 'Souhaits'],
    ['pulls', 'Boosters'], ['trend', 'Évolution'], ['friends', 'Amis'], ['data', 'Sauvegarde']];
  const ui = {
    open: false, tab: 'col', chosen: new Set(['L', 'UR', 'SR']),
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
    button.b{background:#1c2622;color:#e5e7eb;border:1px solid #33413b;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer}
    button.b:hover:not(:disabled){border-color:#34d399}
    button.b.pri{background:#10b981;color:#04130d;border-color:#10b981;font-weight:700}
    button.b:disabled{opacity:.45;cursor:default}
    button.x{background:none;border:0;color:#8b9a94;font-size:22px;cursor:pointer;line-height:1}
    label.chk{display:inline-flex;gap:4px;align-items:center;color:#cbd5d1;cursor:pointer}
    input[type=text],input[type=number],select{background:#151c19;color:#e5e7eb;border:1px solid #33413b;border-radius:8px;padding:7px 10px;font-size:13px}
    input[type=text]{min-width:220px}
    input[type=number]{width:90px}
    input[type=file]{color:#8b9a94;font-size:12px}
    .status{color:#fbbf24;min-height:18px;margin-bottom:8px}
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
    tr.det>td{background:#0b100e;padding:6px 8px 10px 32px;text-align:left}
    tr.det table{width:auto}
    tr.det table td{border-bottom:0;padding:3px 22px 3px 0;text-align:left;color:#cbd5d1}
    td a{color:#e5e7eb;text-decoration:none}
    td a:hover{color:#34d399}
    td a.go{color:#34d399;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}
    td a.go:hover{color:#6ee7b7}
    .est{color:#8b9a94;font-style:italic}
    .r{display:inline-block;min-width:26px;text-align:center;border-radius:5px;padding:1px 5px;font-weight:700;font-size:11px;background:#33413b}
    .r-L{background:#fde047;color:#111}.r-UR{background:#fb923c;color:#111}.r-SR{background:#f472b6;color:#111}
    .r-R{background:#c4b5fd;color:#111}.r-PC{background:#7dd3fc;color:#111}.r-C{background:#4b5563}
    .adv{display:inline-block;border-radius:999px;padding:3px 9px;font-weight:700;font-size:12px;white-space:nowrap}
    .adv.sell{background:#10b981;color:#04130d}.adv.drop{background:#374151;color:#e5e7eb}.adv.unk{background:#1c2622;color:#8b9a94}
    .rel{white-space:nowrap;cursor:help}
    .rel::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:#6b7280}
    .rel.l2::before{background:#34d399}.rel.l1::before{background:#fbbf24}.rel.l0::before{background:#f87171}
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
      (p.obs ? ', d’après des fins d’enchères observées (dernière offre vue, donc un minimum)' : '');
    return h('span', { class: 'rel l' + p.rel.level, title }, REL[p.rel.level] + ARROW[p.trend]);
  }
  const rarBadge = r => h('span', { class: 'r r-' + r }, r);
  // Lien vers la page d'une enchère sur le site, ouverte dans un nouvel onglet pour garder la liste sous les yeux.
  // Sans identifiant d'enchère connu, on rend le contenu tel quel.
  const auctionLink = (id, kids, title) => (okKey(id)
    ? h('a', { class: 'go', href: '/marketplace/' + encodeURIComponent(id), target: '_blank', rel: 'noopener', title: (title ? title + ' · ' : '') + 'Ouvrir l’annonce' }, kids, ' ↗')
    : h('span', { title: title || '' }, kids));
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
    { k: 'q', t: 'Q-Score', get: r => r.q, cell: r => fmt(r.q) },
    { k: 'views', t: 'Vues 30j', get: r => r.views, cell: r => fmt(r.views) },
    { k: 'value', t: 'Valeur', price: true, get: r => r.value, cell: r => estCell(r, r.value) },
    { k: 'rel', t: 'Fiabilité', price: true, get: r => (pr(r, 'n') ? r.price.rel.level : null), cell: r => relCell(r.price) },
    { k: 'last', t: 'Dernière', price: true, get: r => pr(r, 'last'), cell: r => fmt(pr(r, 'last')) },
    { k: 'min', t: 'Min', price: true, get: r => pr(r, 'min'), cell: r => fmt(pr(r, 'min')) },
    { k: 'max', t: 'Max', price: true, get: r => pr(r, 'max'), cell: r => fmt(pr(r, 'max')) },
    { k: 'n', t: 'Ventes', price: true, get: r => pr(r, 'n'), cell: r => (r.price ? r.price.n : '—') },
    { k: 'total', t: 'Total', price: true, get: r => r.total, cell: r => estCell(r, r.total) },
    { k: 'adv', t: 'Conseil', price: true, get: r => (pr(r, 'n') ? r.price.med : null),
      cell: r => { const a = advice(r.price); return r.price ? h('span', { class: 'adv ' + a.cls }, a.text) : '—'; } },
    { k: 'ask', t: 'En vente à', ask: true, get: r => (r.ask ? r.ask.a : null),
      cell: r => (r.ask ? auctionLink(r.ask.i, fmt(r.ask.a) + (r.ask.b ? ' •' : '') + (r.ask.list.length > 1 ? ' (' + r.ask.list.length + ')' : ''),
        (r.ask.list.length > 1 ? r.ask.list.length + ' annonces, de ' + fmt(r.ask.a) + ' à ' + fmt(r.ask.list[r.ask.list.length - 1].a) + ' ₩ ; la moins chère : ' : '') +
        (r.ask.b ? 'une offre a déjà été faite' : 'mise de départ, sans offre')) : '—') }
  ];

  function setStatus(msg, where) { const el = ui.el[where || 'status']; if (el) el.textContent = msg || ''; }
  function syncButtons() {
    const e = ui.el;
    if (!e.load) return;
    const pro = proState();
    e.load.disabled = e.scan.disabled = e.mine.disabled = e.mine2.disabled = e.wishLoad.disabled = e.tradeLoad.disabled = job.running;
    const pending = alertsToCheck().length;
    e.wishCheck.disabled = job.running || !pending;
    e.wishCheck.textContent = 'Vérifier les annonces signalées (' + Math.min(pending, ALERT_BATCH) + ')';
    const live = wishLive().length;
    e.wishRefresh.disabled = job.running || !live;
    e.wishRefresh.textContent = 'Rafraîchir les annonces (' + Math.min(live, SEARCH_BATCH) + (live > SEARCH_BATCH ? ' sur ' + live : '') + ')';
    e.stop3.disabled = !job.running;
    if (job.running) e.tradeFill.disabled = true;
    const toSearch = wishToSearch().length;
    e.wishSearch.disabled = job.running || !toSearch;
    e.wishSearch.textContent = 'Chercher mes souhaits sur le marché (' + Math.min(toSearch, SEARCH_BATCH) +
      (toSearch > SEARCH_BATCH ? ' sur ' + toSearch : '') + ')';
    e.stop2.disabled = !job.running;
    e.fill.disabled = job.running || pro !== true;
    e.stop.disabled = !job.running;
    e.fill.textContent = pro === true
      ? 'Compléter les prix manquants (' + missingIds().length + ')'
      : 'Prix : réservé aux comptes Pro';
    e.pro.textContent = pro === true ? ''
      : pro === false
        ? 'Compte non Pro : le site ne donne pas l’historique des ventes. Les valeurs viennent de tes propres ventes et achats, ' +
          'et des fins d’enchères que le script observe sur le marché ou que tes amis partagent.'
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
    e.mine2 = h('button', { class: 'b', onclick: () => scanMarket(1, 'salesStatus') }, 'Actualiser depuis la page Marché');
    e.wishLoad = h('button', { class: 'b pri', onclick: loadWish }, 'Charger ma liste de souhaits');
    e.wishCheck = h('button', { class: 'b', onclick: checkAlerts }, 'Vérifier les annonces signalées');
    e.wishSearch = h('button', { class: 'b', onclick: searchWish }, 'Chercher mes souhaits sur le marché');
    e.wishRefresh = h('button', { class: 'b', title: 'Relit le prix et la fin des annonces déjà listées', onclick: refreshWish }, 'Rafraîchir les annonces');
    e.wishFold = h('button', { class: 'b', onclick: () => { ui.wishAll = !ui.wishAll; ui.wishOpen.clear(); renderWish(); } }, 'Tout déplier');
    e.stop2 = h('button', { class: 'b', disabled: true, onclick: () => { job.stop = true; } }, 'Stop');
    e.sub = h('div', { class: 'sub' });
    e.pro = h('div', { class: 'sub', style: 'margin-bottom:10px' });
    e.sellInfo = h('div', { class: 'sub', style: 'margin-bottom:10px' });
    e.load = h('button', { class: 'b pri', onclick: loadCollection }, 'Charger ma collection');
    e.fill = h('button', { class: 'b', onclick: fillPrices }, 'Compléter les prix manquants');
    e.scan = h('button', { class: 'b', title: 'Lit les 200 enchères qui se terminent, pour enregistrer leur prix',
      onclick: () => scanMarket(MARKET_PAGES, 'status', 'ending_soon') }, 'Relever les fins d’enchères');
    e.stop = h('button', { class: 'b', disabled: true, onclick: () => { job.stop = true; } }, 'Stop');
    e.mine = h('button', { class: 'b', onclick: () => scanMarket(1, 'sellStatus') }, 'Actualiser mes ventes en cours');
    const checks = RARITIES.map(r => h('label', { class: 'chk' },
      h('input', {
        type: 'checkbox', checked: ui.chosen.has(r),
        onchange: ev => { ev.target.checked ? ui.chosen.add(r) : ui.chosen.delete(r); syncButtons(); }
      }), r));
    const rarSelect = onchange => h('select', { onchange },
      h('option', { value: '' }, 'Toutes les raretés'), RARITIES.map(r => h('option', { value: r }, r)));
    const sellOpt = (key, label) => h('label', { class: 'chk' },
      h('input', { type: 'checkbox', checked: !!db.sell[key], onchange: ev => { db.sell[key] = ev.target.checked; saveDb(); refresh(); } }), label);

    e.view_col = h('div', null,
      e.tiles, e.rar, e.market,
      h('div', { class: 'bar' }, e.load, e.fill, e.scan, e.stop, h('span', { class: 'sub' }, 'Prix pour :'), checks),
      h('div', { class: 'bar' }, h('label', { class: 'chk' },
        h('input', { type: 'checkbox', checked: db.autoPull !== false,
          onchange: ev => { db.autoPull = ev.target.checked; saveDb(); } }),
        'Afficher les prix des cartes tirées après chaque booster que j’ouvre')),
      e.pro,
      h('div', { class: 'bar' },
        h('input', { type: 'text', placeholder: 'Filtrer par titre, catégorie, étiquette…',
          oninput: ev => { ui.text = ev.target.value.toLowerCase(); renderTable(); } }),
        rarSelect(ev => { ui.rarity = ev.target.value; renderTable(); }),
        h('button', { class: 'b', onclick: exportCsv }, 'Exporter en CSV'),
        h('button', { class: 'b', onclick: clearPrices }, 'Oublier les prix')),
      e.status, e.table,
      h('div', { class: 'note' },
        'Valeur = médiane des 10 dernières ventes (moins sensible qu’une moyenne aux enchères qui s’emballent). ',
        'En italique : carte sans vente connue, comptée à 1 wikibidou, ce que rapporte la défausse. ',
        'Fiabilité = assez de ventes, assez récentes, pas trop dispersées ; survole-la pour le détail. ',
        'Les prix se remplissent aussi tout seuls quand tu ouvres l’onglet Marché d’une carte.'));

    e.view_sell = h('div', null,
      h('div', { class: 'bar' },
        h('span', null, 'Valeur minimale pour vendre :'),
        h('input', { type: 'number', min: 2, step: 1, value: db.sell.min,
          onchange: ev => { db.sell.min = Math.max(2, Math.floor(Number(ev.target.value) || 2)); ev.target.value = db.sell.min; saveDb(); refresh(); } }),
        sellOpt('favs', 'Inclure mes favoris ★'),
        sellOpt('doubt', 'Inclure les prix douteux'),
        e.mine),
      e.sellInfo, e.sellStatus, e.sellTable,
      h('div', { class: 'note' },
        'Les doublons passent en premier, puis les cartes les plus chères. Les cartes déjà mises en vente sont retirées de la liste. ',
        'Les lignes surlignées tiennent dans tes places de vente libres. Le script ne met rien en vente : c’est toi qui le fais sur le site.'));

    e.view_pulls = h('div', null, e.pullTiles, e.pullBody,
      h('div', { class: 'bar', style: 'margin-top:12px' },
        h('button', { class: 'b', onclick: () => { db.pulls = []; saveDb(); refresh(); } }, 'Effacer l’historique des boosters')),
      h('div', { class: 'note' },
        'Seuls les boosters ouverts depuis l’installation de cette version sont comptés. ',
        'La valeur utilise les prix connus aujourd’hui ; une carte sans vente connue compte pour 1.'));

    e.frSelect = h('select', { onchange: ev => { ui.friend = ev.target.value; renderFriends(); } });
    e.view_friends = h('div', null,
      h('div', { class: 'bar' },
        h('span', null, 'Mon pseudo :'),
        h('input', { type: 'text', value: db.me || '', style: 'min-width:140px', placeholder: 'ton pseudo',
          oninput: ev => { db.me = ev.target.value.slice(0, 40); saveDb(); } }),
        h('button', { class: 'b pri', onclick: exportMine }, 'Exporter ma collection pour mes amis')),
      h('div', { class: 'bar' },
        h('span', null, 'Importer le fichier d’un ami :'),
        h('input', { type: 'file', accept: '.json,application/json',
          onchange: ev => { importFriend(ev.target.files[0]); ev.target.value = ''; } })),
      h('div', { class: 'bar' },
        h('span', null, 'Comparer avec :'), e.frSelect,
        rarSelect(ev => { ui.frRarity = ev.target.value; renderFriends(); }),
        h('button', { class: 'b', onclick: () => { if (ui.friend) { delete db.friends[ui.friend]; ui.friend = ''; saveDb(); refresh(); } } }, 'Retirer cet ami')),
      e.frStatus, e.frBody,
      h('div', { class: 'note' },
        'Le fichier exporté contient la liste de tes cartes, leur nombre d’exemplaires, ta liste de souhaits et les fins d’enchères que le script a observées. ' +
        'Il ne contient jamais l’historique des ventes réservé au Pro. ',
        'Il fonctionne avec ou sans compte Pro.'));

    e.view_sales = h('div', null,
      h('div', { class: 'bar' }, e.mine2), e.salesStatus, e.salesTiles, e.salesBody,
      h('div', { class: 'note' },
        'Le site ne donne que tes enchères les plus récentes. Le script les garde en mémoire à chaque passage sur la page Marché, donc le bilan s’allonge avec le temps. ',
        'La comparaison à la valeur médiane est indicative : cette médiane inclut ta propre vente.'));

    e.tradeStatus = h('div', { class: 'status' });
    e.tradeTiles = h('div', { class: 'tiles' });
    e.tradeBody = h('div', { class: 'scroll' });
    e.tradeLoad = h('button', { class: 'b pri', onclick: loadTrades }, 'Actualiser mes échanges');
    e.tradeFill = h('button', { class: 'b', onclick: fillTradePrices }, 'Relever les prix des cartes échangées');
    e.stop3 = h('button', { class: 'b', disabled: true, onclick: () => { job.stop = true; } }, 'Stop');
    e.view_trades = h('div', null,
      h('div', { class: 'bar' }, e.tradeLoad, e.tradeFill, e.stop3), e.tradeStatus, e.tradeTiles, e.tradeBody,
      h('div', { class: 'note' },
        'Les échanges sont lus sur la page Échanges du site, à chaque visite ou avec le bouton, et gardés en mémoire. ',
        'Les valeurs sont celles d’aujourd’hui, pas celles du jour de l’échange. Une carte sans prix connu n’est pas comptée : ' +
        'elle apparaît comme « + 1 ? » et rend le bilan incomplet. Les cartes que tu as données ne sont plus dans ta collection, ' +
        'donc leur prix se relève ici, avec « Relever les prix des cartes échangées » (compte Pro). ',
        'Clique sur un échange pour voir les cartes.'));

    e.view_wish = h('div', null,
      h('div', { class: 'bar' }, e.wishLoad, e.wishRefresh, e.wishCheck, e.wishSearch, e.stop2),
      h('div', { class: 'bar' },
        rarSelect(ev => { ui.wishRarity = ev.target.value; syncButtons(); renderWish(); }),
        h('label', { class: 'chk' },
          h('input', { type: 'checkbox', onchange: ev => { ui.wishAvail = ev.target.checked; renderWish(); } }),
          'Seulement celles que je peux obtenir maintenant'),
        h('label', { class: 'chk', title: 'D’après ta collection chargée dans l’onglet Collection' },
          h('input', { type: 'checkbox', checked: !!db.wishHideOwned,
            onchange: ev => { db.wishHideOwned = ev.target.checked; saveDb(); syncButtons(); renderWish(); } }),
          'Cacher les cartes que je possède déjà'),
        e.wishFold),
      e.wishStatus, e.wishTiles, e.wishBody,
      h('div', { class: 'note' },
        'Ta liste de souhaits est celle du site : les cartes pour lesquelles tu as demandé une alerte dans « Toutes les cartes ». ',
        'Le script retient les alertes de mise en vente que le site t’envoie. « Vérifier les annonces signalées » cherche chacune de ces cartes sur le marché ' +
        'pour en lire le prix et la fin de l’enchère, une recherche par seconde, 40 au plus par passage. ',
        '« Chercher mes souhaits sur le marché » fait la même recherche pour les cartes de ta liste, alerte ou non : 50 par passage, ' +
        'en commençant par celles jamais cherchées. Choisis une rareté pour cibler, et relance pour continuer. ' +
        'Une carte cherchée depuis moins d’une heure est sautée. Clique sur un en-tête de colonne pour trier. ',
        '« Chez un ami » vient des fichiers importés dans l’onglet Amis. ',
        'Ta liste part aussi dans le fichier que tu exportes pour tes amis, pour qu’ils voient ce que tu cherches.'));

    e.view_trend = h('div', null,
      h('div', { class: 'bar' },
        h('span', null, 'Afficher :'),
        h('select', { onchange: ev => { ui.metric = Number(ev.target.value); renderTrend(); } },
          h('option', { value: 0 }, 'Valeur totale'), h('option', { value: 1 }, 'Nombre de cartes'),
          h('option', { value: 3 }, 'Cartes déjà vendues aux enchères'))),
      e.trendBody,
      h('div', { class: 'note' },
        'Une photo est prise chaque jour où ta collection est chargée ou consultée sur le site. Les jours sans visite n’ont pas de point.'));

    e.view_data = h('div', null,
      h('p', { class: 'line' }, 'Tes données sont rangées dans ce navigateur. Chrome et Zen ont donc chacun les leurs.'),
      h('div', { class: 'bar', style: 'margin-top:12px' },
        h('button', { class: 'b pri', onclick: exportBackup }, 'Exporter toutes mes données')),
      h('div', { class: 'bar' },
        h('span', null, 'Importer une sauvegarde :'),
        h('input', { type: 'file', accept: '.json,application/json',
          onchange: ev => { importBackup(ev.target.files[0]); ev.target.value = ''; } })),
      e.dataStatus,
      h('div', { class: 'note' },
        'La sauvegarde contient ta collection, les prix relevés, tes boosters, tes enchères, l’évolution, ta liste de souhaits et les fichiers de tes amis. ',
        'L’import fusionne : il ajoute ce qui manque et ne remplace un prix ou une collection que par plus récent. ',
        'Garde ce fichier pour toi : il contient des prix issus de ton compte.'));

    const views = TABS.map(([k]) => e['view_' + k]);
    e.back = h('div', { class: 'back', onclick: ev => { if (ev.target === e.back) toggle(false); } },
      h('div', { class: 'panel' },
        h('header', null,
          h('div', { style: 'flex:1' }, h('h1', null, 'Stats WikiMasters'), e.sub),
          h('button', { class: 'x', title: 'Fermer', onclick: () => toggle(false) }, '×')),
        h('div', { class: 'tabs' }, TABS.map(([k, label]) =>
          (e['tab_' + k] = h('button', { class: 'tab', onclick: () => setTab(k) }, label)))),
        h('div', { class: 'body' }, views)));
    e.pullList = h('div');
    e.pull = h('div', { class: 'pull' },
      h('header', null, h('h1', null, 'Dernier booster'),
        h('button', { class: 'x', title: 'Fermer', onclick: () => { pull.open = false; renderPull(); } }, '×')),
      e.pullList);
    root.append(h('style', null, CSS),
      h('button', { class: 'fab', onclick: () => toggle() }, '📊 Stats'), e.pull, e.back);
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
    refresh();
  }

  let rowsCache = [];
  function refresh() {
    if (!ui.el.host) return;
    priceCache = new Map();
    renderPull();
    if (!ui.open) return;
    rowsCache = buildRows();
    snapshot(rowsCache);
    ui.el.sub.textContent = db.collectionAt
      ? 'Collection vue le ' + new Date(db.collectionAt).toLocaleString('fr-FR')
      : 'Collection pas encore chargée';
    syncButtons();
    ({ col: renderCol, sell: renderSell, sales: renderSales, trades: renderTrades, wish: renderWish, pulls: renderPulls,
      trend: renderTrend, friends: renderFriends, data: () => {} })[ui.tab]();
  }
  const simpleTable = (heads, rows, leftCols) => h('table', null,
    h('thead', null, h('tr', null, heads.map((t, i) => h('th', { class: (leftCols || []).includes(i) ? 'l' : '' }, t)))),
    h('tbody', null, rows));
  const rarOrder = r => { const i = RARITIES.indexOf(r); return i < 0 ? 99 : i; };
  // Tableau triable : un clic sur un en-tête trie selon cette colonne, un second clic inverse le sens.
  // Tant qu'aucun en-tête n'a été cliqué, l'ordre fourni est conservé. Les valeurs absentes vont à la fin.
  // Une colonne : { t: titre, get: valeur de tri, cell: contenu, left: aligné à gauche, asc: premier clic croissant }
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
      title: c.get ? 'Cliquer pour trier' : '',
      onclick: () => {
        if (!c.get) return;
        const cur = ui.sorts[key];
        ui.sorts[key] = cur && cur.i === i ? { i, dir: -cur.dir } : { i, dir: c.asc ? 1 : -1 };
        rerender();
      }
    }, c.t + (st && st.i === i ? (st.dir > 0 ? ' ▲' : ' ▼') : ''))));
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
  function renderSales() {
    const e = ui.el;
    const A = Object.values(db.auctions)
      .map(a => ({ kind: a[0], cardId: a[1], title: a[2], rarity: a[3], list: a[4], base: a[5], final: a[6], t: a[7] }))
      .sort(byDateDesc);
    if (!A.length) {
      e.salesTiles.replaceChildren();
      e.salesBody.replaceChildren(h('div', { class: 'empty' },
        'Aucune enchère en mémoire. Clique sur « Actualiser depuis la page Marché », ou ouvre simplement la page Marché du site.'));
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
    const ratios = sold.map(a => { const p = priceOf(a.cardId); return p && p.n && p.med ? a.final / p.med : null; }).filter(x => x != null);
    if (ratios.length >= 3) {
      lines.push('Tes ventes se sont conclues, en médiane, à ' + fmt(100 * median(ratios)) + ' % de la valeur médiane actuelle de la carte (sur ' +
        ratios.length + ' ventes).');
    }
    if (lines.length) kids.push(h('h2', null, 'Mise de départ et prix obtenu'), lines.map(t => h('p', { class: 'line' }, t)));
    const withPrices = showPrices();
    const medOf = a => { const p = priceOf(a.cardId); return p && p.n ? p.med : null; };
    kids.push(h('h2', null, 'Tes enchères (' + fmt(A.length) + ')'),
      sortTable('sales', [
        { t: 'Date', get: a => a.t, cell: a => fmtDate(a.t) },
        { t: 'Carte', left: true, asc: true, get: a => a.title.toLowerCase(), cell: a => a.title },
        { t: 'Rareté', asc: true, get: a => rarOrder(a.rarity), cell: a => rarBadge(a.rarity) },
        { t: 'Type', asc: true, get: a => (a.kind === 'b' ? 'Achat' : 'Vente'), cell: a => (a.kind === 'b' ? 'Achat' : 'Vente') },
        { t: 'Mise de départ', get: a => a.list, cell: a => fmt(a.list) + ' ₩' + (a.base !== a.list ? ' → ' + fmt(a.base) + ' ₩' : '') },
        { t: 'Résultat', get: a => a.final, cell: a => (a.final == null ? h('span', { class: 'est' }, 'Invendue') : h('b', null, fmt(a.final) + ' ₩')) },
        withPrices ? { t: 'Valeur médiane', get: medOf, cell: a => (medOf(a) == null ? '—' : fmt(medOf(a)) + ' ₩') } : null
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
      const p = priceOf(c[0]);
      if (p && p.n) return Math.max(p.med, DISCARD);
      return db.prices[c[0]] && !priceStale(c[0], c[2]) ? DISCARD : null;
    };
    const cardsValue = l => l.reduce((a, c) => a + (known(c) || 0), 0);
    const unknown = l => l.filter(c => known(c) == null).length;
    const T = Object.entries(db.trades)
      .map(([id, t]) => ({ id, ...t, vg: cardsValue(t.g) + t.wg, vr: cardsValue(t.r) + t.wr, ug: unknown(t.g), ur: unknown(t.r) }))
      .sort(byDateDesc);
    const toPrice = tradeCardsToPrice().length;
    e.tradeFill.disabled = job.running || proState() !== true || !toPrice;
    e.tradeFill.textContent = proState() === true
      ? 'Relever les prix des cartes échangées (' + Math.min(toPrice, TRADE_BATCH) + (toPrice > TRADE_BATCH ? ' sur ' + toPrice : '') + ')'
      : 'Prix des cartes échangées : réservé aux comptes Pro';
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
  function renderWish() {
    const e = ui.el;
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
      id, title: known[id][0], rarity: known[id][1], ask: askOf(id), alert: alertOf(id), price: priceOf(id), owned: owned.has(id),
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
      tile('Signalées, à vérifier', fmt(toCheck), 'alertes du site des dernières 24 h'),
      tile('Chez un ami', fmt(atFriends), plural(Object.keys(db.friends).length, 'ami importé', 'amis importés')));
    const left = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + ' min' : Math.round(m / 60) + ' h'; };
    const list = all
      .filter(c => (!ui.wishRarity || c.rarity === ui.wishRarity) && (!ui.wishAvail || rank(c) < 3) && !(db.wishHideOwned && c.owned))
      .sort((a, b) => rank(a) - rank(b) || (a.ask && b.ask ? a.ask.a - b.ask.a : 0) ||
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
    const feat = c => {
      if (!c.ask) return null;
      const l = c.ask.list;
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
        h('td', null, au.e > now ? 'fin dans ' + left(au.e - now) : 'fin inconnue'))))))) : null);
    e.wishBody.replaceChildren(
      sortTable('wish', [
        { t: 'Carte', left: true, asc: true, get: c => c.title.toLowerCase(),
          cell: c => [multi(c) ? h('span', { class: 'caret' }, isOpen(c) ? '▾' : '▸') : h('span', { class: 'caret' }), c.title,
            multi(c) ? h('span', { class: 'tag' }, c.ask.list.length + ' annonces') : null,
            c.owned ? h('span', { class: 'tag', title: 'Cette carte est déjà dans ta collection' }, 'possédée') : null] },
        { t: 'Rareté', asc: true, get: c => rarOrder(c.rarity), cell: c => rarBadge(c.rarity) },
        withPrices ? { t: 'Valeur médiane', get: c => (c.price && c.price.n ? c.price.med : null),
          cell: c => (c.price && c.price.n ? fmt(c.price.med) + ' ₩' : '—') } : null,
        { t: 'En vente à', asc: true, get: c => (c.ask ? feat(c).a : null),
          cell: c => {
            if (!c.ask) return c.alert ? auctionLink(c.alert[4], h('span', { class: 'est' }, 'à vérifier'), 'Prix pas encore lu') : '—';
            const f = feat(c);
            const lead = !multi(c) ? '' : mode === 'min' ? 'dès ' : mode === 'max' ? 'jusqu’à ' : '';
            return auctionLink(f.i, h('b', null, lead + fmt(f.a) + ' ₩' + (f.b ? ' •' : '')),
              (multi(c) ? 'Sur ' + c.ask.list.length + ' annonces, ' + WHICH[mode] + ' · ' : '') +
              (f.b ? 'une offre a déjà été faite' : 'mise de départ, pas encore d’offre'));
          } },
        { t: 'Fin de l’enchère', asc: true, get: c => (c.ask && feat(c).e > now ? feat(c).e : null),
          cell: c => {
            const f = c.ask ? feat(c) : null;
            return f && f.e > now ? h('span', { title: multi(c) ? 'Fin de l’annonce affichée sur cette ligne : ' + WHICH[mode] : '' }, 'dans ' + left(f.e - now)) : '—';
          } },
        { t: 'Alerte du site', get: c => (c.alert ? c.alert[2] : null), cell: c => (c.alert ? ago(c.alert[2]) : '—') },
        { t: 'Cherchée', get: c => db.wishSeen[c.id] || null, cell: c => (db.wishSeen[c.id] ? ago(db.wishSeen[c.id]) : '—') },
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
  const tile = (label, val, sub) => h('div', { class: 'tile' }, h('span', null, label), h('b', null, val), sub ? h('small', null, sub) : null);
  const plural = (n, one, many) => fmt(n) + ' ' + (n > 1 ? many : one);

  // ----- onglet Collection -----
  function renderCol() {
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
      tile('Déjà vendues aux enchères', fmt(known), 'sur ' + plural(rows.length, 'carte', 'cartes')),
      tile('Sans vente connue', fmt(rows.length - known),
        'comptées à 1 ₩ · ' + (total ? fmt(100 * estTotal / total) : '0') + ' % de la valeur totale'),
      proState() === true ? tile('Pas encore analysées', fmt(rows.filter(r => !db.prices[r.cardId]).length)) : null
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
        'Aucune carte en mémoire. Clique sur « Charger ma collection », ou ouvre simplement la page Collection du site.'));
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
    }, c.t + (ui.sortKey === c.k ? (ui.sortDir > 0 ? ' ▲' : ' ▼') : ''))));
    const body = rows.map(r => h('tr', null, cols.map(c => h('td', null, c.cell(r)))));
    e.table.replaceChildren(h('table', null, h('thead', null, head), h('tbody', null, body)));
  }

  // ----- onglet À vendre -----
  function sellList() {
    const selling = new Set(db.market.selling || []);
    const s = db.sell;
    return rowsCache
      .filter(r => r.price && r.price.n > 0 && r.value >= s.min && (s.favs || !r.starred) &&
        (s.doubt || r.price.rel.level > 0) && !selling.has(r.cardId))
      .sort((a, b) => (b.count > 1) - (a.count > 1) || b.value - a.value);
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
    e.sellTable.replaceChildren(sortTable('sell', [
      { t: '#', asc: true, get: r => rankOf.get(r), cell: r => rankOf.get(r) },
      { t: 'Carte', left: true, asc: true, get: r => r.title.toLowerCase(),
        cell: r => [r.title, r.shiny ? ' ✨' : '', r.starred ? ' ★' : '', r.count > 1 ? h('span', { class: 'tag' }, 'doublon') : null] },
      { t: 'Rareté', asc: true, get: r => rarOrder(r.rarity), cell: r => rarBadge(r.rarity) },
      { t: 'Ex.', get: r => r.count, cell: r => r.count },
      { t: 'Prix conseillé', get: r => r.value, cell: r => h('b', null, fmt(Math.round(r.value)) + ' ₩') },
      { t: 'Fiabilité', get: r => r.price.rel.level, cell: r => relCell(r.price) },
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
      ? names.map(n => h('option', { value: n, selected: n === ui.friend }, n))
      : [h('option', { value: '' }, 'aucun ami importé')]));
    const f = db.friends[ui.friend];
    if (!f) {
      e.frBody.replaceChildren(h('div', { class: 'empty' },
        'Exporte ta collection et envoie le fichier à un ami. Quand il t’envoie le sien, importe-le ici pour voir qui a quoi.'));
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
    const knownValue = c => { const p = priceOf(c.id); return p && p.n ? Math.max(p.med, DISCARD) : null; };
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
    e.frBody.replaceChildren(...[
      h('div', { class: 'tiles' },
        tile('En commun', fmt(common)),
        tile('Ses doublons qui te manquent', fmt(dupT)),
        tile('Tes doublons qui lui manquent', fmt(dupO)),
        tile('Tes souhaits dans sa collection', hasWish ? fmt(iWant.length) : '—', hasWish ? null : 'charge ta liste dans l’onglet Souhaits'),
        tile('Ses souhaits dans ta collection', friendHasWish ? fmt(theyWant.length) : '—', friendHasWish ? null : 'son fichier ne contient pas de liste')),
      h('div', { class: 'sub' }, 'Collection de ' + ui.friend + ' exportée le ' + fmtDate(f.at) + '. Les doublons sont en tête : ce sont les échanges les plus faciles.'),
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

  // Chaque minute, les enchères observées qui viennent de finir deviennent des prix.
  setInterval(() => { if (!job.running && settleObserved()) { saveDb(); refresh(); } }, 60000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
