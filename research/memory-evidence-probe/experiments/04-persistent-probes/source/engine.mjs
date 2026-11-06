import {hash,roles,fields,equal} from './core.mjs';
import {taskSchema} from './prompts.mjs';
export function seed(t){return {scope:t.scope,rule:structuredClone(t.rule),domains:t.domains,facts:Object.fromEntries(Object.entries(t.initial).map(([k,value])=>[k,{value,version:1,sourceId:'initial-'+t.id}])),sources:[{id:'initial-'+t.id,text:JSON.stringify(t.initial)},t.rule],catalog:[],receipts:[],memories:Object.fromEntries(roles.map(r=>[r,{value:null,version:0,refs:[],answer:'尚未生成'}])),tasks:[],history:[],compressed:false};}
function observe(s,obs,sourceId,fromDocument=false){for(const [k,v]of Object.entries(obs??{})){
 if(!fields.includes(k)||!Number.isSafeInteger(v.version)||v.version<1)throw Error('Invalid source observation');
 if(v.value!==null&&!s.domains[k].includes(v.value))throw Error('Source outside declared domain');
 const previous=s.facts[k];
 if(fromDocument&&v.version!==previous.version)continue;
 if(!fromDocument&&v.version<previous.version)continue;
 if(fromDocument&&previous.value!==null&&previous.value!==v.value)throw Error('Conflicting same-version document');
 s.facts[k]={...v,sourceId};
 }}
