import test from 'node:test';
import assert from 'node:assert/strict';
import {score} from './scoring.mjs';
import {normalizePresentation} from './normalization.mjs';
test('format normalization accepts bold verdicts without changing contradictory or wrong outcomes',()=>{
 const gold={labels:{a:'符合'},requiredUpdatedRoles:[],calculation:21};
 const arts=['match','path','report'].map(expert=>({id:expert,expert,result:{status:'succeeded',summary:'核定[a]=**符合**；周工时=21',artifact:{rankedJobs:[{id:'a'}]}}}));
 const d={artifacts:arts,answer:'核定[a] = **符合**；周工时=21'};
 assert.equal(score(d,gold).primaryCorrect,true);
 assert.equal(score(normalizePresentation(d),gold).primaryCorrect,true);
 assert.equal(score(normalizePresentation({...d,answer:'核定[a]=**不符**'}),gold).primaryCorrect,false);
 assert.equal(score(normalizePresentation({...d,answer:'核定[a]=**符合**，核定[a]=不符'}),gold).primaryCorrect,false);
 assert.equal(d.answer,'核定[a] = **符合**；周工时=21');
});

test('canonical source prefix in a verdict identifies the same job',()=>{assert.equal(normalizePresentation({answer:'核定[job:a]=符合',artifacts:[]}).answer,'核定[a]=符合');assert.equal(normalizePresentation({answer:'job:a 的事实未改',artifacts:[]}).answer,'job:a 的事实未改');});

test('explicit table rows preserve job identity and verdict without interpreting prose',()=>{assert.match(normalizePresentation({answer:'| job:a | **符合** | because |',artifacts:[]}).answer,/核定\[a\]=符合/);assert.equal(normalizePresentation({answer:'| job:a | 不确定 | because |',artifacts:[]}).answer,'| job:a | 不确定 | because |');});
