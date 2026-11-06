import {z} from 'zod';
const atom=z.union([z.boolean(),z.string(),z.number(),z.null()]),values=z.record(z.string(),atom);
const outputs=z.object({match:values,path:values,report:values}).strict();
const schemas={
  decide:z.object({answer:z.string(),values,status:z.enum(['current','uncertain']),refs:z.array(z.string()).min(1)}).strict(),
  plan:z.object({answer:z.string(),readIds:z.array(z.string()),reviewIds:z.array(z.enum(['match','path','report']))}).strict(),
  ordinary:z.object({answer:z.string(),outputs,readIds:z.array(z.string()).max(1),refs:z.array(z.string()).min(1)}).strict(),
  probe:z.object({answer:z.string(),branches:z.array(z.object({assumptions:values,outputs}).strict()).min(2).max(4),readIds:z.array(z.string()).max(1),refs:z.array(z.string()).min(1)}).strict()
};
const shared='你参与虚构职业规划连续记忆维护。只输出JSON，answer为简短结论说明放第一，不输出推理过程。只有原件和源系统观测是事实，旧记忆与模型候选可错。未知不能猜值；所有证据允许状态输出相同可确定该结论，事实本身仍未知。岗位资格按原件；next符合未申请apply、符合在途wait、不符在途withdraw、不符无申请none。recommend只等于资格，与是否已申请无关。禁止实际外部申请。引用只限sources中真实ID。';
const help={
  plan:'决定读取哪些目录档案、复核哪些候选角色。目录不含原文，不能当事实。不必为了核对而核对；已能确认旧结论仍成立可不复核。输入candidates为本轮可复核目标；reviewIds只能从中选。readIds最多一份，remainingReads=0时必须为空。格式{answer,readIds:[],reviewIds:[]}。',
  decide:'只更新target指定的唯一角色。输出{answer,values,status,refs}，有null则uncertain，否则current。读到确认原件后按确认值，假设不得当作实际观测。',
  ordinary:'使用额外一次普通复核机会，审查当前三个角色结论、必要证据与未知约束。直接给出当前可确定的各角色字段，不能确定的用null。输出{answer,outputs:{match:{eligible},path:{next},report:{recommend}},readIds:[],refs}。不要求列举假设分支，允许用任何可靠推理。结果只用于安排后续取证/局部复核，不直接写入事实。',
  probe:'按输入worlds逐一演练，必须覆盖每个完整assumptions且不得增删。每个分支固定规则，仅使用该分支条件，分别计算match/path/report字段。输出{answer,branches:[{assumptions:{days,hours,applied},outputs:{match:{eligible},path:{next},report:{recommend}}}],readIds:[],refs}。分支是条件假设，不是实际发生的预测。'
};
export function messages(stage,payload){if(!help[stage])throw Error('Unknown stage');const select=['ordinary','probe'].includes(stage)?' 顶层还必须输出readIds数组：如结论无法确定，或分支有分歧，从catalog选最有助于消除该不确定性的档案ID，最多一个；无需或没有适当资料时为空。只按目录标题和作用域选择，不得读取未提供正文或假设其中内容。':'';
 let scope='';if(stage==='decide'){const field={match:'eligible',path:'next',report:'recommend'}[payload.target];if(!field)throw Error('Missing unique decision target');scope=` 本次唯一目标=${payload.target}。values是扁平对象，只包含键${field}，不得嵌套match/path/report或其他角色字段。${field==='next'?'值只可apply/wait/withdraw/none/null。':'值只可true/false/null。'}完整JSON形状示例（占位值不是答案）：`+JSON.stringify({answer:'简短结论说明',values:{[field]:null},status:'uncertain',refs:['实际可见原件ID']});}
 return [{role:'system',content:shared+help[stage]+select+scope},{role:'user',content:JSON.stringify(payload)}];}
export function parse(stage,raw){return schemas[stage].parse(JSON.parse(raw));}
