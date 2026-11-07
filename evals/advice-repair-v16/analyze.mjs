import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {score} from './scoring.mjs';
const root=resolve(process.argv[2]),read=p=>JSON.parse(readFileSync(p,'utf8')),reg=read(join(root,'registration.json'));
const gold=read(join(root,'source-snapshot/evals/advice-repair-v16/private/gold.json'));
function usage(dir){
 const out={calls:0,successfulCalls:0,failedCalls:0,pendingCalls:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,reviewCalls:0};
 if(existsSync(dir))for(const f of readdirSync(dir).filter(f=>/^\d+\.json$/.test(f))){const c=read(join(dir,f));out.calls++;out.reviewCalls+=Number(c.phase==='review');out.successfulCalls+=Number(c.status==='ok');out.failedCalls+=Number(c.status==='error');out.pendingCalls+=Number(c.status==='pending');if(c.status==='ok'){out.inputTokens+=c.response.usage.input??0;out.outputTokens+=c.response.usage.output??0;out.cachedInputTokens+=c.response.usage.cachedInput??0;}}
 return out;
}
const rows=[],prefixes=[],totals=Object.fromEntries(reg.arms.map(a=>[a,{events:0,primaryCorrect:0,verdictsCorrect:0,finalCorrect:0,recommendationsCorrect:0,freshnessCorrect:0,arithmeticCorrect:0,roleArithmeticCorrect:0,toolChecks:0,witnessChecks:0,expertExecutions:0,artifactReads:0,sourceReads:0,activeTasks:0,unrelatedDispatches:0,closedTasks:0,rejectedTasks:0,initializationCalls:0,...usage('/nonexistent')} ]));
for(const tid of Object.keys(gold)){
 const prefix=join(root,tid,'shared/event-0');
 if(existsSync(join(prefix,'result.json')))prefixes.push({trajectory:tid,...score(read(join(prefix,'result.json')),gold[tid][0]),usage:usage(join(prefix,'calls'))});
 for(const arm of reg.arms){
  const t=totals[arm],init=usage(join(root,tid,arm,'initialization/calls'));for(const [k,v] of Object.entries(init))t[k]+=v;t.initializationCalls+=init.calls;
  for(let i=1;i<reg.maxEvents;i++){
   const dir=join(root,tid,arm,'event-'+i);if(!existsSync(join(dir,'result.json')))continue;
   const d=read(join(dir,'result.json')),ev=existsSync(join(dir,'runtime-events.json'))?read(join(dir,'runtime-events.json')):[],review=existsSync(join(dir,'review.json'))?read(join(dir,'review.json')):{};
   const executions=ev.filter(e=>e.type==='expert.started').map(e=>({role:e.payload.expert,thread:e.payload.thread}));
   const row={trajectory:tid,arm,event:i,eventType:gold[tid][i].eventType,status:d.status,...score(d,gold[tid][i]),usage:usage(join(dir,'calls')),executions,artifactReads:ev.filter(e=>e.type==='tool.completed'&&e.payload.name==='artifact_read').length,sourceReads:ev.filter(e=>e.type==='tool.completed'&&e.payload.name==='knowledge_read').length,activeTasks:d.activeTasks?.length??0,closedTasks:(review.transitions??[]).filter(x=>x.type==='resolved-with-cited-evidence').length,rejectedTasks:review.errors?.length??0};
   t.toolChecks+=(review.toolLog??[]).filter(x=>x.receipt).length;t.witnessChecks+=(review.toolLog??[]).filter(x=>x.receipt?.witness).length;
   rows.push(row);t.events++;for(const k of ['primaryCorrect','verdictsCorrect','finalCorrect','recommendationsCorrect','freshnessCorrect','arithmeticCorrect','roleArithmeticCorrect'])t[k]+=Number(row[k]);
   for(const k of ['artifactReads','sourceReads','activeTasks','closedTasks','rejectedTasks'])t[k]+=row[k];
   t.expertExecutions+=executions.length;if(row.eventType==='irrelevant')t.unrelatedDispatches+=row.activeTasks;
   for(const [k,v] of Object.entries(row.usage))t[k]+=v;
  }
 }
}
const summary={complete:existsSync(join(root,'complete.json')),metric:'Final and three maintained role arithmetic correct + all verdicts + exact candidate set + affected-role freshness',prefixes,totals,paired:rows.filter(r=>r.arm==='direct').map(d=>({trajectory:d.trajectory,event:d.event,arms:Object.fromEntries(reg.arms.map(a=>{const row=rows.find(r=>r.arm===a&&r.trajectory===d.trajectory&&r.event===d.event);return [a,row?{correct:row.primaryCorrect,calls:row.usage.calls}:null];}))}))};
writeFileSync(join(root,'scored-events.json'),JSON.stringify(rows,null,2)+'\n');writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({complete:summary.complete,totals},null,2));
