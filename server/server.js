// Serveur du pool de prix partagé. Node 24, sans dépendance : node:http et node:sqlite.
// Variables d'environnement : GROUP_KEY (obligatoire, 24 caractères au moins), DB_PATH, PORT, ALLOWED_ORIGINS.
// Mode relais (pool local sur ton PC) : UPSTREAM_URL et UPSTREAM_KEY (le pool du NAS), SYNC_MINUTES (5 par défaut).
// HOST : l'adresse d'écoute. Par défaut toutes les interfaces (le conteneur du NAS) ; 127.0.0.1 pour n'écouter que ce PC.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { openDb, applyPush, pullCards, knownAuctions, poolStats, putProfile, listProfiles, removeProfile } = require('./db');
const { parsePush, parseIds, parseProfile, httpError, okId } = require('./validate');
const { syncOnce, syncStatus } = require('./sync');

const VERSION = '1.3.0';
const MAX_BODY = 2 * 1024 * 1024;
const MAX_PULL = 500, MAX_KNOWN = 1000;

// Comparaison de la clé en temps constant : la durée ne trahit pas les bons caractères.
function sameKey(given, expected) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(expected);
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}

// Derrière le tunnel, toutes les requêtes arrivent de l'adresse du tunnel : l'adresse du membre est dans les en-têtes.
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on('data', c => {
      if (tooBig) return; // on laisse finir l'envoi sans le garder, pour répondre proprement
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(httpError(413, 'corps trop gros (2 Mo au plus)'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(httpError(400, 'JSON invalide')); }
    });
    req.on('error', reject);
  });
}

function createHandler({ db, groupKey, allowedOrigins, now = Date.now, perMinute = 120, upstreamStatus = null }) {
  const allowed = new Set(allowedOrigins);
  const hits = new Map(); // adresse → dates des requêtes de la dernière minute
  const sweep = setInterval(() => {
    const t = now() - 6e4;
    for (const [ip, list] of hits) { const keep = list.filter(x => x > t); if (keep.length) hits.set(ip, keep); else hits.delete(ip); }
  }, 6e4);
  sweep.unref();

  const handler = async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && allowed.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    const send = (status, body, extra) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, ...(extra || {}) });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-group-key',
        'access-control-max-age': '600', 'access-control-allow-private-network': 'true'
      });
      return res.end();
    }
    try {
      const ip = clientIp(req), t = now();
      const list = (hits.get(ip) || []).filter(x => x > t - 6e4);
      if (list.length >= perMinute) {
        hits.set(ip, list);
        return send(429, { error: 'trop de requêtes, réessaie plus tard' }, { 'retry-after': String(Math.max(1, Math.ceil((list[0] + 6e4 - t) / 1000))) });
      }
      list.push(t);
      hits.set(ip, list);

      const url = new URL(req.url, 'http://pool');
      const route = req.method + ' ' + url.pathname;
      // En mode relais, l'état de la synchronisation vers le NAS (sans son adresse ni sa clé).
      if (route === 'GET /v1/health') return send(200, upstreamStatus ? { ok: true, version: VERSION, upstream: upstreamStatus() } : { ok: true, version: VERSION });
      const routes = new Set(['GET /v1/stats', 'POST /v1/push', 'POST /v1/pull', 'POST /v1/known', 'POST /v1/profile', 'GET /v1/profiles', 'POST /v1/profile/remove']);
      if (!routes.has(route)) return send(404, { error: 'route inconnue' });
      if (!sameKey(req.headers['x-group-key'], groupKey)) return send(401, { error: 'clé de groupe absente ou fausse' });
      if (route === 'GET /v1/stats') return send(200, poolStats(db));
      if (route === 'GET /v1/profiles') return send(200, listProfiles(db));
      const body = await readJson(req);
      // Profils (amis par le pool) : collection et souhaits des membres qui ont choisi de les partager.
      if (route === 'POST /v1/profile') { putProfile(db, parseProfile(body), now()); return send(200, { ok: true }); }
      if (route === 'POST /v1/profile/remove') {
        if (!okId(body && body.id)) throw httpError(400, 'id invalide');
        return send(200, { removed: removeProfile(db, body.id) });
      }
      if (route === 'POST /v1/push') return send(200, applyPush(db, parsePush(body, now()), now()));
      if (route === 'POST /v1/pull') return send(200, pullCards(db, parseIds(body && body.cards, MAX_PULL)));
      return send(200, knownAuctions(db, parseIds(body && body.auctions, MAX_KNOWN)));
    } catch (e) {
      if (e && e.status) return send(e.status, { error: e.message });
      console.error('Erreur du pool :', e && e.message);
      return send(500, { error: 'erreur interne' });
    }
  };
  handler.close = () => clearInterval(sweep);
  return handler;
}

