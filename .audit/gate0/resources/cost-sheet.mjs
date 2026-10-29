import {writeFileSync} from 'node:fs';
const above=(usage,included,rate,unit)=>Math.max(0,usage-included)/unit*rate;
const scenarios=[];
for(const pagesPerVisit of [3,6])for(const htmlMissRate of [0.01,0.1,1])for(const meanCpuMs of [1,5,15]){
 const visits=1_000_000,pageViews=visits*pagesPerVisit,kvKeysPerMiss=5,kvReads=pageViews*htmlMissRate*kvKeysPerMiss,cpuMs=pageViews*meanCpuMs,mediaReads=pageViews*3;
 scenarios.push({visits,pagesPerVisit,pageViews,htmlMissRate,meanCpuMs,kvKeysPerMiss,cpuMs,kvReads,mediaReads,workerRequestOverage:above(pageViews,10_000_000,.30,1_000_000),workerCpuOverage:above(cpuMs,30_000_000,.02,1_000_000),kvReadOverage:above(kvReads,10_000_000,.50,1_000_000),r2ReadOverage:above(mediaReads,10_000_000,.36,1_000_000),note:'Sensitivity assumptions, excludes API/admin/queue/DO/logs and measured production usage. Not a total bill.'});
}
writeFileSync(new URL('./cost-scenarios.json',import.meta.url),JSON.stringify({asOf:'2026-10-25',baseUsd:5,scenarios},null,2));
console.log(`Wrote ${scenarios.length} sensitivity scenarios. No scenario is a measured total bill.`);
