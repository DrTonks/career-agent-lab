import {ProbeStore} from '../advice-repair-v6/store.mjs';
import {packet,hash} from '../advice-repair-v6/core.mjs';
import {bind,assemble,sections} from '../advice-repair-v8/context.mjs';
import {verdictDecision} from './prompts.mjs';

// All arms use this same frozen packet. No labels, rule evaluator or model calls.
export function prepare(c){
  const registry=bind(c.initialMemories,c.initialSources,c.declarations);
  const b=assemble({targetId:c.targetId,registry,memories:c.memories,sources:c.sources,at:c.event.receivedAt,readLimit:3,memoryLimit:16});
  const sources=[{id:c.event.id,text:c.event.text},...b.sources],target=c.memories.find(m=>m.id===c.targetId);
  return {...packet({event:c.event,memories:b.memories,probe:null,sources}),owner:target.role,targetId:target.id,targetFields:Object.keys(target.values),sourceBindings:registry,retrievalReceipt:b.receipt,assemblyIssues:b.issues,localEvidence:sections(b.memories,sources,target.id)};
}
export function apply(c,context,decision){
  const store=new ProbeStore(':memory:');
  try{
    // Archived sources satisfy old provenance IDs but are NOT part of the model
    // context or allowed patch evidence if current retrieval cannot access them.
    const archive=[...new Map([...c.initialSources,...c.sources].map(s=>[s.id,s])).values()];
    store.seed(c.memories,archive);store.arrive(c.event);
    if(decision.patches.some(p=>p.memoryId!==c.targetId)||decision.patches.length>1)throw Error('Invalid target scope');
    store.commit({id:hash([c.id,decision]),eventId:c.event.id,readVersions:Object.fromEntries(context.memories.map(m=>[m.id,m.version])),patches:decision.patches,visibleSourceIds:[...context.sources.map(s=>s.id),...context.memories.map(m=>m.id)],propagation:'none'});
    return {status:'ok',decision,finalMemories:store.memories()};
  }catch(e){return {status:'error',error:{name:e.name,message:String(e.message).slice(0,1200)},decision,finalMemories:structuredClone(c.memories)};}
  finally{store.close();}
}
const failure=(c,e)=>({status:'error',error:{name:e.name,message:String(e.message).slice(0,1200)},finalMemories:structuredClone(c.memories)});

// Original and review share the same first candidate: paired repair measurement,
// not three independent resamples. Review gets at most ONE extra physical call.
export async function execute(c,context,call,{orderFirst=false}={}){
  const records={},stages=[];let candidate;
  const base=async()=>{
    try{candidate=await call('decide',context);records.original=apply(c,context,candidate);}
    catch(e){records.original=failure(c,e);}stages.push('decide');
  };
  const order=async()=>{
    try{records['answer-first']=apply(c,context,await call('answer-first',context));}
    catch(e){records['answer-first']=failure(c,e);}stages.push('answer-first');
  };
  if(orderFirst){await order();await base();}else{await base();await order();}
  if(candidate){
    try{
      const verdict=await call('review',{...context,candidate});
      const reviewed=apply(c,context,verdictDecision(verdict,c.memories.find(m=>m.id===c.targetId)));
      if(reviewed.status!=='ok')throw Error('Review commit rejected: '+reviewed.error.message);
      records.review={...reviewed,reviewStatus:'accepted',fallback:false};
    }catch(e){records.review={...structuredClone(records.original),reviewStatus:'rejected',fallback:true,reviewError:{name:e.name,message:String(e.message).slice(0,1200)}};}
    stages.push('review');
  }else records.review={...structuredClone(records.original),reviewStatus:'skipped-invalid-candidate',fallback:true};
  return {caseId:c.id,contextHash:hash(context),records,stages};
}
