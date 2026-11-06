import {hash,equal} from './core.mjs';
export const roles=['match','path','report'];
const fields={match:'eligible',path:'next',report:'recommend'};
export function checked(role,v){if(!equal(Object.keys(v),[fields[role]]))throw Error('Wrong output field');const x=v[fields[role]];if(x!==null&&(role==='path'?!['apply','wait','withdraw','none'].includes(x):typeof x!=='boolean'))throw Error('Wrong output type');return v;}
export function seed(t){return {scope:t.scope,rule:structuredClone(t.rule),facts:Object.fromEntries(Object.entries(t.initial).map(([k,v])=>[k,{value:v,alternatives:null,version:1}])),memories:Object.fromEntries(roles.map(r=>[r,{id:r,role:r,version:1,values:{[fields[r]]:null},status:'uncertain',refs:[],text:'尚未初始化'}])),sources:[{id:'initial-'+t.id,text:JSON.stringify(t.initial)},t.rule],pending:[]};}
export function worlds(s){let out=[{}];for(const [k,v]of Object.entries(s.facts)){const vals=v.value!==null?[v.value]:v.alternatives;if(!vals?.length)return null;out=out.flatMap(o=>vals.map(x=>({...o,[k]:x})));if(out.length>4)return null;}return out.length>=2?out:null;}
function observe(s,observations){const changed=[];for(const [k,v]of Object.entries(observations??{})){if(!s.facts[k])throw Error('Unknown fact field');const type=k==='applied'?'boolean':'number';if(v.value!==null&&typeof v.value!==type)throw Error('Invalid observation');if(v.alternatives&&(!v.alternatives.length||v.alternatives.some(x=>typeof x!==type)||new Set(v.alternatives).size!==v.alternatives.length))throw Error('Invalid observed alternatives');if(!equal({value:s.facts[k].value,alternatives:s.facts[k].alternatives},v)){s.facts[k]={...v,version:s.facts[k].version+1};changed.push(k);}}return changed;}
export function context(s,event,candidates,documents=[],readIds=[]){const {documents:unread,...visibleEvent}=event;const memories=Object.fromEntries(Object.entries(s.memories).map(([id,m])=>{const {text,...current}=m;return [id,{...current,historicalExplanation:{text,atMemoryVersion:m.version,sourceRefs:m.refs,notice:'生成当时的说明，不是本轮新事实；当前依据以sources和facts为准。'}}];}));return {event:visibleEvent,scope:s.scope,rule:s.rule,facts:s.facts,memories,sources:s.sources,candidates,catalog:documents.filter(d=>!readIds.includes(d.id)).map(({id,title,scope})=>({id,title,scope})),remainingReads:1-readIds.length,worlds:worlds(s)};}

export function requests(stage,a,ctx){
 const stamp=hash({facts:ctx.facts,rule:ctx.rule,memories:ctx.memories}),allowed=new Set(ctx.candidates);
 if(stage==='ordinary'){refsOK(a,ctx);if(!a.refs.includes(ctx.rule.id)||a.reviewIds.some(r=>!allowed.has(r))||new Set(a.reviewIds).size!==a.reviewIds.length)throw Error('Invalid ordinary review request');return {reviewIds:a.reviewIds,readIds:a.readIds,obligations:a.reviewIds.map(target=>({id:hash([stamp,target,'ordinary']),target,stamp,ruleId:ctx.rule.id,targetVersion:ctx.memories[target].version,refs:a.refs,status:'pending',kind:'ordinary-review-request'}))};}
 const targets=new Set();for(const w of a.witnesses){if(!allowed.has(w.target)||targets.has(w.target))throw Error('Unknown or repeated witness target');targets.add(w.target);const m=ctx.memories[w.target];if(m.status!=='current'||Object.values(m.values).includes(null))throw Error('Unknown conclusion is not a refutable proposition');if(!ctx.worlds?.some(world=>equal(world,w.assumptions)))throw Error('Invented witness assumptions');checked(w.target,w.alternativeValues);if(Object.values(w.alternativeValues).includes(null)||equal(w.alternativeValues,m.values))throw Error('Witness does not contradict known target');refsOK(w,ctx);if(!w.refs.includes(ctx.rule.id))throw Error('Unbound witness rule');}
 if(!a.witnesses.length&&a.readIds.length)throw Error('No witness cannot trigger probe evidence');
 return {reviewIds:[...targets],readIds:a.readIds,obligations:a.witnesses.map(w=>({id:hash([stamp,w]),target:w.target,stamp,ruleId:ctx.rule.id,targetVersion:ctx.memories[w.target].version,factVersions:Object.fromEntries(Object.entries(ctx.facts).map(([k,v])=>[k,v.version])),assumptions:w.assumptions,claimedAlternativeValues:w.alternativeValues,refs:w.refs,requestedDocumentIds:a.readIds,status:'pending',kind:'counterexample-evidence-obligation',notFact:true,notSemanticProof:true}))};
}

