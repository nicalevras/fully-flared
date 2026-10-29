import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
const folder='/tmp/fully-flared-gate0-baseline/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const db=new DatabaseSync(folder+'/'+readdirSync(folder).find(x=>x.endsWith('.sqlite')&&x!=='metadata.sqlite'));
const role=process.argv[2];if(!['warehouse','owner'].includes(role))throw Error('fixture roles only');
db.prepare("INSERT OR IGNORE INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES('gate0-spare','Fixture spare','spare@gate0.invalid',1,'owner',?,?)").run(Date.now(),Date.now());
db.prepare("UPDATE user SET role=? WHERE id='gate0-owner'").run(role);
console.log('Disposable actor role:',role);
