// ==UserScript==
// @name         WikiMasters – Stats de collection
// @namespace    wm-stats
// @version      1.1.0
// @description  Tableau de valeur de ta collection WikiMasters. Lecture seule : ne joue pas, n'ouvre rien, n'échange rien.
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
  const nativeFetch = window.fetch.bind(window);

  // ---------- stockage local (reste dans ton navigateur) ----------
  let db = loadDb();
  function loadDb() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.cards && d.prices) { d.pro = d.pro || {}; return d; }
    } catch (e) {}
    return { cards: {}, prices: {}, pro: {}, userId: '', collectionAt: 0 };
  }
  function saveDb() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
  }

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
        rarity: c.rarity || '?',
        atk: c.atk, def: c.def, q: c.q_score, views: c.pageviews,
        cat: c.category || '', url: c.wikipedia_url || '',
        count: it.count || 1, shiny: !!it.is_shiny, starred: !!it.starred,
        tags: (it.tags || []).map(t => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean),
        obtained: it.obtained_at || ''
      };
    }
    db.collectionAt = Date.now();
    saveDb();
    refresh();
  }

  function ingestSales(cardId, j) {
    if (!j || typeof j !== 'object') return;
    const src = Array.isArray(j.recent) && j.recent.length ? j.recent : (j.sales || []);
    const sales = src
      .filter(s => s && typeof s.final_price === 'number')
      .map(s => ({ p: s.final_price, t: s.settled_at || '' }))
      .sort((a, b) => (a.t < b.t ? 1 : -1))
      .slice(0, 10);
    db.prices[cardId] = { at: Date.now(), sales };
    saveDb();
    refresh();
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
  function showPrices() { return proState() === true || Object.keys(db.prices).length > 0; }

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
        p.then(r => r.ok && r.clone().json().then(j => j && Array.isArray(j.cards) && onPull(j.cards))).catch(() => {});
      } else if (url.origin === location.origin && method === 'GET') {
        const m = url.pathname.match(/^\/api\/marketplace\/cards\/([^/]+)\/sales$/);
        if (m) {
          p.then(r => r.ok && r.clone().json().then(j => ingestSales(m[1], j))).catch(() => {});
        } else if (url.pathname === '/api/my-collection') {
          p.then(r => r.ok && r.clone().json().then(j => ingestCollection(j.collection, false))).catch(() => {});
        }
      }
    } catch (e) {}
    return p;
  };

  // ---------- calculs ----------
  function priceOf(cardId) {
    const p = db.prices[cardId];
    if (!p) return null;
    if (!p.sales.length) return { n: 0, at: p.at };
    const v = p.sales.map(s => s.p);
    return {
      avg: v.reduce((a, b) => a + b, 0) / v.length, med: median(v),
      last: v[0], min: Math.min(...v), max: Math.max(...v), n: v.length, at: p.at
    };
  }
  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function buildRows() {
    const rows = Object.entries(db.cards).map(([id, c]) => ({ id, ...c, price: priceOf(c.cardId) }));
    const med = {};
    for (const r of new Set(rows.map(x => x.rarity))) {
      med[r] = median(rows.filter(x => x.rarity === r && x.price && x.price.n).map(x => x.price.med));
    }
    for (const r of rows) {
      const known = r.price && r.price.n > 0;
      r.value = known ? r.price.med : med[r.rarity];
      r.est = !known && r.value != null;
      r.total = (r.value || 0) * r.count;
    }
    return rows;
  }
  function missingIds() {
    const now = Date.now();
    const ids = new Set();
    for (const c of Object.values(db.cards)) {
      if (!ui.chosen.has(c.rarity)) continue;
      const p = db.prices[c.cardId];
      if (!p || now - p.at > DAY) ids.add(c.cardId);
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
  function startJob(msg) { job.running = true; job.stop = false; setStatus(msg); syncButtons(); }
  function endJob(msg) { job.running = false; setStatus(msg); syncButtons(); refresh(); }

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
      for (const id of ids) {
        if (job.stop) break;
        ingestSales(id, await getJSON('/api/marketplace/cards/' + encodeURIComponent(id) + '/sales'));
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

  // ---------- après un booster : prix des cartes tirées ----------
  const DISCARD = 1; // wikibidous gagnés en défaussant une carte
  const pull = { open: false, cards: [], queue: [], busy: false, note: '' };
  function advice(price) {
    if (!price) return { cls: 'unk', text: '—' };
    if (!price.n) return { cls: 'unk', text: 'Aucune vente' };
    return price.med > DISCARD
      ? { cls: 'sell', text: 'Vendre ~' + fmt(Math.round(price.med)) + ' ₩' }
      : { cls: 'drop', text: 'Défausser' };
  }
  function onPull(list) {
    const pro = proState();
    if (pro === false || db.autoPull === false) return;
    const cards = [];
    for (const it of list) {
      const c = (it && it.card) || it;
      if (!c) continue;
      const cardId = it.card ? c.id : (c.card_id || c.id);
      if (cardId) cards.push({ cardId, title: c.wikipedia_title || c.title || '?', rarity: c.rarity || '?' });
    }
    if (!cards.length) return;
    pull.cards = cards;
    pull.open = true;
    pull.note = pro === true ? '' : 'Statut Pro pas encore détecté : recharge la page (F5) pour activer les prix.';
    if (pro === true) {
      const now = Date.now();
      for (const c of cards) {
        const p = db.prices[c.cardId];
        if ((!p || now - p.at > DAY) && !pull.queue.includes(c.cardId)) pull.queue.push(c.cardId);
      }
      runPullQueue();
    }
    renderPull();
  }
  async function runPullQueue() {
    if (pull.busy) return;
    pull.busy = true;
    try {
      while (pull.queue.length) {
        const id = pull.queue[0];
        ingestSales(id, await getJSON('/api/marketplace/cards/' + encodeURIComponent(id) + '/sales'));
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
        h('div', { class: 't' }, h('b', null, c.title), h('span', null, info)),
        h('span', { class: 'adv ' + a.cls }, a.text));
    });
    if (pull.note) rows.push(h('div', { class: 'row sub' }, pull.note));
    e.pullList.replaceChildren(...rows);
  }

  // ---------- interface ----------
  const ui = {
    open: false, chosen: new Set(['L', 'UR', 'SR']),
    sortKey: 'total', sortDir: -1, text: '', rarity: '', el: {}
  };
  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const fmt = v => (v == null || Number.isNaN(v) ? '—' : nf.format(v));
  const fmtDate = t => (t ? new Date(t).toLocaleDateString('fr-FR') : '—');

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') e.className = props[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
      else if (k in e) e[k] = props[k];
      else e.setAttribute(k, props[k]);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
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
    .sub{color:#8b9a94;font-size:12px}
    .body{padding:14px 18px;overflow:auto;flex:1}
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
    .tile{background:#151c19;border:1px solid #26302c;border-radius:10px;padding:10px 12px}
    .tile b{display:block;font-size:20px;margin-top:2px;color:#34d399;font-variant-numeric:tabular-nums}
    .tile span{color:#8b9a94;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
    .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
    button.b{background:#1c2622;color:#e5e7eb;border:1px solid #33413b;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer}
    button.b:hover:not(:disabled){border-color:#34d399}
    button.b.pri{background:#10b981;color:#04130d;border-color:#10b981;font-weight:700}
    button.b:disabled{opacity:.45;cursor:default}
    button.x{background:none;border:0;color:#8b9a94;font-size:22px;cursor:pointer;line-height:1}
    label.chk{display:inline-flex;gap:4px;align-items:center;color:#cbd5d1;cursor:pointer}
    input[type=text],select{background:#151c19;color:#e5e7eb;border:1px solid #33413b;border-radius:8px;padding:7px 10px;font-size:13px}
    input[type=text]{min-width:220px}
    .status{color:#fbbf24;min-height:18px;margin-bottom:8px}
    .rar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
    .pill{background:#151c19;border:1px solid #26302c;border-radius:999px;padding:4px 10px;font-variant-numeric:tabular-nums}
    .pill i{font-style:normal;color:#8b9a94}
    table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
    th,td{padding:6px 8px;border-bottom:1px solid #1f2925;text-align:right;white-space:nowrap}
    th:first-child,td:first-child{text-align:left;white-space:normal}
    th{position:sticky;top:-14px;background:#0f1412;color:#8b9a94;font-weight:600;cursor:pointer;user-select:none}
    th:hover{color:#e5e7eb}
    td a{color:#e5e7eb;text-decoration:none}
    td a:hover{color:#34d399}
    .est{color:#8b9a94;font-style:italic}
    .r{display:inline-block;min-width:26px;text-align:center;border-radius:5px;padding:1px 5px;font-weight:700;font-size:11px;background:#33413b}
    .r-L{background:#fde047;color:#111}.r-UR{background:#fb923c;color:#111}.r-SR{background:#f472b6;color:#111}
    .r-R{background:#c4b5fd;color:#111}.r-PC{background:#7dd3fc;color:#111}.r-C{background:#4b5563}
    .adv{display:inline-block;border-radius:999px;padding:3px 9px;font-weight:700;font-size:12px;white-space:nowrap}
    .adv.sell{background:#10b981;color:#04130d}.adv.drop{background:#374151;color:#e5e7eb}.adv.unk{background:#1c2622;color:#8b9a94}
    .pull{position:fixed;right:18px;bottom:66px;z-index:2147483000;width:min(420px,calc(100vw - 36px));background:#0f1412;
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
  `;

  const estCell = (r, v) => (r.value == null ? '—' : h('span', { class: r.est ? 'est' : '' }, (r.est ? '~' : '') + fmt(v)));
  const pr = (r, k) => (r.price ? r.price[k] : undefined);
  const COLS = [
    { k: 'title', t: 'Carte', get: r => r.title.toLowerCase(),
      cell: r => [r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.title) : r.title,
        r.shiny ? ' ✨' : '', r.starred ? ' ★' : ''] },
    { k: 'rarity', t: 'Rareté', get: r => { const i = RARITIES.indexOf(r.rarity); return i < 0 ? 99 : i; },
      cell: r => h('span', { class: 'r r-' + r.rarity }, r.rarity) },
    { k: 'count', t: 'Ex.', get: r => r.count, cell: r => r.count },
    { k: 'atk', t: 'ATK', get: r => r.atk, cell: r => fmt(r.atk) },
    { k: 'def', t: 'DEF', get: r => r.def, cell: r => fmt(r.def) },
    { k: 'q', t: 'Q-Score', get: r => r.q, cell: r => fmt(r.q) },
    { k: 'views', t: 'Vues 30j', get: r => r.views, cell: r => fmt(r.views) },
    { k: 'value', t: 'Valeur', price: true, get: r => r.value, cell: r => estCell(r, r.value) },
    { k: 'last', t: 'Dernière', price: true, get: r => pr(r, 'last'), cell: r => fmt(pr(r, 'last')) },
    { k: 'min', t: 'Min', price: true, get: r => pr(r, 'min'), cell: r => fmt(pr(r, 'min')) },
    { k: 'max', t: 'Max', price: true, get: r => pr(r, 'max'), cell: r => fmt(pr(r, 'max')) },
    { k: 'n', t: 'Ventes', price: true, get: r => pr(r, 'n'), cell: r => (r.price ? r.price.n : '—') },
    { k: 'total', t: 'Total', price: true, get: r => (r.value == null ? null : r.total), cell: r => estCell(r, r.total) },
    { k: 'adv', t: 'Conseil', price: true, get: r => (pr(r, 'n') ? r.price.med : null),
      cell: r => { const a = advice(r.price); return r.price ? h('span', { class: 'adv ' + a.cls }, a.text) : '—'; } },
    { k: 'at', t: 'Prix du', price: true, get: r => pr(r, 'at'), cell: r => (r.price ? fmtDate(r.price.at) : '—') }
  ];

  function setStatus(msg) { if (ui.el.status) ui.el.status.textContent = msg || ''; }
  function syncButtons() {
    const e = ui.el;
    if (!e.load) return;
    const pro = proState();
    e.load.disabled = job.running;
    e.fill.disabled = job.running || pro !== true;
    e.stop.disabled = !job.running;
    e.fill.textContent = pro === true
      ? 'Compléter les prix manquants (' + missingIds().length + ')'
      : 'Prix : réservé aux comptes Pro';
    e.pro.textContent = pro === true ? ''
      : pro === false
        ? 'Compte non Pro : le site ne donne pas l’historique des ventes, donc pas de valeurs ici. Le reste du tableau et l’export fonctionnent.'
        : 'Statut Pro pas encore détecté : recharge la page (F5).';
  }

  function mount() {
    if (ui.el.host) return;
    const host = h('div', { id: 'wm-stats-host' });
    const root = host.attachShadow({ mode: 'open' });
    const e = ui.el;
    e.host = host;
    e.status = h('div', { class: 'status' });
    e.tiles = h('div', { class: 'tiles' });
    e.rar = h('div', { class: 'rar' });
    e.table = h('div');
    e.sub = h('div', { class: 'sub' });
    e.pro = h('div', { class: 'sub', style: 'margin-bottom:10px' });
    e.load = h('button', { class: 'b pri', onclick: loadCollection }, 'Charger ma collection');
    e.fill = h('button', { class: 'b', onclick: fillPrices }, 'Compléter les prix manquants');
    e.stop = h('button', { class: 'b', disabled: true, onclick: () => { job.stop = true; } }, 'Stop');
    const checks = RARITIES.map(r => h('label', { class: 'chk' },
      h('input', {
        type: 'checkbox', checked: ui.chosen.has(r),
        onchange: ev => { ev.target.checked ? ui.chosen.add(r) : ui.chosen.delete(r); syncButtons(); }
      }), r));
    e.back = h('div', { class: 'back', onclick: ev => { if (ev.target === e.back) toggle(false); } },
      h('div', { class: 'panel' },
        h('header', null,
          h('div', { style: 'flex:1' }, h('h1', null, 'Stats de collection'), e.sub),
          h('button', { class: 'x', title: 'Fermer', onclick: () => toggle(false) }, '×')),
        h('div', { class: 'body' },
          e.tiles, e.rar,
          h('div', { class: 'bar' }, e.load, e.fill, e.stop, h('span', { class: 'sub' }, 'Prix pour :'), checks),
          h('div', { class: 'bar' }, h('label', { class: 'chk' },
            h('input', { type: 'checkbox', checked: db.autoPull !== false,
              onchange: ev => { db.autoPull = ev.target.checked; saveDb(); } }),
            'Afficher les prix des cartes tirées après chaque booster que j’ouvre')),
          e.pro,
          h('div', { class: 'bar' },
            h('input', { type: 'text', placeholder: 'Filtrer par titre, catégorie, étiquette…',
              oninput: ev => { ui.text = ev.target.value.toLowerCase(); renderTable(); } }),
            h('select', { onchange: ev => { ui.rarity = ev.target.value; renderTable(); } },
              h('option', { value: '' }, 'Toutes les raretés'), RARITIES.map(r => h('option', { value: r }, r))),
            h('button', { class: 'b', onclick: exportCsv }, 'Exporter en CSV'),
            h('button', { class: 'b', onclick: clearPrices }, 'Oublier les prix')),
          e.status, e.table,
          h('div', { class: 'note' },
            'Valeur = médiane des 10 dernières ventes (moins sensible qu’une moyenne aux enchères qui s’emballent). ',
            'Conseil = vendre si cette valeur dépasse le wikibidou que rapporte la défausse. En italique avec « ~ » : estimation (médiane des cartes de même rareté dont le prix est connu). ',
            'Les prix se remplissent aussi tout seuls quand tu ouvres l’onglet Marché d’une carte.'))));
    e.pullList = h('div');
    e.pull = h('div', { class: 'pull' },
      h('header', null, h('h1', null, 'Dernier booster'),
        h('button', { class: 'x', title: 'Fermer', onclick: () => { pull.open = false; renderPull(); } }, '×')),
      e.pullList);
    root.append(h('style', null, CSS),
      h('button', { class: 'fab', onclick: () => toggle() }, '📊 Stats'), e.pull, e.back);
    document.documentElement.append(host);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && ui.open) toggle(false); });
  }

  function toggle(force) {
    ui.open = force == null ? !ui.open : force;
    ui.el.back.classList.toggle('open', ui.open);
    refresh();
  }

  let rowsCache = [];
  function refresh() {
    if (!ui.el.host) return;
    renderPull();
    if (!ui.open) return;
    rowsCache = buildRows();
    const rows = rowsCache;
    const e = ui.el;
    const nCards = rows.reduce((a, r) => a + r.count, 0);
    const total = rows.reduce((a, r) => a + r.total, 0);
    const estTotal = rows.reduce((a, r) => a + (r.est ? r.total : 0), 0);
    const known = rows.filter(r => r.price && r.price.n > 0).length;
    const tile = (label, val) => h('div', { class: 'tile' }, h('span', null, label), h('b', null, val));
    const withPrices = showPrices();
    const avg = k => (rows.length ? rows.reduce((a, r) => a + (r[k] || 0), 0) / rows.length : null);
    if (!withPrices && (COLS.find(c => c.k === ui.sortKey) || {}).price) { ui.sortKey = 'rarity'; ui.sortDir = 1; }
    e.tiles.replaceChildren(...(withPrices ? [
      tile('Cartes', fmt(nCards)),
      tile('Valeur totale', fmt(total) + ' ₩'),
      tile('Dont estimée', total ? fmt(100 * estTotal / total) + ' %' : '—'),
      tile('Prix connus', known + ' / ' + rows.length)
    ] : [
      tile('Cartes', fmt(nCards)),
      tile('Cartes différentes', fmt(rows.length)),
      tile('ATK moyenne', fmt(avg('atk'))),
      tile('DEF moyenne', fmt(avg('def')))
    ]));
    e.rar.replaceChildren(...RARITIES.filter(r => rows.some(x => x.rarity === r)).map(r => {
      const g = rows.filter(x => x.rarity === r);
      const n = g.reduce((a, x) => a + x.count, 0);
      return h('span', { class: 'pill' }, h('span', { class: 'r r-' + r }, r), ' ',
        n, h('i', null, n > 1 ? ' cartes' : ' carte'),
        withPrices ? [h('i', null, ' · '), fmt(g.reduce((a, x) => a + x.total, 0)), ' ₩'] : null);
    }));
    e.sub.textContent = db.collectionAt
      ? 'Collection vue le ' + new Date(db.collectionAt).toLocaleString('fr-FR')
      : 'Collection pas encore chargée';
    syncButtons();
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
    const cols = COLS.filter(c => withPrices || !c.price);
    const head = h('tr', null, cols.map(c => h('th', {
      onclick: () => {
        if (ui.sortKey === c.k) ui.sortDir = -ui.sortDir;
        else { ui.sortKey = c.k; ui.sortDir = c.k === 'title' || c.k === 'rarity' ? 1 : -1; }
        renderTable();
      }
    }, c.t + (ui.sortKey === c.k ? (ui.sortDir > 0 ? ' ▲' : ' ▼') : ''))));
    const body = rows.map(r => h('tr', null, cols.map(c => h('td', null, c.cell(r)))));
    e.table.replaceChildren(h('table', null, h('thead', null, head), h('tbody', null, body)));
  }

  function exportCsv() {
    refresh();
    const cell = v => {
      const s = v == null ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v);
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['Carte', 'Rareté', 'Exemplaires', 'Shiny', 'ATK', 'DEF', 'Q-Score', 'Vues 30j', 'Catégorie', 'Étiquettes',
      'Valeur (médiane)', 'Estimée', 'Moyenne', 'Dernière vente', 'Min', 'Max', 'Nb ventes', 'Valeur totale', 'Conseil',
      'Prix relevé le', 'Obtenue le', 'Wikipédia'];
    const lines = visibleRows().map(r => {
      const p = r.price || {};
      return [r.title, r.rarity, r.count, r.shiny ? 'oui' : 'non', r.atk, r.def, r.q, r.views, r.cat, r.tags.join(', '),
        r.value, r.est ? 'oui' : 'non', p.avg, p.last, p.min, p.max, p.n, r.total, r.price ? advice(r.price).text : '',
        p.at ? fmtDate(p.at) : '', r.obtained ? fmtDate(r.obtained) : '', r.url].map(cell).join(';');
    });
    const blob = new Blob(['\ufeff' + [head.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'wikimasters-collection-' + new Date().toISOString().slice(0, 10) + '.csv' });
    ui.el.host.shadowRoot.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function clearPrices() {
    if (job.running) return;
    db.prices = {};
    saveDb();
    setStatus('Prix oubliés. La collection est conservée.');
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
