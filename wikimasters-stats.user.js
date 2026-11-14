// ==UserScript==
// @name         WikiMasters – Stats de collection
// @namespace    wm-stats
// @version      1.16.0
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
      auctions: {}, history: {}, wish: {}, wishAt: 0, alerts: {}, wishSeen: {},
      obs: {}, obsSales: {}, obsRar: {}, trades: {}, tradesAt: 0,
      friends: {}, me: '', sell: { min: 10, favs: false, doubt: true, v: 2 }
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
        // Les prix douteux sont maintenant inclus par défaut : on coche la case une fois pour ceux qui avaient l'ancien réglage.
        if (base.sell.v !== 2) { base.sell.doubt = true; base.sell.v = 2; }
        if (!Array.isArray(base.pulls)) base.pulls = [];
        for (const k of ['auctions', 'history', 'wish', 'friends', 'mySales', 'alerts', 'wishSeen', 'obs', 'obsSales', 'obsRar', 'trades']) {
          if (!isObj(base[k])) base[k] = {};
        }
        // Nettoyage des doublons laissés par les versions précédentes : une carte rangée sous son propre
        // identifiant alors qu'elle l'est déjà sous celui de son exemplaire.
        const byExemplar = new Set();
        for (const k in base.cards) if (base.cards[k] && k !== base.cards[k].cardId) byExemplar.add(base.cards[k].cardId);
        for (const k in base.cards) if (base.cards[k] && k === base.cards[k].cardId && byExemplar.has(k)) delete base.cards[k];
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
        obtained: it.obtained_at || ''
      };
    }
    db.collectionAt = Date.now();
    saveDb();
    // Un chargement complet donne une photo fiable du jour ; une page isolée, non.
    if (replace) { db.collectionFullAt = Date.now(); saveDb(); priceCache = new Map(); snapshot(buildRows()); }
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
        if (okKey(a.id)) seenAuction.set(a.id, { c: a.card_id, a: price, b: a.current_bid != null });
        if (a.card && typeof a.card.wikipedia_title === 'string') seenTitle.set(a.card.wikipedia_title, a.card_id);
        const end = Date.parse(a.end_at);
        // Enchère observée : on note où en est l'offre. Une fois l'enchère finie, la dernière offre vue sert de prix de vente.
        if (okKey(a.id) && Number.isFinite(end)) {
          db.obs[a.id] = [a.card_id, price, a.current_bid != null ? 1 : 0, end, now, rarOf(a.snapshot_rarity || (a.card && a.card.rarity))];
        }
        // Tes propres annonces ne sont ni une offre à saisir ni une concurrence.
        if (db.userId && a.seller_id === db.userId) continue;
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
      if (a[0] === cardId && a[3] !== 2 && now - a[2] < 12 * 36e5 && (!best || a[2] > best[2])) best = [a[0], a[1], a[2], a[3], id];
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
        } else if (url.pathname === '/api/cards') {
          // Page « Toutes les cartes » : on apprend seulement les titres, pour poser les pastilles de valeur.
          p.then(r => r.ok && r.clone().json().then(j => {
            if (j && Array.isArray(j.cards)) for (const c of j.cards) if (c && okKey(c.id) && typeof c.wikipedia_title === 'string') seenTitle.set(c.wikipedia_title, c.id);
            overlaySoon();
          })).catch(() => {});
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
  // Bonne affaire : une annonce au moins 30 % sous la valeur médiane, quand cette médiane repose sur 3 ventes ou plus.
  const DEAL_PCT = 30;
  function dealPct(ask, price) {
    if (!ask || !price || !(price.n >= 3) || !(price.med > DISCARD)) return 0;
    const pct = Math.round(100 * (1 - ask.a / price.med));
    return pct >= DEAL_PCT ? pct : 0;
  }
  const isDeal = c => dealPct(c.ask, c.price) > 0;
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
        setStatus('Prix : ' + i + ' / ' + ids.length + eta(ids.length - i));
        if (i < ids.length) await pace();
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
        if (page < pages) await pace();
      }
      endJob(pages === 1 ? 'Ventes en cours à jour.'
        : seen + ' enchères lues. Leur prix sera enregistré quand elles seront finies, d’ici quelques minutes.', where);
    } catch (e) {
      endJob('Lecture du marché impossible (' + e.message + ').', where);
    }
  }

  // Les cartes passées dans tes échanges dont l'historique de ventes manque ou date.
  // Une carte donnée n'est plus dans ta collection : « Compléter les prix manquants » ne la voit donc jamais.
  const TRADE_BATCH = Infinity; // plus de plafond : tout est traité, au rythme du site
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
        await pace();
      }
      if (job.stop) return endJob('Arrêté, liste inchangée.', 'wishStatus');
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
  async function marketSearch(todo, label, noneText, where) {
    where = where || 'wishStatus';
    startJob(label + ' : 0 / ' + todo.length, where);
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
    for (const id in db.wish) if (askOf(id) && priceStale(id, db.wish[id][1])) out.push([id, db.wish[id][1]]);
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
      if (m) { m.count += c.count; m.starred = m.starred || c.starred; }
      else mine[c.cardId] = { title: c.title, rarity: c.rarity, count: c.count, starred: !!c.starred };
    }
    return mine;
  }
  // Échange proposé avec un ami : ce qu'il cherche et que tu as en trop, contre ce que tu cherches et qu'il a en trop.
  // Par défaut, seulement des doublons (personne ne perd une carte), jamais tes favoris.
  // On part de tout ce qui est possible, puis on retire du côté le plus lourd tant que l'écart de valeur diminue.
  function tradeFor(f, mine, singles) {
    const val = id => { const p = priceOf(id); return { v: p && p.n ? Math.max(p.med, DISCARD) : DISCARD, unknown: !p }; };
    const giveAll = [], recvAll = [];
    for (const id in (f.wish || {})) {
      const m = mine[id];
      if (!m || m.starred || (!singles && m.count < 2)) continue;
      giveAll.push(Object.assign({ id, title: m.title, rarity: m.rarity, count: m.count }, val(id)));
    }
    for (const id in db.wish) {
      const c = f.cards[id];
      if (!c || mine[id] || (!singles && c[2] < 2)) continue;
      recvAll.push(Object.assign({ id, title: c[0], rarity: c[1], count: c[2] }, val(id)));
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
  const TABS = [['home', 'Accueil'], ['col', 'Collection'], ['sell', 'À vendre'], ['sales', 'Mes ventes'], ['trades', 'Échanges'], ['wish', 'Souhaits'],
    ['pulls', 'Boosters'], ['trend', 'Évolution'], ['friends', 'Amis'], ['data', 'Sauvegarde']];
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
      (p.obs ? ', d’après des fins d’enchères observées (dernière offre vue, donc un minimum)' : '');
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
  function syncButtons() {
    const e = ui.el;
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
    // ----- boutons : un libellé court, et une bulle qui dit exactement ce que fait chacun -----
    const btn = (label, tip, onclick, cls) => h('button', { class: 'b' + (cls ? ' ' + cls : ''), 'data-tip': tip, onclick }, label);
    const stopBtn = () => btn('Stop', 'Arrête le traitement en cours. Ce qui a déjà été relevé est gardé.', () => { job.stop = true; });
    const chk = (label, tip, checked, onchange) => h('label', { class: 'chk', 'data-tip': tip },
      h('input', { type: 'checkbox', checked: !!checked, onchange }), label);

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
      'Lit les 500 enchères du marché qui se terminent bientôt, toutes cartes confondues (pas seulement les tiennes). ' +
      'À leur fin, leur dernière offre devient un « prix observé » : utile sans compte Pro, et pour le niveau de prix par rareté.',
      () => scanMarket(MARKET_PAGES, 'status', 'ending_soon'));
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
        group('Prix observés', 'Pour tous, avec ou sans compte Pro : le script note la dernière offre des enchères qu’il voit se terminer.', e.scan),
        group('Raretés concernées', '« Relever les prix » et « Trouver les annonces » ne traitent que les raretés cochées ici.', checks)),
      h('div', { class: 'run' }, e.status, e.stop),
      h('div', { class: 'filters' },
        h('input', { type: 'text', placeholder: 'Filtrer par titre, catégorie, étiquette…', 'data-tip': 'Ne garde que les cartes dont le titre, la catégorie ou une étiquette contient ce texte.',
          oninput: ev => { ui.text = ev.target.value.toLowerCase(); renderTable(); } }),
        rarSelect(ev => { ui.rarity = ev.target.value; renderTable(); })),
      fold('Options et export',
        chk('Afficher les prix des cartes tirées après chaque booster',
          'Après chaque paquet que tu ouvres toi-même, un petit panneau donne la valeur de chaque carte tirée (compte Pro).',
          db.autoPull !== false, ev => { db.autoPull = ev.target.checked; saveDb(); }),
        chk('Afficher la valeur sur les cartes du site',
          'Pose une petite pastille sur chaque carte affichée par le site (Collection, Marché, Toutes les cartes…) : valeur médiane, et sur le Marché l’écart avec le prix de l’annonce. Survole la pastille pour le détail.',
          db.overlay !== false, ev => { db.overlay = ev.target.checked; saveDb(); overlaySoon(); }),
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
    e.view_home = h('div', null, e.homeTiles, e.homeBody);

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
        group('Partager ma collection', 'Le fichier contient tes cartes, leur nombre d’exemplaires, ta liste de souhaits et les prix observés. Jamais l’historique réservé au Pro.',
          h('input', { type: 'text', value: db.me || '', style: 'min-width:140px', placeholder: 'ton pseudo', 'data-tip': 'Le nom sous lequel tes amis verront ta collection.',
            oninput: ev => { db.me = ev.target.value.slice(0, 40); saveDb(); } }),
          btn('Exporter pour mes amis', 'Télécharge un fichier à envoyer à tes amis.', exportMine, 'pri')),
        group('Ajouter un ami', null,
          h('input', { type: 'file', accept: '.json,application/json', 'data-tip': 'Choisis le fichier que ton ami t’a envoyé.',
            onchange: ev => { importFriend(ev.target.files[0]); ev.target.value = ''; } })),
        group('Comparer', null, e.frSelect,
          rarSelect(ev => { ui.frRarity = ev.target.value; renderFriends(); }),
          chk('Cartes en un seul exemplaire', 'Décochée, l’échange proposé ne contient que des doublons : personne ne perd une carte. Cochée, il peut aussi contenir des cartes que l’un de vous n’a qu’en un exemplaire.',
            !!ui.frSingles, ev => { ui.frSingles = ev.target.checked; renderFriends(); }),
          btn('Retirer cet ami', 'Oublie le fichier de cet ami.', () => { if (ui.friend) { delete db.friends[ui.friend]; ui.friend = ''; saveDb(); refresh(); } }))),
      e.frStatus, e.frBody);

    // ----- Mes ventes -----
    e.view_sales = h('div', null,
      h('div', { class: 'tools' }, group('Mettre à jour', null, e.mine2)),
      e.salesStatus, e.salesTiles, e.salesBody,
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

    // ----- Sauvegarde -----
    e.view_data = h('div', null,
      h('p', { class: 'line' }, 'Tes données sont rangées dans ce navigateur. Chrome et Zen ont donc chacun les leurs.'),
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
    refresh();
  }

  let rowsCache = [];
  function refresh() {
    if (!ui.el.host) return;
    priceCache = new Map();
    renderPull();
    overlaySoon();
    if (!ui.open) return;
    rowsCache = buildRows();
    snapshot(rowsCache);
    ui.el.sub.textContent = db.collectionAt
      ? 'Collection vue le ' + new Date(db.collectionAt).toLocaleString('fr-FR')
      : 'Collection pas encore chargée';
    syncButtons();
    ({ home: renderHome, col: renderCol, sell: renderSell, sales: renderSales, trades: renderTrades, wish: renderWish, pulls: renderPulls,
      trend: renderTrend, friends: renderFriends, data: () => {} })[ui.tab]();
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
      tile('Signalées, à vérifier', fmt(toCheck), 'alertes du site des 12 dernières heures'),
      withPrices ? tile('Bonnes affaires', fmt(all.filter(c => isDeal(c)).length), 'au moins ' + DEAL_PCT + ' % sous la valeur médiane') : null,
      tile('Chez un ami', fmt(atFriends), plural(Object.keys(db.friends).length, 'ami importé', 'amis importés')));
    const left = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + ' min' : Math.round(m / 60) + ' h'; };
    const list = all
      .filter(c => (!ui.wishRarity || c.rarity === ui.wishRarity) && (!ui.wishAvail || rank(c) < 3) && !(db.wishHideOwned && c.owned) &&
        (!ui.wishDeals || isDeal(c)))
      .sort((a, b) => rank(a) - rank(b) || dealPct(b.ask, b.price) - dealPct(a.ask, a.price) || (a.ask && b.ask ? a.ask.a - b.ask.a : 0) ||
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
        h('td', null, au.e > now ? 'fin dans ' + left(au.e - now) : 'fin inconnue'),
        withPrices && maxBid(c.price) != null ? h('td', null, roomTag(c.price, au)) : null)))))) : null);
    e.wishBody.replaceChildren(
      sortTable('wish', [
        { t: 'Carte', left: true, asc: true, get: c => c.title.toLowerCase(),
          cell: c => [multi(c) ? h('span', { class: 'caret' }, isOpen(c) ? '▾' : '▸') : h('span', { class: 'caret' }), c.title,
            multi(c) ? h('span', { class: 'tag' }, c.ask.list.length + ' annonces') : null,
            isDeal(c) ? h('span', { class: 'tag deal', title: 'L’annonce la moins chère est ' + dealPct(c.ask, c.price) + ' % sous la valeur médiane (' +
              fmt(c.price.med) + ' ₩, ' + c.price.n + ' ventes)' }, 'bonne affaire −' + dealPct(c.ask, c.price) + ' %') : null,
            c.owned ? h('span', { class: 'tag', title: 'Cette carte est déjà dans ta collection' }, 'possédée') : null] },
        { t: 'Rareté', asc: true, get: c => rarOrder(c.rarity), cell: c => rarBadge(c.rarity) },
        withPrices ? { t: 'Valeur médiane', tip: 'Médiane des dernières ventes de la carte : sert à juger si une annonce est une bonne affaire.', get: c => (c.price && c.price.n ? c.price.med : null),
          cell: c => (c.price && c.price.n ? fmt(c.price.med) + ' ₩' : '—') } : null,
        { t: 'En vente à', tip: 'Prix de l’annonce affichée sur la ligne. Un point = une offre a déjà été faite. Le lien ouvre l’annonce. « à vérifier » : signalée par le site, prix pas encore lu.', asc: true, get: c => (c.ask ? feat(c).a : null),
          cell: c => {
            if (!c.ask) return c.alert ? auctionLink(c.alert[4], h('span', { class: 'est' }, 'à vérifier'), 'Prix pas encore lu') : '—';
            const f = feat(c);
            const lead = !multi(c) ? '' : mode === 'min' ? 'dès ' : mode === 'max' ? 'jusqu’à ' : '';
            return auctionLink(f.i, h('b', null, lead + fmt(f.a) + ' ₩' + (f.b ? ' •' : '')),
              (multi(c) ? 'Sur ' + c.ask.list.length + ' annonces, ' + WHICH[mode] + ' · ' : '') +
              (f.b ? 'une offre a déjà été faite' : 'mise de départ, pas encore d’offre'));
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
            return [h('b', null, (c.price.rel.level === 0 ? '≈ ' : '') + fmt(mx) + ' ₩'), c.ask ? roomTag(c.price, feat(c)) : null];
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
      .map(id => ({ id, title: db.wish[id][0], rarity: db.wish[id][1], ask: askOf(id), price: priceOf(id) })).filter(c => c.ask);
    const deals = wish.filter(isDeal).sort((a, b) => dealPct(b.ask, b.price) - dealPct(a.ask, a.price));
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
        isDeal(c) ? h('span', { class: 'tag deal' }, '−' + dealPct(c.ask, c.price) + ' %') : null,
        h('span', { class: 'sub', 'data-tip': 'Fin de l’enchère' }, c.ask.e > now ? left(c.ask.e - now) : ''),
        auctionLink(c.ask.i, h('b', null, fmt(c.ask.a) + ' ₩'), 'Ouvrir l’annonce'))))
        : none('Aucun souhait en vente connu. Onglet Souhaits : « Vérifier les alertes » ou « Trouver les annonces ».'),
      'Les bonnes affaires d’abord, puis les enchères qui finissent le plus tôt.'));

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
    const tv = l => l.reduce((a, c) => { const p = priceOf(c[0]); return a + (p && p.n ? Math.max(p.med, DISCARD) : 0); }, 0);
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
  function sellList() {
    const selling = new Set(db.market.selling || []);
    const s = db.sell;
    return rowsCache
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
  setInterval(() => { if (!job.running && settleObserved()) { saveDb(); refresh(); } }, 60000);

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
    if (o) return { c: o[0], a: o[1], b: !!o[2] };
    for (const cid in db.market.asks) {
      const x = (db.market.asks[cid].list || []).find(y => y.i === id);
      if (x) return { c: cid, a: x.a, b: x.b };
    }
    return null;
  }
  function overlaySoon() {
    titleIdx = null;
    if (!scanTimer) scanTimer = setTimeout(scanCards, 250);
  }
  // Contenu de la pastille d'une carte. au = l'annonce quand la carte est affichée sur le Marché.
  function badgeFor(cardId, au, mine) {
    const p = priceOf(cardId);
    const have = mine[cardId];
    if (!p) return null;
    const lines = ['WikiMasters Stats'];
    let text, border = '#6b7280', bg = 'rgba(10,15,13,.85)';
    if (!p.n) {
      text = '1 ₩';
      lines.push('Aucune vente connue : la carte vaut la défausse, 1 ₩.');
    } else {
      const med = Math.max(p.med, DISCARD), mx = maxBid(p);
      text = (p.rel.level === 0 ? '≈ ' : '') + fmt(Math.round(med)) + ' ₩';
      border = ['#6b7280', '#f59e0b', '#10b981'][p.rel.level];
      lines.push('Valeur médiane : ' + fmt(Math.round(med)) + ' ₩ (' + plural(p.n, 'vente', 'ventes') + (p.obs ? ' observées' : '') + ', fiabilité ' + REL[p.rel.level].toLowerCase() + ')');
      if (au) {
        const pct = Math.round(100 * (1 - au.a / med));
        lines.push('Prix de l’annonce : ' + fmt(au.a) + ' ₩' + (au.b ? ' (offre déjà faite)' : ' (mise de départ)'));
        lines.push('Enchère max conseillée : ' + fmt(mx) + ' ₩' + (mx > au.a ? ', marge ' + fmt(mx - au.a) + ' ₩' : ' : déjà atteinte'));
        if (dealPct(au, p)) { text += ' · −' + pct + ' %'; bg = 'rgba(6,95,70,.92)'; lines.push('Bonne affaire : ' + pct + ' % sous la valeur.'); }
        else if (au.a >= med) { text += ' · trop cher'; bg = 'rgba(127,29,29,.92)'; }
      } else {
        lines.push('Enchère max conseillée : ' + fmt(mx) + ' ₩');
      }
    }
    if (have) { text += ' ✓'; lines.push('Tu l’as déjà' + (have.count > 1 ? ' (' + have.count + ' exemplaires)' : '') + '.'); }
    return { text, border, bg, tip: lines.join('\n') };
  }
  function scanCards() {
    scanTimer = 0;
    const on = db.overlay !== false && showPrices();
    const keep = new Set();
    if (on) {
      const mine = myCards();
      for (const card of document.querySelectorAll('.rounded-2xl.cursor-pointer')) {
        // Le titre est dans le h3 de la carte ; à défaut, dans le texte de l'image (sauf le logo des cartes sans image).
        const h3 = card.querySelector('h3'), img = card.querySelector('img[alt]:not([alt=""]):not([alt="WikiMasters"])');
        const title = ((h3 && h3.textContent) || (img && img.alt) || '').trim();
        const link = card.closest('a[href^="/marketplace/"]');
        if (!title && !link) continue;
        const auId = link ? link.getAttribute('href').split('/')[2] : '';
        const au = auId ? auctionInfo(auId) : null;
        const cardId = au ? au.c : title ? cardByTitle(title) : null;
        const b = cardId ? badgeFor(cardId, au, mine) : null;
        let el = card.querySelector(':scope > .' + BADGE);
        if (!b) { if (el) el.remove(); continue; }
        keep.add(card);
        const key = cardId + '|' + b.text + '|' + b.bg + '|' + b.border + '|' + b.tip;
        if (el && el.dataset.key === key) continue;
        if (!el) {
          el = document.createElement('span');
          el.className = BADGE;
          if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
          card.append(el);
        }
        el.dataset.key = key;
        el.textContent = b.text;
        el.title = b.tip;
        el.style.cssText = 'position:absolute;top:6px;right:6px;z-index:40;padding:1px 7px;border-radius:999px;' +
          'font:700 11px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;white-space:nowrap;pointer-events:auto;cursor:help;' +
          'box-shadow:0 1px 4px rgba(0,0,0,.6);background:' + b.bg + ';border:1.5px solid ' + b.border;
      }
    }
    for (const el of document.querySelectorAll('.' + BADGE)) if (!keep.has(el.parentElement)) el.remove();
  }
  function startOverlay() {
    new MutationObserver(() => { if (!scanTimer) scanTimer = setTimeout(scanCards, 300); })
      .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['alt', 'href'] });
    overlaySoon();
  }

  const start = () => { mount(); openSellForm(); startOverlay(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
