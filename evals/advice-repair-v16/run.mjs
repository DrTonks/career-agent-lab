import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,renameSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Runtime} from '../../dist/src/runtime.js';
import {Store} from '../../dist/src/storage.js';
import {Knowledge} from '../../dist/src/retrieval.js';
import {CompatibleProvider} from '../../dist/src/providers.js';
import {config,hash} from '../../dist/src/config.js';
import {readCalendar} from './calendar-check.mjs';
import {review,contextFor} from './probe.mjs';
import {recordExecution,reconcile,evidenceIndex} from './state.mjs';
import {mergeArtifacts,cloneSnapshot,digestFile} from './snapshot.mjs';
const [action,output,split='test',n='4',prefixOrigin]=process.argv.slice(2);
if(!['register','live'].includes(action)||!output)throw Error('register|live OUTPUT [split] [events]');
const root=resolve(output),arms=['direct','natural','counterexample'];
const read=p=>JSON.parse(readFileSync(p,'utf8'));
function save(p,x){mkdirSync(resolve(p,'..'),{recursive:true});const temp=p+'.tmp';writeFileSync(temp,JSON.stringify(x,null,2)+'\n');renameSync(temp,p);}
const cfg={...config(),model:'deepseek-flash',baseUrl:'https://api.deepseek.com',finalReview:'off',maxCalls:57,finalReserveCalls:2,maxInputTokens:1800000,maxOutputTokens:120000,finalReserveInputTokens:48000,finalReserveOutputTokens:8192,maxResponseTokens:4096,maxTurns:12,maxPlanningTurns:8,maxRunMs:900000,maxCoordinationRounds:2,maxStepAttempts:2,concurrency:2,activeContextTarget:96000,maxContextTokens:128000};
const files=[...['src','prompts','knowledge'].flatMap(dir=>readdirSync(dir).filter(f=>/\.(ts|md)$/.test(f)).map(f=>dir+'/'+f)),...readdirSync('evals/advice-repair-v16').filter(f=>/\.(mjs|md|py)$/.test(f)).map(f=>'evals/advice-repair-v16/'+f),`evals/advice-repair-v16/data/${split}.json`,'evals/advice-repair-v16/private/gold.json'];
if(action==='register'){
 if(existsSync(root))throw Error('Fresh root required');const hashes={};
 for(const file of files){const text=readFileSync(file,'utf8');hashes[file]=hash(text);mkdirSync(join(root,'source-snapshot',file,'..'),{recursive:true});writeFileSync(join(root,'source-snapshot',file),text);}
 const prefixImports=[];
 if(prefixOrigin){
  const origin=resolve(prefixOrigin),originalCases=read(join(origin,`source-snapshot/evals/advice-repair-v16/data/${split}.json`)),currentCases=read(`evals/advice-repair-v16/data/${split}.json`);
  if(hash(originalCases)!==hash(currentCases))throw Error('Imported histories require exactly the same prespecified data');
  for(const t of currentCases){const from=join(origin,t.id,'shared'),to=join(root,t.id,'shared'),state=read(join(from,'checkpoint.json'));
   if(state.nextEvent!==1||!['succeeded','partial'].includes(state.parentStatus))throw Error('Shared prefix is not complete');
   cpSync(from,to,{recursive:true});prefixImports.push({trajectory:t.id,origin:prefixOrigin,parentRunId:state.parent,databaseHash:digestFile(join(to,'runtime.sqlite')),originRegistrationHash:digestFile(join(origin,'registration.json'))});
  }
 }
 save(join(root,'registration.json'),{at:new Date().toISOString(),split,maxEvents:Number(n),arms,cfg,hashes,prefixImports,totalCallCapPerEvent:60,reviewerCallCap:3,initialReviewerCallCap:3,model:'deepseek-flash',nativeRuntime:true});console.log('Registered '+root);process.exit();
}
const reg=read(join(root,'registration.json'));
for(const [file,digest]of Object.entries(reg.hashes))if(hash(readFileSync(file,'utf8'))!==digest)throw Error('Frozen source changed: '+file);
const cases=read(`evals/advice-repair-v16/data/${reg.split}.json`),secret=readFileSync(resolve('../api.txt'),'utf8').trim(),abort=new AbortController();
class RecordedProvider{
 mode='live';model='deepseek-flash';phase='native';
 constructor(dir,label){this.dir=dir;this.label=label;mkdirSync(dir,{recursive:true});this.count=readdirSync(dir).filter(f=>/^\d+\.json$/.test(f)).length;this.base=new CompatibleProvider(reg.cfg,secret);}
 async complete(messages,tools,signal,delta,progress){
  if(abort.signal.aborted||existsSync(join(root,'STOP')))throw Error('Experiment stopped');
  if(this.count>=60)throw Error('Combined call cap');const n=++this.count,file=join(this.dir,String(n).padStart(3,'0')+'.json'),started=Date.now();
  const data={n,label:this.label,phase:this.phase,status:'pending',messages,tools};save(file,data);
  try{const response=await this.base.complete(messages,tools,AbortSignal.any([signal,abort.signal]),delta,progress);save(file,{...data,status:'ok',elapsedMs:Date.now()-started,response});return response;}
  catch(e){save(file,{...data,status:'error',elapsedMs:Date.now()-started,error:e.message});if([401,402,403].includes(e.status)){abort.abort();writeFileSync(join(root,'STOP'),'Provider access failure\n');}throw e;}
 }
}
const jobs=cases.flatMap((t,i)=>[...arms.slice(i%3),...arms.slice(0,i%3)].map(arm=>({t,arm})));
async function trajectory({t,arm},limit=reg.maxEvents){
 const dir=join(root,t.id,arm),checkpointPath=join(dir,'checkpoint.json');mkdirSync(dir,{recursive:true});
 let state=existsSync(checkpointPath)?read(checkpointPath):{nextEvent:0,parent:null,parentStatus:null,artifacts:[],tasks:[],receipts:[]};
 for(let i=state.nextEvent;i<limit;i++){
  if(abort.signal.aborted||existsSync(join(root,'STOP')))return;
  const sources=t.events.slice(0,i+1).map(e=>({id:'event:'+e.id,text:e.text}));
  const event=t.events[i],dataset=t.snapshots[i],eventDir=join(dir,'event-'+i);mkdirSync(eventDir,{recursive:true});
  if(existsSync(join(eventDir,'result.json'))){state=read(join(eventDir,'state-after.json'));save(checkpointPath,state);continue;}
  save(join(eventDir,'dataset.json'),dataset);
  if(state.parent&&!['succeeded','partial'].includes(state.parentStatus)){
   const result={trajectory:t.id,arm,event:i,status:'blocked',error:'Previous native run did not complete',artifacts:[],answer:'',pendingTasks:state.tasks,providerCalls:0,runId:null};
   state={...state,nextEvent:i+1};save(join(eventDir,'state-after.json'),state);save(join(eventDir,'result.json'),result);save(checkpointPath,state);console.log(JSON.stringify({trajectory:t.id,arm,event:i,status:'blocked'}));continue;
  }
  const catalog=dataset.jobs.map(j=>({id:'job:'+j.id,title:j.title,version:hash(j)})),provider=new RecordedProvider(join(eventDir,'calls'),`${t.id}/${arm}/${i}`);
  let assessment={tasks:[],active:[],errors:[]},tasks=[],active=[];
  const doReview=async initial=>{
   provider.phase='review';let value;
   try{
    value=await review(provider,{arm,event,artifacts:state.artifacts,priorTasks:state.tasks,catalog,initial,signal:abort.signal,sources,priorReceipts:state.receipts??[]});
   }catch(e){
    value=arm!=='direct'?reconcile({previous:state.tasks,proposals:[],index:evidenceIndex(state.artifacts),catalog,event,initial}):{tasks:[],active:[]};
    value.errors=[{error:e.message}];
   }finally{provider.phase='native';}
   save(join(eventDir,'review.json'),value);return value;
  };
  if(i){assessment=existsSync(join(eventDir,'review.json'))?read(join(eventDir,'review.json')):await doReview(false);tasks=assessment.tasks;active=assessment.active;}
  let context=contextFor(catalog,state.artifacts,active,assessment.checks??[]);
  const contextPath=join(eventDir,'context.json');
  if(existsSync(contextPath))context=read(contextPath).reviewContext;else save(contextPath,{priorArtifacts:state.artifacts,priorTasks:state.tasks,activeTasks:active,reviewContext:context});
  const store=new Store(join(dir,'runtime.sqlite'));let result,artifacts=[],events=[],run;
  try{
   const rt=new Runtime(store,new Knowledge(dataset),provider,reg.cfg,context),userId=`v16-${t.id}`,createdPath=join(eventDir,'run-created.json');
   run=existsSync(createdPath)?store.run(read(createdPath).id):state.parent?rt.reply(state.parent,userId,{operationId:'event-'+i,reply:event.text}):rt.create({userId,conversationId:'continuous-internship',request:event.text,resumeText:t.resume,constraints:t.constraints,architecture:'multi-agent',approvalRequired:false});
   if(!existsSync(createdPath))save(createdPath,run);
   result=['succeeded','partial','failed','cancelled','stale','rejected'].includes(run.status)?run:await rt.execute(run.id,userId);
   if(result.status==='waiting_approval'){const approval=store.approval(run.id);save(join(eventDir,'synthetic-approval.json'),{policy:'approve-synthetic-local-memory',approvalId:approval.approvalId});result=await rt.execute(run.id,userId,{decision:'approve',approvalId:approval.approvalId});}
   artifacts=store.artifacts(run.id);events=store.events(run.id);
   save(join(eventDir,'run.json'),result);save(join(eventDir,'artifacts.json'),artifacts);save(join(eventDir,'runtime-events.json'),events);save(join(eventDir,'model-calls.json'),store.modelCalls(run.id));save(join(eventDir,'tool-receipts.json'),events.filter(e=>e.type==='tool.completed').map(e=>e.payload));
  }catch(e){result={status:'failed',answer:'',error:e.message};save(join(eventDir,'harness-error.json'),{error:e.message});}
  finally{store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");store.close();}
  if(i===0&&arm!=='shared'){state={...state,artifacts};assessment=existsSync(join(eventDir,'review.json'))?read(join(eventDir,'review.json')):await doReview(true);tasks=assessment.tasks;active=[];}
  const nextTasks=arm!=='direct'&&arm!=='shared'?recordExecution(tasks,active,artifacts,events,run?.id,event.id).map(t=>active.some(a=>a.key===t.key)?{...t,lastExecution:{...t.lastExecution,factsHash:assessment.checks?.find(r=>r.factsHash===readCalendar(sources).factsHash)?.factsHash??null}}:t):[];
  const effectiveArtifacts=mergeArtifacts(state.artifacts,artifacts);
  const out={trajectory:t.id,arm,event:i,runId:run?.id??null,status:result.status,answer:result.answer??'',error:result.error,artifacts,effectiveArtifacts,pendingTasks:nextTasks,activeTasks:active,providerCalls:provider.count,independentExperts:events.filter(e=>e.type==='expert.started').map(e=>e.payload)};
  state={nextEvent:i+1,parent:run?.id??'failed-to-create',parentStatus:result.status,artifacts:effectiveArtifacts,tasks:nextTasks,receipts:[...new Map([...(state.receipts??[]),...(assessment.checks??[])].map(r=>[r.id,r])).values()]};
  save(join(eventDir,'state-after.json'),state);save(join(eventDir,'result.json'),out);save(checkpointPath,state);
  console.log(JSON.stringify({trajectory:t.id,arm,event:i,status:result.status,calls:provider.count,active:active.length,tasks:nextTasks.length}));
 }
}
// One native prefix per trajectory, closed/checkpointed before byte-identical forks.
for(const t of cases){
 await trajectory({t,arm:'shared'},1);
 const prefixDir=join(root,t.id,'shared'),prefix=read(join(prefixDir,'checkpoint.json'));
 if(!['succeeded','partial'].includes(prefix.parentStatus))throw Error('Common prefix failed: '+t.id);
 for(const arm of arms){
  const dir=join(root,t.id,arm),cp=join(dir,'checkpoint.json');
  if(existsSync(cp))continue;
  mkdirSync(dir,{recursive:true});
  const db=join(dir,'runtime.sqlite'),fork=join(dir,'fork.json');
  if(!existsSync(db)){const manifest=cloneSnapshot(join(prefixDir,'runtime.sqlite'),db);save(fork,{...manifest,parentRunId:prefix.parent,artifactIds:prefix.artifacts.map(a=>a.id),userId:`v16-${t.id}`});}
  else if(!existsSync(fork)||read(fork).forkHash!==digestFile(db))throw Error('Uninitialized fork has changed');
  const initDir=join(dir,'initialization'),provider=new RecordedProvider(join(initDir,'calls'),`${t.id}/${arm}/initialization`);provider.phase='review';
  const dataset=t.snapshots[0],catalog=dataset.jobs.map(j=>({id:'job:'+j.id,title:j.title,version:hash(j)}));
  const path=join(initDir,'review.json');
  const assessed=existsSync(path)?read(path):await review(provider,{arm,event:t.events[0],artifacts:prefix.artifacts,priorTasks:[],catalog,initial:true,signal:abort.signal,sources:[{id:'event:'+t.events[0].id,text:t.events[0].text}],priorReceipts:[]});
  save(path,assessed);save(cp,{...prefix,tasks:arm!=='direct'?assessed.tasks:[],receipts:assessed.checks??[]});
 }
}
let cursor=0;const outcomes=await Promise.allSettled(Array.from({length:2},async()=>{while(cursor<jobs.length&&!abort.signal.aborted){const job=jobs[cursor++];try{await trajectory(job);}catch(e){save(join(root,job.t.id,job.arm,'worker-error.json'),{error:e.message});console.log(JSON.stringify({arm:job.arm,trajectory:job.t.id,error:e.message}));}}}));
const count=jobs.reduce((n,{t,arm})=>n+Array.from({length:reg.maxEvents-1},(_,i)=>existsSync(join(root,t.id,arm,'event-'+(i+1),'result.json'))).filter(Boolean).length,0);
const planned=jobs.length*(reg.maxEvents-1);
save(join(root,'execution-status.json'),{at:new Date().toISOString(),events:count,planned,sharedPrefixes:cases.length,outcomes:outcomes.map(o=>o.status)});
if(count===planned)save(join(root,'complete.json'),{at:new Date().toISOString(),events:count,jobs:jobs.length,sharedPrefixes:cases.length});
