import test from 'node:test';
import assert from 'node:assert/strict';
import {score,labels} from './scoring.mjs';
const gold={labels:{a:'符合'},requiredUpdatedRoles:['match','path','report'],calculation:21};
const arts=['match','path','report'].map(expert=>({id:expert,expert,result:{status:'succeeded',summary:'核定[a]=符合；周工时=21',artifact:{rankedJobs:[{id:'a'}]}}}));
test('correct text cannot hide stale affected outputs; unchanged roles may carry on irrelevant turns',()=>{
 const d={artifacts:[],effectiveArtifacts:arts,answer:'核定[a]=符合；周工时=21'};
 assert.equal(score(d,gold).primaryCorrect,false);
 assert.equal(score(d,{...gold,requiredUpdatedRoles:[]}).primaryCorrect,true);
 assert.equal(score({...d,artifacts:arts},gold).primaryCorrect,true);
 const failed=structuredClone(arts);failed[0].failure={code:'limit'};
 assert.equal(score({...d,artifacts:failed,effectiveArtifacts:failed},gold).primaryCorrect,false);
});
test('conflicting labels and omitted eligible candidates fail',()=>{
 assert.equal(labels('核定[a]=符合；核定[a]=不符',gold.labels).a,null);
 const missing=structuredClone(arts);missing[0].result.artifact.rankedJobs=[];
 assert.equal(score({artifacts:missing,answer:'核定[a]=符合；周工时=21'},gold).recommendationsCorrect,false);
});
