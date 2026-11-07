import {checkAssessmentBinding} from '../../dist/src/current-assessment.js';
import {TimeRule,evaluateTimeRule,verifyTimeRefutation} from '../../dist/src/time-refutation.js';
import {hash} from '../../dist/src/config.js';
import {readCalendar,readHours} from './calendar-check.mjs';
export function view(t,i){
 const sources=t.events.slice(0,i+1).map(e=>({id:'event:'+e.id,text:e.text})),calendar=readCalendar(sources);
 const factsVersion=hash({calendar:calendar.factsHash,profile:t.userFacts}),rules=t.jobs.map(j=>({...j,rule:TimeRule.parse(j.rule),ruleVersion:hash(TimeRule.parse(j.rule))}));
 return {sources,calendar,factsVersion,rules,evidenceIds:[t.userFacts.sourceId,...sources.map(s=>s.id),...rules.map(j=>j.sourceId)],hypotheses:t.events[i].hypotheses};
}
export function solve(v,t){
 const before={months:t.userFacts.months,dailyHours:v.calendar.dailyHours};
 const judgments=v.rules.map(j=>({jobId:j.id,ruleVersion:j.ruleVersion,...evaluateTimeRule(j.rule,before)}));
 const cases=v.hypotheses.flatMap(h=>{
  const afterCalendar=readCalendar([...v.sources,{id:'hypothesis:'+h.id,text:h.text}]);
  const after={months:t.userFacts.months,dailyHours:afterCalendar.dailyHours};
  return v.rules.map(j=>{const b=evaluateTimeRule(j.rule,before),a=evaluateTimeRule(j.rule,after);return {hypothesisId:h.id,jobId:j.id,factsVersion:v.factsVersion,ruleVersion:j.ruleVersion,before:b.verdict,predictedAfter:a.verdict,claimsRefutation:b.verdict!=='待核定'&&a.verdict!=='待核定'&&b.verdict!==a.verdict,beforeChecks:b.checks,afterChecks:a.checks};});
 });return {schemaVersion:'business-check-v1',factsVersion:v.factsVersion,weeklyHours:v.calendar.weeklyHours,dailyHours:v.calendar.dailyHours,judgments,cases,scope:'Public structured time-rule cards only. Hypotheses are isolated simulations, never actual user facts.'};
}
export function validateCases(proposals,v,t){
 const seen=new Set();return proposals.map(p=>{
  const key=p.hypothesisId+'/'+p.jobId,h=v.hypotheses.find(h=>h.id===p.hypothesisId),j=v.rules.find(j=>j.id===p.jobId);
  if(seen.has(key)||!h||!j)return {...p,validation:{valid:false,status:'unknown-or-duplicate-case'}};
  seen.add(key);const after=readCalendar([...v.sources,{id:'hypothesis:'+h.id,text:h.text}]);
  return {...p,validation:verifyTimeRefutation({jobId:j.id,rule:j.rule,ruleVersion:j.ruleVersion,factsVersion:v.factsVersion,before:{months:t.userFacts.months,dailyHours:v.calendar.dailyHours},after:{months:t.userFacts.months,dailyHours:after.dailyHours},proposal:p})};
 });
}
export function applyPolicy(policy,author,review,v,t){
 const expected={factsVersion:v.factsVersion,weeklyHours:v.calendar.weeklyHours,ruleVersions:Object.fromEntries(v.rules.map(j=>[j.id,j.ruleVersion])),evidenceIds:v.evidenceIds};
 const structural=checkAssessmentBinding(author.currentAssessment,{...expected,weeklyHours:author.currentAssessment?.weeklyHours??null});
 const typed=checkAssessmentBinding(author.currentAssessment,expected),legacy=readHours(author.summary??'')===expected.weeklyHours;
 const actual=solve(v,t),declared=author.currentAssessment?.judgments??[];
 const currentBusinessValid=actual.judgments.every(j=>declared.some(d=>d.jobId===j.jobId&&d.verdict===j.verdict));
 const currentValid=structural.valid&&(policy==='text'?legacy:typed.valid)&&(policy!=='verified'||currentBusinessValid);
 const cases=review.cases??[],checked=validateCases(cases,v,t),expectedCount=v.hypotheses.length*v.rules.length;
 const caseSchemaValid=cases.length===expectedCount&&new Set(cases.map(c=>c.hypothesisId+'/'+c.jobId)).size===expectedCount&&checked.every(c=>!['binding-rejected','unknown-or-duplicate-case'].includes(c.validation.status));
 const accepted=caseSchemaValid?checked.filter(c=>policy!=='verified'||c.validation.valid):[];
 return {policy,currentStateCommitted:review.close===true&&currentValid,closureReason:!structural.valid?structural.reason:policy==='text'&&!legacy?'ambiguous-or-mismatched-summary':policy!=='text'&&!typed.valid?typed.reason:policy==='verified'&&!currentBusinessValid?'current-business-mismatch':review.close!==true?'reviewer-kept-open':null,acceptedCases:accepted,unresolvedCases:checked.filter(c=>!accepted.includes(c)),allCasesResolved:caseSchemaValid&&accepted.length===expectedCount,fullyResolved:review.close===true&&currentValid&&caseSchemaValid&&accepted.length===expectedCount,actualCalendarUnchanged:readCalendar(v.sources).factsHash===v.calendar.factsHash,validationScope:policy==='verified'?'structured-current+business-predicate':'model-reported-cases; no business admission check'};
}
