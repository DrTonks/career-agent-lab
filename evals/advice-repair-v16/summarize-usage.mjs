import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(process.argv[2]),s=JSON.parse(readFileSync(join(root,'summary.json'),'utf8'));
const keys=['calls','successfulCalls','failedCalls','pendingCalls','inputTokens','outputTokens','cachedInputTokens','reviewCalls'];
const rows=[...Object.values(s.totals),...s.prefixes.map(p=>p.usage)],total=Object.fromEntries(keys.map(k=>[k,rows.reduce((n,x)=>n+x[k],0)]));
total.nativeCalls=total.calls-total.reviewCalls;
writeFileSync(join(root,'usage.json'),JSON.stringify({model:'deepseek-flash',byArm:s.totals,sharedPrefixes:s.prefixes.map(p=>({trajectory:p.trajectory,usage:p.usage})),total,cacheAccounting:'cachedInputTokens is a subset of inputTokens; shared prefixes counted once'},null,2)+'\n');
console.log(JSON.stringify(total));
