import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
const folder='/tmp/fully-flared-gate0-baseline/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const db=new DatabaseSync(folder+'/'+readdirSync(folder).find(x=>x.endsWith('.sqlite')&&x!=='metadata.sqlite'));
db.exec('PRAGMA foreign_keys=ON');
for(let n=1;n<=3;n++){
const id='gate0-order-'+n;
db.prepare("INSERT OR IGNORE INTO orders(id,number,status,payment_status,customer_email,user_id,currency,subtotal_cents,total_cents,shipping_name,shipping_address_json,created_at,updated_at) VALUES(?,?,?,'paid',?,?,'USD',2999,2999,'Jordan Sample',?,datetime('now'),datetime('now'))").run(id,'FF-100'+n,n===3?'shipped':'paid','buyer'+n+'@gate0.invalid',n===1?'gate0-support':null,JSON.stringify({line1:'123 Sample St',city:'Brooklyn',state:'NY',postal_code:'11201',country:'US'}));
db.prepare("INSERT OR IGNORE INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES(?,?,'TEE-BLK-M','Tracer Tee',1,2999)").run(id+'-item',id);
}
db.prepare("INSERT OR IGNORE INTO returns(id,order_id,reason,status,created_at) VALUES('gate0-return','gate0-order-3','Size did not fit','requested',datetime('now'))").run();
console.log('Three disposable sample orders and one requested return.');
