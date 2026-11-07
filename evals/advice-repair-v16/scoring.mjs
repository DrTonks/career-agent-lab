import {normalizePresentation} from './normalization.mjs';
import {readHours} from './calendar-check.mjs';
export function labels(text,expected){return Object.fromEntries(Object.keys(expected).map(id=>{
 const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const vals=[...text.matchAll(new RegExp('核定\\s*[\\[【]\\s*'+escaped+'\\s*[\\]】]\\s*[=＝:：]\\s*(符合|不符|待核定)','g'))].map(m=>m[1]);
 return [id,vals.length&&new Set(vals).size===1?vals[0]:null];
}));}
const valid=a=>!!a&&!a.failure&&['succeeded','partial'].includes(a.result.status);
export function score(raw,gold){
 const d=normalizePresentation(raw);
 const expected=gold.labels,arts=d.effectiveArtifacts??d.artifacts,byRole=Object.fromEntries(arts.map(a=>[a.expert,a])),roles={};
 for(const role of ['match','path','report']){
  const a=byRole[role],found=labels(a?.result.summary??'',expected);
  roles[role]={artifactId:a?.id??null,found,correct:valid(a)&&Object.keys(expected).every(id=>found[id]===expected[id]),fresh:d.artifacts.some(n=>n.id===a?.id),failure:a?.failure??null};
 }
 const m=byRole.match,ranked=(m?.result.artifact.rankedJobs??[]).map(j=>j.id).sort(),wanted=Object.keys(expected).filter(id=>expected[id]==='符合').sort();
 const recommendationsCorrect=valid(m)&&JSON.stringify(ranked)===JSON.stringify(wanted),final=labels(d.answer??'',expected),finalCorrect=Object.keys(expected).every(id=>final[id]===expected[id]);
 const freshnessCorrect=gold.requiredUpdatedRoles.every(role=>roles[role].fresh&&roles[role].correct);
 const calculation=readHours(d.answer),arithmeticCorrect=calculation===gold.calculation;
 const roleArithmeticCorrect=['match','path','report'].every(role=>readHours(byRole[role]?.result.summary??'')===gold.calculation);
 return {calculation,arithmeticCorrect,roleArithmeticCorrect,expected,roles,ranked,wanted,recommendationsCorrect,final,finalCorrect,freshnessCorrect,verdictsCorrect:Object.values(roles).every(r=>r.correct),primaryCorrect:arithmeticCorrect&&roleArithmeticCorrect&&Object.values(roles).every(r=>r.correct)&&recommendationsCorrect&&finalCorrect&&freshnessCorrect};
}
