import {createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,20);
export const roles=['profile','match','path','report'];
export function evidenceIndex(artifacts){
 const claims=Object.fromEntries(artifacts.map(a=>['artifact:'+a.id,a]));
 const evidence={};
 for(const a of artifacts)for(const e of a.publishedEvidence??[]){
  if(e.kind==='artifact'||e.id.startsWith('artifact:'))continue;
  const text=Array.isArray(e.readTexts)?e.readTexts.join('\n'):e.text;
  evidence[e.id]={id:e.id,text,version:digest(text),kind:e.kind};
 }
 return {claims,evidence};
}
export function taskKey(t){return digest([t.subject.trim(),t.field.trim().toLowerCase()]);}
export function validateTask(t,index,catalog,allowBranches){
 if(!t.question?.trim()||!t.subject?.trim()||!t.field?.trim())throw Error('missing-condition');
 if(!Array.isArray(t.targets)||!t.targets.length||t.targets.some(r=>!roles.includes(r)))throw Error('invalid-target');
 if(!Array.isArray(t.claimRefs)||!t.claimRefs.length||t.claimRefs.some(id=>!index.claims[id]))throw Error('unseen-claim');
 if(!Array.isArray(t.evidenceRefs)||t.evidenceRefs.some(id=>!index.evidence[id]))throw Error('unread-primary-evidence');
 if(!Array.isArray(t.readIds)||t.readIds.some(id=>!catalog.some(d=>d.id===id)))throw Error('unknown-requested-source');
 if(!Array.isArray(t.branches)||t.branches.length>2||(!allowBranches&&t.branches.length))throw Error('invalid-branches');
 if(!['dispatch','wait'].includes(t.action))throw Error('invalid-action');
 const watchedIds=[...new Set([...t.readIds,...t.evidenceRefs.filter(id=>catalog.some(d=>d.id===id)),...(catalog.some(d=>d.id===t.subject)?[t.subject]:[])])].sort();
 return {...t,key:taskKey(t),watchedIds,targets:[...new Set(t.targets)].sort(),notFact:true};
}
export function reconcile({previous=[],proposals=[],closures=[],index,catalog,event,initial=false,persistent=true}){
 const map=new Map((persistent?previous:[]).map(t=>[t.key,structuredClone(t)])),transitions=[],closedNow=new Set();
 const versions=Object.fromEntries(catalog.map(d=>[d.id,d.version]));
 for(const c of closures){
  const t=map.get(c.key);if(!t)continue;
  const refs=c.evidenceQuotes??[];
  const supported=!t.watchedIds.some(id=>t.sourceVersions?.[id]!==versions[id])&&refs.length>0&&refs.every(q=>q.quote?.trim()&&index.evidence[q.id]?.text.includes(q.quote));
  const complete=t.targets.every(role=>t.lastExecution?.targets.some(x=>x.role===role&&x.started&&x.artifactId&&!x.failed));
  const outputRefs=c.claimRefs??[];
  const current=outputRefs.length>0&&outputRefs.every(id=>index.claims[id]&&!index.claims[id].failure&&index.claims[id].result.status!=='failed')&&t.targets.every(role=>outputRefs.some(id=>index.claims[id]?.expert===role));
  if(!supported||!complete||!current||!c.reason?.trim()){
   transitions.push({key:t.key,type:'closure-rejected',reason:!supported?'missing-exact-primary-quote':!complete?'execution-incomplete':'missing-current-role-output'});continue;
  }
  t.status='resolved';t.resolution={...c,semanticVerified:false,eventId:event.id};
  closedNow.add(t.key);
  transitions.push({key:t.key,type:'resolved-with-cited-evidence',semanticVerified:false});
 }
 for(const proposed of proposals){
  const old=map.get(proposed.key),watchedIds=[...new Set([...(old?.watchedIds??[]),...proposed.watchedIds])].sort(),sourceVersions=Object.fromEntries(watchedIds.map(id=>[id,versions[id]]));
  const changedSourceIds=old?watchedIds.filter(id=>old.sourceVersions?.[id]!==versions[id]):[];
  const sourceChanged=changedSourceIds.length>0;
  const eventQuote=proposed.eventQuote?.trim()??'';
  const newQuote=eventQuote&&event.text.includes(eventQuote)&&eventQuote!==old?.lastEventQuote;
  const eligible=!initial&&!closedNow.has(proposed.key)&&(sourceChanged||(proposed.action==='dispatch'&&newQuote));
  const t={...old,...proposed,watchedIds,createdEvent:old?.createdEvent??event.id,sourceVersions,status:old?.status??'watching'};
  if(eligible){t.status='ready';t.lastEventQuote=eventQuote||old?.lastEventQuote;t.activation={eventId:event.id,sourceChanged,changedSourceIds,eventQuote};}
  else if(t.status!=='resolved'){t.status=old?.lastExecution?'waiting-for-new-evidence':'watching';}
  if(old?.status==='resolved'&&!eligible){t.status='resolved';t.resolution=old.resolution;}
  map.set(t.key,t);transitions.push({key:t.key,type:old?(eligible?'reactivated':'duplicate-or-no-new-evidence'):'created',status:t.status});
 }
 // Omitted questions persist without being sent again. Source changes are caught even if the model omits a task.
 for(const t of map.values()){
  if(!proposals.some(p=>p.key===t.key)&&t.status==='ready')t.status='waiting-for-new-evidence';
  if(!initial&&t.watchedIds.some(id=>t.sourceVersions?.[id]!==versions[id])){
   const changedSourceIds=t.watchedIds.filter(id=>t.sourceVersions?.[id]!==versions[id]);
   t.status='ready';t.activation={eventId:event.id,sourceChanged:true,changedSourceIds,eventQuote:''};
   t.sourceVersions=Object.fromEntries(t.watchedIds.map(id=>[id,versions[id]]));
  }
 }
 const tasks=[...map.values()];
 for(const t of tasks){if(!t.binding)t.binding={};t.binding={claimRefs:t.claimRefs,sourceVersions:t.sourceVersions};}
 return {tasks,active:tasks.filter(t=>t.status==='ready').slice(0,4),transitions};
}
export function recordExecution(tasks,active,artifacts,events,runId,eventId){
 const dispatched=new Set(active.map(t=>t.key));
 return tasks.map(t=>{
  if(!dispatched.has(t.key))return t;
  const targets=t.targets.map(role=>{
   const starts=events.filter(e=>e.type==='expert.started'&&e.payload.expert===role);
   const a=artifacts.filter(a=>a.expert===role).at(-1);
   return {role,started:starts.length>0,artifactId:a&&!a.failure&&a.result.status!=='failed'?a.id:null,failed:!!a?.failure||a?.result.status==='failed'};
  });
  return {...t,status:targets.every(x=>x.started&&x.artifactId&&!x.failed)?'outputs-available':'execution-incomplete',lastExecution:{runId,eventId,targets},resolution:null};
 });
}
