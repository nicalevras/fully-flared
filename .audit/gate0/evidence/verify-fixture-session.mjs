import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
const folder='/tmp/fully-flared-gate0-baseline/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const file=readdirSync(folder).find(x=>x.endsWith('.sqlite')&&x!=='metadata.sqlite');
const db=new DatabaseSync(folder+'/'+file);
for(const role of ['owner','support','warehouse']){
const id='gate0-'+role;
db.prepare('UPDATE user SET two_factor_enabled=1 WHERE id=?').run(id);
for(const s of db.prepare('SELECT id FROM session WHERE user_id=?').all(id))db.prepare('INSERT OR IGNORE INTO staff_two_factor_sessions(session_id,user_id,verified_at) VALUES(?,?,?)').run(s.id,id,new Date().toISOString());
}
console.log('Disposable fixture sessions marked verified using existing test-fixture convention; actual 2FA flow not tested.');
