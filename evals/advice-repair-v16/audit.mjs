import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {hash} from '../../dist/src/config.js';
import {digestFile} from './snapshot.mjs';
import {readCalendar,checkSchedule} from './calendar-check.mjs';
const root=resolve(process.argv[2]),read=p=>JSON.parse(readFileSync(p,'utf8')),reg=read(join(root,'registration.json')),errors=[],checks={frozenFiles:0,forks:0,postEvents:0,isolatedExpertExecutions:0,recomputedReceipts:0,currentContextReceipts:0,scannedFiles:0};
for(const [file,h] of Object.entries(reg.hashes)){if(hash(readFileSync(join(root,'source-snapshot',file),'utf8'))!==h)errors.push('Frozen snapshot mismatch '+file);if(hash(readFileSync(file,'utf8'))!==h)errors.push('Registered live source changed '+file);checks.frozenFiles++;}
const data=read(join(root,'source-snapshot/evals/advice-repair-v16/data/test.json'));
for(const t of data){
 const prefix=read(join(root,t.id,'shared/checkpoint.json')),prefixHash=digestFile(join(root,t.id,'shared/runtime.sqlite'));
 for(const arm of reg.arms){
  const base=join(root,t.id,arm),fork=read(join(base,'fork.json'));if(fork.sourceHash!==prefixHash||fork.forkHash!==prefixHash||fork.parentRunId!==prefix.parent||JSON.stringify(fork.artifactIds)!==JSON.stringify(prefix.artifacts.map(a=>a.id)))errors.push('Different fork '+base);checks.forks++;
  let previous=[];
  for(let i=0;i<reg.maxEvents;i++){
   const dir=i?join(base,'event-'+i):join(base,'initialization'),review=read(join(dir,'review.json')),sources=t.events.slice(0,i+1).map(e=>({id:'event:'+e.id,text:e.text})),current=readCalendar(sources),available=[...previous];
   for(const entry of review.toolLog??[]){if(!entry.receipt)continue;const actual=checkSchedule(sources,entry.args,available);if(JSON.stringify(actual)!==JSON.stringify(entry.receipt))errors.push('Receipt mismatch '+dir);available.push(entry.receipt);checks.recomputedReceipts++;}
   for(const r of review.checks??[]){if(r.factsHash!==current.factsHash||!available.some(x=>x.id===r.id))errors.push('Unverified/current check '+dir);checks.currentContextReceipts++;}
   previous=[...new Map([...previous,...(review.checks??[])].map(r=>[r.id,r])).values()];
   const calls=readdirSync(join(dir,'calls')).filter(f=>/^\d+\.json$/.test(f)).map(f=>read(join(dir,'calls',f)));
   if(calls.length>(i?60:3)||calls.filter(c=>c.phase==='review').length>3)errors.push('Budget exceeded '+dir);
   for(const call of calls){if(call.status!=='ok')errors.push('Unfinished/provider error '+dir);if(JSON.stringify(call.messages).includes('"requiredUpdatedRoles"'))errors.push('Gold leaked '+dir);}
   if(!i)continue;
   const out=read(join(dir,'result.json')),context=read(join(dir,'context.json')),ev=read(join(dir,'runtime-events.json'));
   if(i===1&&JSON.stringify(context.priorArtifacts)!==JSON.stringify(prefix.artifacts))errors.push('Different initial outputs '+dir);
   if(JSON.stringify(context.reviewContext.derivationChecks??[])!==JSON.stringify(review.checks??[]))errors.push('Calculation context changed '+dir);
   if(JSON.stringify(context.reviewContext).includes('"branches"'))errors.push('Hypothesis leakage '+dir);
   for(const e of ev.filter(e=>e.type==='expert.started')){if(e.payload.independentContext!==true||!e.payload.thread?.startsWith(out.runId+'::'))errors.push('Nonisolated role '+dir);checks.isolatedExpertExecutions++;}
   checks.postEvents++;
  }
 }
}
const secret=readFileSync(resolve('../api.txt'),'utf8').trim();function scan(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())scan(p);else if(/\.(json|ts|mjs|py|md)$/.test(p)){checks.scannedFiles++;if(secret&&readFileSync(p).includes(Buffer.from(secret)))errors.push('Credential in saved file '+p);}}}scan(root);
const out={passed:errors.length===0,checks,errors};writeFileSync(join(root,'validation.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));if(errors.length)process.exitCode=1;
