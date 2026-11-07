import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {join,resolve} from 'node:path';import {view,solve} from './core.mjs';import {hash} from '../../dist/src/config.js';
const root=resolve(process.argv[2]),read=p=>JSON.parse(readFileSync(p,'utf8')),data=read('evals/advice-repair-v17/data/test.json');
let actors=0,receipts=0,events=0;let reviewSystem=null,reviewTools=null;
for(const t of data)for(let i=0;i<t.events.length;i++){
 const v=view(t,i),dir=join(root,t.id,'event-'+i),snapshot=read(join(dir,'visible-snapshot.json')),authored=read(join(dir,'author/actor-result.json')).parsed;
 assert.deepEqual(snapshot.sources,v.sources);assert.deepEqual(snapshot.rules,v.rules);assert.equal(snapshot.factsVersion,v.factsVersion);
 const common={sources:v.sources,userFacts:t.userFacts,publicRules:v.rules,hypotheses:v.hypotheses,metadata:{factsVersion:v.factsVersion,ruleVersions:Object.fromEntries(v.rules.map(j=>[j.id,j.ruleVersion])),evidenceIds:v.evidenceIds}};
 for(const actor of ['author','text','structured','verified']){
  const p=join(dir,actor),result=read(join(p,'actor-result.json')),call=read(join(p,'calls/001.json'));
  const actual=JSON.parse(call.messages[1].content);let expected;
  if(actor==='author'){const previous=i?read(join(root,t.id,'event-'+(i-1),'author/actor-result.json')).parsed:t.historicalMemory;expected={...common,previousMemory:previous};}
  else{const previous=i?read(join(root,t.id,'event-'+(i-1),actor,'result.json')):null;expected={...common,authorSummary:authored.summary,authorCases:authored.cases,stateProjection:actor==='text'?{summary:authored.summary}:{currentAssessment:authored.currentAssessment},previousWorkflow:previous?{currentStateCommitted:previous.outcome?.currentStateCommitted,fullyResolved:previous.outcome?.fullyResolved,closureReason:previous.outcome?.closureReason}:null};
   reviewSystem??=call.messages[0].content;reviewTools??=call.tools;assert.equal(call.messages[0].content,reviewSystem);assert.deepEqual(call.tools,reviewTools);
  }
  assert.deepEqual(actual,expected);assert.equal(result.inputHash,hash(expected));
  for(const log of result.toolLog){const expectedTool=actor==='author'?{factsVersion:v.factsVersion,weeklyHours:v.calendar.weeklyHours,dailyHours:v.calendar.dailyHours,sourceRefs:v.evidenceIds}:solve(v,t);assert.deepEqual(log.result,expectedTool);receipts++;}
  actors++;
 }
 events++;
}
const audit={passed:true,events,actors,receipts,identicalReviewerSystemAndTools:true,inputsExactlyReconstructedFromPublicSourcesAndPreviousOutputs:true,noFutureEventInput:true};writeFileSync(join(root,'input-audit.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit));
