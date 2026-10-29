import {readFileSync,writeFileSync} from 'node:fs';
const [phase,label]=process.argv.slice(2);if(!['before','after'].includes(phase)||!label?.match(/^[a-z-]+$/))throw Error('before|after and task slug');
const response=await fetch('http://localhost:8899/cdn-cgi/local/explorer/api/local/observability/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:'SELECT name,COUNT(*) AS n FROM spans WHERE parent_id IS NULL GROUP BY name'})});
const data=await response.json();if(!data.success)throw Error(JSON.stringify(data));
const counts=Object.fromEntries(data.result.rows);const file='.audit/gate0/evidence/requests-'+label+'.json';
if(phase==='before')writeFileSync(file,JSON.stringify({scope:'Local Worker root spans during browser task, including related background invalidations. Not HAR, static assets or deployed billing.',before:counts,started:new Date().toISOString()},null,2));
else{const previous=JSON.parse(readFileSync(file));previous.after=counts;previous.finished=new Date().toISOString();previous.delta=Object.fromEntries(Object.entries(counts).map(([key,n])=>[key,n-(previous.before[key]??0)]));writeFileSync(file,JSON.stringify(previous,null,2));console.log(previous.delta);}
