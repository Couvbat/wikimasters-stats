// Administration du pool, en ligne de commande :
//   node admin.js stats                    compteurs du pool (et état de la synchronisation)
//   node admin.js purge <membre>           retire tout ce qu'un membre a envoyé
//   node admin.js sync [<adresse> <clé>]   envoie tout de suite ce pool vers un autre (par défaut UPSTREAM_URL, UPSTREAM_KEY)
'use strict';
const { openDb, poolStats, purgeMember } = require('./db');
const { syncOnce, syncStatus } = require('./sync');

const [cmd, a1, a2] = process.argv.slice(2);
if (cmd !== 'stats' && cmd !== 'sync' && !(cmd === 'purge' && a1)) {
  console.error('Usage : node admin.js stats | node admin.js purge <membre> | node admin.js sync [<adresse> <clé>]');
  process.exit(1);
}
const db = openDb(process.env.DB_PATH || '/data/pool.db');
(async () => {
  if (cmd === 'stats') {
    console.log(JSON.stringify(Object.assign(poolStats(db), { sync: syncStatus(db) })));
  } else if (cmd === 'purge') {
    console.log(purgeMember(db, a1) + ' ventes supprimées pour « ' + a1 + ' ».');
  } else {
    const url = a1 || process.env.UPSTREAM_URL, key = a2 || process.env.UPSTREAM_KEY;
    try {
      const r = await syncOnce(db, { url, key });
      console.log('Synchronisé : ' + r.sent + ' ventes, ' + r.unsold + ' enchères sans vente envoyées.');
    } catch (e) {
      console.error('Synchronisation impossible : ' + e.message);
      process.exitCode = 1;
    }
  }
  db.close();
})();