export async function step(previous,event,arm,call){
 const s=structuredClone(previous),log={eventId:event.id,arm,calls:0,reads:[],skipped:[],errors:[],extraError:null,extra:null,certificate:null,obligations:[],decisions:[],before:structuredClone(previous.memories)};
 const invoke=async(stage,p)=>{log.calls++;return call(stage,p);};
 let changed=[];if(event.scope===s.scope){s.sources.push({id:event.id,text:event.text});changed=observe(s,event.observations);if(event.rule&&!equal(event.rule,s.rule)){s.rule=structuredClone(event.rule);s.sources.push(event.rule);changed.push('rule');}}
 const affected=changed.some(k=>k!=='applied')?roles:changed.includes('applied')?['path']:[];
 let candidates=[...new Set([...affected,...s.pending])];log.scheduledCandidates=[...candidates];
 if(!candidates.length){log.noRelevantChange=true;return {...log,state:s};}
 const docs=event.documents??[],newlyAffected=new Set(),forced=new Set();
 const fetch=ids=>{for(const id of [...new Set(ids)]){if(log.reads.includes(id))continue;const d=docs.find(d=>d.id===id);if(!d||log.reads.length>=1)throw Error('Unavailable/read-limit source');log.reads.push(id);s.sources.push(d);if(d.scope===s.scope){const delta=observe(s,d.observations);for(const r of delta.some(k=>k!=='applied')?roles:delta.includes('applied')?['path']:[])newlyAffected.add(r);}}};
 let ctx=context(s,event,candidates,docs,log.reads);
 if(arm!=='ordinary'&&ctx.worlds){
  try{const stage=arm==='probe'?'probe':'ordinary',a=await invoke(stage,ctx);log.extra=a;const req=requests(stage,a,ctx);log.obligations=req.obligations;for(const r of req.reviewIds)forced.add(r);
    if(req.readIds.length){fetch(req.readIds);log.activeEvidenceTrigger=true;}
  }catch(e){log.extraError=e.message;}
 }
 // Neither a found nor an absent witness can remove a baseline candidate.
 // Raw hypotheses/alternative values never enter ordinary decision prompts.
 candidates=[...new Set([...candidates,...newlyAffected,...forced])];log.remainingCandidates=[...candidates];
 ctx=context(s,event,candidates,docs,log.reads);let plan;
 try{plan=await invoke('plan',ctx);if(plan.reviewIds.some(r=>!candidates.includes(r))||new Set(plan.reviewIds).size!==plan.reviewIds.length)throw Error('Invalid routing');fetch(plan.readIds);log.proposedPlan=structuredClone(plan);plan.reviewIds=[...new Set([...plan.reviewIds,...newlyAffected,...forced])];log.plan=plan;}
 catch(e){log.errors.push({stage:'plan',error:e.message});plan={reviewIds:[...new Set([...candidates,...newlyAffected,...forced])]};}
 for(const r of plan.reviewIds){ctx=context(s,event,candidates,docs,log.reads);try{const a=await invoke('decide',{...ctx,target:r});commit(s,r,a,ctx);s.pending=s.pending.filter(x=>x!==r);log.decisions.push({role:r,answer:a});for(const o of log.obligations.filter(o=>o.target===r)){o.status='local-review-completed';o.newTargetVersion=s.memories[r].version;}}catch(e){log.errors.push({stage:'decide',role:r,error:e.message});if(!s.pending.includes(r))s.pending.push(r);}}
 for(const o of log.obligations){o.actuallyRead=log.reads;o.assumptionContradictedByObservation=o.assumptions?Object.entries(o.assumptions).some(([k,v])=>s.facts[k].value!==null&&!equal(s.facts[k].value,v)):null;}
 return {...log,state:s};
}
function refsOK(a,ctx){if(!a.refs.length||a.refs.some(id=>!ctx.sources.some(s=>s.id===id)))throw Error('Unavailable reference');}
function commit(s,role,a,ctx){checked(role,a.values);refsOK(a,ctx);const expected=Object.values(a.values).includes(null)?'uncertain':'current';if(a.status!==expected)throw Error('Value/status disagreement');s.memories[role]={...s.memories[role],version:s.memories[role].version+1,values:a.values,status:a.status,refs:a.refs,text:a.answer};}
export async function initialize(t,call){const s=seed(t),log=[];for(const r of roles){const ctx=context(s,{id:'initial',text:'根据初始来源建立三个角色的当前结论。'},roles);try{const a=await call('decide',{...ctx,target:r});commit(s,r,a,ctx);log.push({role:r,status:'ok'});}catch(e){s.pending.push(r);log.push({role:r,status:'error',error:e.message});}}return {state:s,log};}