function stamp(s,task){return {ruleId:s.rule.id,targetVersions:Object.fromEntries(task.targets.map(r=>[r,s.memories[r].version])),factVersions:Object.fromEntries(task.factKeys.map(k=>[k,s.facts[k].version]))};}
function knownEvidence(s,task){return task.factKeys.every(k=>s.facts[k]?.value!==null);}
export function context(s,event){return {scope:s.scope,rule:s.rule,domains:s.domains,facts:s.facts,sources:s.sources,memories:s.memories,history:s.history,catalog:s.catalog.map(({id,title,scope,documentStatus})=>({id,title,scope,documentStatus})),receipts:s.receipts,pendingQuestions:s.tasks.map(t=>({...t,status:t.binding.ruleId!==s.rule.id||Object.entries(t.binding.factVersions).some(([k,v])=>s.facts[k].version!==v)?'needs-refresh':t.status})),event:{id:event.id,text:event.text,scope:event.scope},remainingReads:1};}
export function acceptTask(s,t,contrast){
 t=taskSchema.parse(t);
 if(t.factKeys.some(k=>!fields.includes(k))||new Set(t.factKeys).size!==t.factKeys.length)throw Error('Invalid task fields');
 if(!t.refs.includes(s.rule.id)||t.refs.some(id=>!s.sources.some(x=>x.id===id)))throw Error('Invalid task references');
 if(!contrast&&t.branches.length)throw Error('Direct arm cannot emit explicit branch structure');
 if(t.branches.length!==0&&t.branches.length!==2)throw Error('Use zero or two branches');
 for(const b of t.branches)for(const [k,v]of Object.entries(b.assumptions)){
  if(!t.factKeys.includes(k)||!s.domains[k]?.includes(v)||(s.facts[k].value!==null&&s.facts[k].value!==v))throw Error('Branch outside known evidence');
 }
 if(t.branches.length&&t.branches[0].eligible===t.branches[1].eligible)throw Error('Branches must claim different outcomes');
 return {...structuredClone(t),binding:stamp(s,t),status:knownEvidence(s,t)?'watching':'awaiting-evidence',notFact:true,semanticVerified:false};
}
export async function initialize(t,call){const s=seed(t),records=[];for(const target of roles){const p=context(s,{id:'initial',scope:s.scope,text:'根据初始原件生成建议。'});delete p.pendingQuestions;try{const a=await call('decide',{...p,target});commit(s,target,a);records.push({target,answer:a});}catch(e){records.push({target,error:e.message});}}return {state:s,records};}
function commit(s,r,a){
 if((r==='path'?!['apply','wait','withdraw','none',null].includes(a.value):![true,false,null].includes(a.value))||!a.refs.includes(s.rule.id)||a.refs.some(id=>!s.sources.some(x=>x.id===id)))throw Error('Invalid role value or reference');
 s.memories[r]={...a,version:s.memories[r].version+1};
}
export async function step(previous,event,arm,call,{initial=false}={}){
 const s=structuredClone(previous),persistent=arm.endsWith('persistent'),contrast=arm.startsWith('contrast');
 const log={eventId:event.id,arm,initial,errors:[],reads:[],tasksCreated:[],taskTransitions:[],decisions:[],before:structuredClone(s.memories)};
 if(!persistent)s.tasks=[];
 if(!initial){s.history.push({id:event.id,scope:event.scope,text:event.text});if(event.scope===s.scope){s.sources.push({id:event.id,text:event.text});observe(s,event.observations,event.id);if(event.rule){s.rule=structuredClone(event.rule);s.sources.push(event.rule);}}
  for(const d of event.documents??[])if(!s.catalog.some(x=>x.id===d.id))s.catalog.push(structuredClone(d));
  if(event.compact){s.history=s.history.slice(-2);s.compressed=true;log.compacted=true;}
  if(s.compressed)s.history=s.history.slice(-2);
 }
 // Current fact/rule source excerpts remain accessible in every arm after compaction.
 // Arbitrary historical narrative is not silently kept in the source list.
 const keep=new Set([s.rule.id,...Object.values(s.facts).map(x=>x.sourceId),...s.history.map(x=>x.id)]);
 s.sources=s.sources.filter(x=>keep.has(x.id));
 let plan;log.planningFacts=structuredClone(s.facts);
 try{plan=await call('plan',{...context(s,event),explicitContrast:contrast});log.plan=plan;
  for(const c of plan.close){if(!['evidence-available','rule-replaced','irrelevant'].includes(c.reason)){log.errors.push({stage:'task-close',error:'Invalid closure reason'});continue;}const old=s.tasks.find(t=>t.key===c.key);if(!old)continue;
   if(c.reason==='evidence-available'&&!knownEvidence(s,old)){log.taskTransitions.push({key:c.key,result:'closure-rejected',reason:'missing-current-evidence'});continue;}
   s.tasks=s.tasks.filter(t=>t.key!==c.key);log.taskTransitions.push({key:c.key,result:'closed',reason:c.reason,task:old});
  }
  for(const t of plan.tasks){try{const accepted=acceptTask(s,t,contrast),i=s.tasks.findIndex(x=>x.key===t.key);
   if(i<0){if(s.tasks.length>=8)throw Error('Active task cap');s.tasks.push(accepted);log.tasksCreated.push(accepted);}else{s.tasks[i]=accepted;log.taskTransitions.push({key:t.key,result:'refreshed',task:accepted});}
  }catch(e){log.errors.push({stage:'task-validation',error:e.message});}}
  for(const id of plan.readIds){const d=s.catalog.find(x=>x.id===id);if(!d){log.errors.push({stage:'read',error:'Unavailable document'});continue;}
   log.reads.push(id);s.receipts.push({id,eventId:event.id,scope:d.scope});s.sources.push({id:d.id,text:d.text});
   if(d.scope===s.scope)observe(s,d.observations,d.id,true);
  }
 }catch(e){log.errors.push({stage:'plan',error:e.message});}
 for(const t of s.tasks)if(t.status==='awaiting-evidence'&&knownEvidence(s,t))t.status='evidence-available';
 // Fixed three-role execution in all cells isolates acquisition from routing effects.
 if(!initial)for(const target of roles){const p=context(s,event);delete p.pendingQuestions;delete p.catalog;delete p.receipts;
  try{const a=await call('decide',{...p,target});commit(s,target,a);log.decisions.push({target,answer:a});}
  catch(e){log.errors.push({stage:'decide',target,error:e.message});}
 }
 log.taskSnapshot=structuredClone(s.tasks);if(!persistent)s.tasks=[];
 return {...log,state:s};
}
