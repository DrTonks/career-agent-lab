import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync} from 'node:fs';import {resolve,join} from 'node:path';
import {view,applyPolicy} from './core.mjs';import {hash} from '../../dist/src/config.js';
const root=resolve(process.argv[2]),base='evals/advice-repair-v17',read=p=>JSON.parse(readFileSync(p,'utf8')),save=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2)+'\n');
const data=read(base+'/data/test.json'),gold=read(base+'/private/gold.json'),policies=['text','structured','verified'];
const rows=[],replay=[],authors=[],audit={registeredHashes:true,rawRequestInputsExcludeGold:true,allHypothesesIsolated:true,caseResultsReproduce:true,secretAbsent:true};
const reg=read(join(root,'registration.json'));for(const [p,h]of Object.entries(reg.hashes)){if(hash(readFileSync(p,'utf8'))!==h||hash(readFileSync(join(root,'source-snapshot',p),'utf8'))!==h)audit.registeredHashes=false;}
const key=readFileSync('../api.txt','utf8').trim();
function score(author,review,outcome,g){
 const numericCorrect=author?.currentAssessment?.weeklyHours===g.weeklyHours;
 const currentCorrect=numericCorrect&&Object.entries(g.judgments).every(([id,val])=>author?.currentAssessment?.judgments?.some(j=>j.jobId===id&&j.verdict===val));
 const valid=c=>{const expected=g.cases.find(x=>x.jobId===c.jobId&&x.hypothesisId===c.hypothesisId);return !!expected&&expected.predictedAfter===c.predictedAfter&&expected.claimsRefutation===c.claimsRefutation;};
 const proposals=review?.cases??[],accepted=outcome?.acceptedCases??[],trueCases=g.cases.filter(c=>c.claimsRefutation);
 const uniqueCorrect=new Set(proposals.filter(valid).map(c=>c.hypothesisId+'/'+c.jobId));
 return {numericCorrect,currentCorrect,currentCommitted:!!outcome?.currentStateCommitted,falseCurrentCommit:!!outcome?.currentStateCommitted&&!currentCorrect,correctCurrentNotCommitted:currentCorrect&&!outcome?.currentStateCommitted,fullyResolved:!!outcome?.fullyResolved,proposalCount:proposals.length,correctProposals:proposals.filter(valid).length,correctExpectedCases:uniqueCorrect.size,expectedCases:g.cases.length,acceptedCount:accepted.length,correctAccepted:accepted.filter(valid).length,falseAccepted:accepted.filter(c=>!valid(c)).length,expectedTrueRefutations:trueCases.length,correctTrueRefutationsAccepted:accepted.filter(c=>valid(c)&&c.claimsRefutation).length,expectedNonRefutations:g.cases.length-trueCases.length,correctNonRefutationsAccepted:accepted.filter(c=>valid(c)&&!c.claimsRefutation).length,unresolvedCount:g.cases.length-accepted.length,allCasesResolved:!!outcome?.allCasesResolved,closureReason:outcome?.closureReason??null};
}
for(const t of data)for(let i=0;i<t.events.length;i++){
 const g=gold.find(g=>g.trajectory===t.id&&g.event===i),dir=join(root,t.id,'event-'+i),aPath=join(dir,'author/actor-result.json'),author=existsSync(aPath)?read(aPath).parsed:null,v=view(t,i);
 authors.push({trajectory:t.id,event:i,valid:!!author,...score(author,{cases:author?.cases??[]},null,g)});
 for(const policy of policies){const p=join(dir,policy,'result.json');if(!existsSync(p))continue;const r=read(p);rows.push({trajectory:t.id,event:i,policy,status:r.status,...score(author,r.review,r.outcome,g)});
 if(author&&r.review){const calculated=applyPolicy(policy,author,r.review,v,t);if(hash(calculated)!==hash(r.outcome))audit.caseResultsReproduce=false;if(!calculated.actualCalendarUnchanged)audit.allHypothesesIsolated=false;}
 if(author){const review={close:true,cases:author.cases};const outcome=applyPolicy(policy,author,review,v,t);replay.push({trajectory:t.id,event:i,policy,...score(author,review,outcome,g)});}
 }
}
const sum=rs=>{const out={events:rs.length};for(const k of ['numericCorrect','currentCorrect','currentCommitted','falseCurrentCommit','correctCurrentNotCommitted','fullyResolved','proposalCount','correctProposals','correctExpectedCases','expectedCases','acceptedCount','correctAccepted','falseAccepted','expectedTrueRefutations','correctTrueRefutationsAccepted','expectedNonRefutations','correctNonRefutationsAccepted','unresolvedCount','allCasesResolved'])out[k]=rs.reduce((s,r)=>s+Number(r[k]??0),0);return out;};
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(join(dir,d.name)):[join(dir,d.name)]);}
const usage={total:{calls:0,input:0,output:0,cachedInput:0,errors:0},byActor:{}},tools={author:0,text:0,structured:0,verified:0};
for(const p of walk(root)){
 if(!p.endsWith('.json'))continue;
 const raw=readFileSync(p,'utf8');if(key&&raw.includes(key))audit.secretAbsent=false;
 if(/\/calls\/\d+\.json$/.test(p)){
  const c=JSON.parse(raw),actor=p.split('/calls/')[0].split('/').at(-1);usage.byActor[actor]??={calls:0,input:0,output:0,cachedInput:0,errors:0};
  if(c.messages?.some(m=>(m.content??'').includes('private/gold.json')))audit.rawRequestInputsExcludeGold=false;
  for(const u of [usage.total,usage.byActor[actor]]){u.calls++;if(c.status!=='ok')u.errors++;for(const k of ['input','output','cachedInput'])u[k]+=c.response?.usage?.[k]??0;}
 }
 if(p.endsWith('/actor-result.json')){const a=JSON.parse(raw),actor=p.split('/').at(-2);tools[actor]=(tools[actor]??0)+(a.toolLog?.length??0);}
}
const result={scope:'Two-agent component experiment; not a native four-expert rerun',complete:rows.length===48,authors:Object.fromEntries(Object.entries(sum(authors)).filter(([k])=>['events','numericCorrect','currentCorrect','proposalCount','correctProposals','expectedCases','expectedTrueRefutations','expectedNonRefutations'].includes(k))),live:Object.fromEntries(policies.map(p=>[p,sum(rows.filter(r=>r.policy===p))])),sharedAuthorReplay:Object.fromEntries(policies.map(p=>[p,sum(replay.filter(r=>r.policy===p))])),usage,tools,audit};
mkdirSync(root,{recursive:true});save(join(root,'summary.json'),result);save(join(root,'scored-events.json'),rows);save(join(root,'shared-author-replay.json'),replay);save(join(root,'scored-authors.json'),authors);console.log(JSON.stringify(result,null,2));
