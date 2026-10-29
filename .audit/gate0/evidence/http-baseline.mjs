import { writeFileSync } from 'node:fs';
const base='http://localhost:8899';
const paths=['/','/products/tracer-tee','/shop','/blog'];
const samples=[];
for(let round=0;round<5;round++)for(const path of round%2?[...paths].reverse():paths){const start=performance.now();const response=await fetch(base+path);const html=await response.text();samples.push({round,path,status:response.status,bytes:Buffer.byteLength(html),ms:performance.now()-start,cacheControl:response.headers.get('cache-control'),cfCache:response.headers.get('cf-cache-status'),valid:response.ok&&html.includes('<html')});}
writeFileSync('.audit/gate0/evidence/http-baseline.json',JSON.stringify({scope:'Local Vite HTTP full body reads; no guarantee of cold or warm edge caches; installed dependencies; no deployed CPU',samples},null,2));
console.log(JSON.stringify({samples:samples.length,errors:samples.filter(s=>!s.valid).length}));