// upstream : { url, key, everyMs } pour le mode relais. Ce que ce pool reçoit part tout seul vers le pool d'arrivée, à chaque
// passage (toutes les 5 min par défaut), dès qu'il est joignable. Rien n'est perdu quand il ne l'est pas.
async function start({ dbPath, port, host, groupKey, allowedOrigins, perMinute, upstream }) {
  if (typeof groupKey !== 'string' || groupKey.length < 24) throw new Error('GROUP_KEY doit faire au moins 24 caractères');
  const db = openDb(dbPath);
  const relay = upstream && upstream.url && upstream.key ? upstream : null;
  const handler = createHandler({ db, groupKey, allowedOrigins, perMinute, upstreamStatus: relay ? () => syncStatus(db) : null });
  const server = http.createServer(handler);
  let stopped = false, busy = false, timers = [];
  if (relay) {
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const r = await syncOnce(db, relay);
        if (r.sent || r.unsold) console.log('Synchro vers le pool du NAS : ' + r.sent + ' ventes, ' + r.unsold + ' enchères sans vente.');
      } catch (e) {
        if (!stopped) console.error('Synchro vers le pool du NAS impossible pour l’instant : ' + e.message);
      }
      busy = false;
    };
    const every = Math.max(50, Number(relay.everyMs) || 5 * 60e3);
    timers = [setTimeout(tick, Math.min(every, 10e3)), setInterval(tick, every)];
    timers.forEach(t => t.unref());
  }
  server.on('close', () => {
    stopped = true;
    timers.forEach(t => clearTimeout(t));
    handler.close();
    // Une synchronisation en cours se termine avant la fermeture de la base.
    const closeDb = () => (busy ? setTimeout(closeDb, 50) : db.close());
    closeDb();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); host ? server.listen(port, host, resolve) : server.listen(port, resolve); });
  return server;
}

if (require.main === module) {
  const env = process.env;
  start({
    dbPath: env.DB_PATH || '/data/pool.db',
    port: Number(env.PORT) || 8787,
    host: env.HOST || undefined,
    groupKey: env.GROUP_KEY,
    allowedOrigins: (env.ALLOWED_ORIGINS || 'https://www.wiki-masters.com,https://wiki-masters.com').split(',').map(s => s.trim()).filter(Boolean),
    upstream: env.UPSTREAM_URL && env.UPSTREAM_KEY
      ? { url: env.UPSTREAM_URL, key: env.UPSTREAM_KEY, everyMs: (Number(env.SYNC_MINUTES) || 5) * 60e3 } : null
  }).then(s => console.log('Pool de prix prêt sur le port ' + s.address().port + ' (version ' + VERSION + ')' +
    (env.UPSTREAM_URL && env.UPSTREAM_KEY ? ', synchronisé vers ' + env.UPSTREAM_URL : '')))
    .catch(e => { console.error('Démarrage impossible : ' + e.message); process.exit(1); });
}

module.exports = { createHandler, start, VERSION };
