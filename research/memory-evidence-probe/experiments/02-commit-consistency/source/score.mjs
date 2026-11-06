import {equal} from '../advice-repair-v6/core.mjs';
export function score(c,g,r){
  const old=c.memories.find(m=>m.id===c.targetId),target=r.finalMemories?.find(m=>m.id===c.targetId);
  const collateral=c.memories.some(m=>m.id!==c.targetId&&!equal(r.finalMemories?.find(n=>n.id===m.id),m));
  const valueCorrect=equal(target?.values,g.values),statusCorrect=target?.status===g.status;
  const unknownConcreteValue=Object.entries(g.values).some(([f,v])=>v===null&&target?.values?.[f]!==null&&target?.values?.[f]!==undefined);
  const unknownCurrentStatus=g.status==='uncertain'&&target?.status==='current';
  const proposedWriteCount=r.decision?.patches?.length??0,committedWriteCount=r.status==='ok'?proposedWriteCount:0;
  return {correct:r.status==='ok'&&valueCorrect&&statusCorrect&&!collateral,valueCorrect,statusCorrect,collateral,
    falseCertainty:unknownConcreteValue||unknownCurrentStatus,unknownConcreteValue,unknownCurrentStatus,
    overNull:g.status==='current'&&Object.values(target?.values??{}).includes(null),
    proposedWriteCount,committedWriteCount,
    unchangedValueWrite:committedWriteCount>0&&equal(target?.values,old.values),
    actualValues:target?.values??null,expectedValues:g.values,actualStatus:target?.status??null,expectedStatus:g.status};
}
export function paired(a,b){return {wins:a.filter((x,i)=>!x.correct&&b[i].correct).length,losses:a.filter((x,i)=>x.correct&&!b[i].correct).length,ties:a.filter((x,i)=>x.correct===b[i].correct).length};}
