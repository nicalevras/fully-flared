import {DatabaseSync} from 'node:sqlite';
import {readdirSync} from 'node:fs';
import {hashPassword} from '/Users/nic/Desktop/fully-flared/fully-flared/web/node_modules/better-auth/dist/crypto/index.mjs';
const root='/Users/nic/.codex/worktrees/admin-shell/fully-flared/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const name=readdirSync(root).find(x=>x.endsWith('.sqlite')&&x!=='metadata.sqlite');
if(!name)throw Error('Disposable local database missing');
const db=new DatabaseSync(root+'/'+name);db.exec('PRAGMA foreign_keys=ON');
const operation=process.argv[2]??'seed';
if(operation==='seed'){
for(const role of ['owner','support','warehouse']){const id='shell-'+role;db.prepare('INSERT OR IGNORE INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES(?,?,?,1,?,?,?)').run(id,'Shell '+role,role+'@shell.invalid',role,Date.now(),Date.now());db.prepare("INSERT OR IGNORE INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,'credential',?,?,?,?)").run(id,id,id,await hashPassword('Shell-disposable-pass-2026'),Date.now(),Date.now());}
for(let n=1;n<=3;n++){const id='shell-order-'+n;db.prepare("INSERT OR IGNORE INTO orders(id,number,status,payment_status,customer_email,currency,subtotal_cents,total_cents,created_at,updated_at) VALUES(?,?,?,'paid',?,'USD',2999,2999,datetime('now'),datetime('now'))").run(id,'FF-100'+n,n===3?'shipped':'paid','buyer'+n+'@shell.invalid');db.prepare("INSERT OR IGNORE INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES(?,?,'TEE-BLK-M','Tracer Tee',1,2999)").run(id+'-item',id);}
db.prepare("INSERT OR IGNORE INTO returns(id,order_id,reason,status,created_at) VALUES('shell-return','shell-order-3','Size did not fit','requested',datetime('now'))").run();
console.log('Disposable users, three orders and return seeded.');
}else if(operation==='many-orders'){
db.exec('BEGIN');
for(let n=10;n<120;n++)db.prepare("INSERT OR IGNORE INTO orders(id,number,status,payment_status,customer_email,currency,subtotal_cents,total_cents,created_at,updated_at) VALUES(?,?,'paid','paid',?,'USD',2999,2999,datetime('now'),datetime('now'))").run('shell-many-'+n,'FF-'+(2000+n),'sample'+n+'@shell.invalid');
db.exec('COMMIT');
console.log('110 disposable list-only orders added.');
}else if(operation==='verify-session'){
db.prepare("UPDATE user SET two_factor_enabled=1 WHERE id LIKE 'shell-%'").run();for(const s of db.prepare("SELECT id,user_id FROM session WHERE user_id LIKE 'shell-%'").all())db.prepare('INSERT OR IGNORE INTO staff_two_factor_sessions(session_id,user_id,verified_at) VALUES(?,?,?)').run(s.id,s.user_id,new Date().toISOString());console.log('Disposable sessions marked verified. Authenticator challenge not tested.');
}else if(operation==='warehouse'||operation==='owner'){
db.prepare("INSERT OR IGNORE INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES('shell-spare','Spare fixture','spare@shell.invalid',1,'owner',?,?)").run(Date.now(),Date.now());db.prepare("UPDATE user SET role=? WHERE id='shell-owner'").run(operation);console.log('Fixture actor role',operation);
}else if(operation==='stale-return'){
db.prepare("DELETE FROM returns WHERE id='shell-return'").run();console.log('Only disposable return deleted to inject a stale-record response.');
}else{throw Error('Unknown fixture operation');}
