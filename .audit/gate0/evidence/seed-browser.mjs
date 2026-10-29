import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { hashPassword } from '/Users/nic/Desktop/fully-flared/fully-flared/web/node_modules/better-auth/dist/crypto/index.mjs';
const folder='/tmp/fully-flared-gate0-baseline/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const file=readdirSync(folder).find(x=>x.endsWith('.sqlite')&&x!=='metadata.sqlite');
const db=new DatabaseSync(folder+'/'+file);
for(const role of ['owner','support','warehouse']){
const id='gate0-'+role;
db.prepare('INSERT OR IGNORE INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES(?,?,?,1,?,?,?)').run(id,'Gate 0 '+role,role+'@gate0.invalid',role,Date.now(),Date.now());
db.prepare("INSERT OR IGNORE INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,'credential',?,?,?,?)").run(id,id,id,await hashPassword('Gate0-disposable-pass-2026'),Date.now(),Date.now());
}
console.log('Three disposable fixture accounts created; no production access.');
