import {z} from 'zod';
import {messages as v10Messages,parse as v10Parse} from './base-prompts.mjs';
const role=z.enum(['match','path','report']),atom=z.union([z.boolean(),z.string(),z.number(),z.null()]),values=z.record(z.string(),atom);
const ordinary=z.object({answer:z.string(),reviewIds:z.array(role).max(3),readIds:z.array(z.string()).max(1),refs:z.array(z.string()).min(1)}).strict();
const witness=z.object({target:role,assumptions:values,alternativeValues:values,refs:z.array(z.string()).min(1)}).strict();
const probe=z.object({answer:z.string(),witnesses:z.array(witness).max(3),readIds:z.array(z.string()).max(1)}).strict();
export function messages(stage,payload){
 if(['decide','plan'].includes(stage))return v10Messages(stage,payload);
 const common='你参与虚构职业规划记忆维护。仅输出JSON，answer为简短说明置第一，不输出推理过程。只能据sources中的原件、当前facts和scope判断，历史解释不是新观测。目录只含标题及作用域，不能推测未读正文。资格按当前规则；recommend仅等于资格，已申请且符合时next=wait但recommend仍true。只有后续普通角色决定可以改写记忆。无反例或无需额外动作不能证明记忆正确，不能授权免查。';
 const instruction=stage==='ordinary'?'使用一次普通额外复核机会，自由检查当前候选角色需要哪些取证或复核，可使用任何可靠推理。只请求动作，不直接给最终结论。输出{answer,reviewIds:[候选角色],readIds:[目录ID],refs:[原件ID]}。reviewIds只可从candidates选；readIds最多1个，没有适当资料或无必要时为空。不需要额外复核可reviewIds=[]，但不影响普通计划继续执行。':
 '寻找可推翻当前候选角色的已确定结论的具体反例。只从worlds中选完整assumptions，必须是当前原件允许的条件，不得编造未来观测。固定其余条件，计算该角色在此假设下的alternativeValues；必须与当前确定字段不同。每个目标最多一个反例，总计最多三个。当前目标含null或status!=current时不要把未知当作待推翻命题。找不到可成立反例时witnesses=[]，不是证明安全。输出{answer,witnesses:[{target,assumptions:{days,hours,applied},alternativeValues:当前目标的扁平字段,refs:[原件ID]}],readIds:[目录ID]}。资格字段eligible、行动字段next、报告字段recommend。若找到反例，从catalog选择最多一份最有助于核实反例条件的真实确认档案。没有反例或没有适当资料时readIds=[]。反例仅形成取证/复核任务，不得写入真实画像。';
 if(!['ordinary','probe'].includes(stage))throw Error('Unknown V11 stage');const contract=` 普通复核的refs以及每个反例的refs必须包含当前规则ID ${payload.rule.id}，其余引用也必须在sources中。每条alternativeValues是仅有一个标量字段的扁平对象，match目标用eligible、path用next、report用recommend；不得再套角色名子对象。`;
 return [{role:'system',content:common+instruction+contract},{role:'user',content:JSON.stringify(payload)}];
}
export function parse(stage,text){if(stage==='ordinary')return ordinary.parse(JSON.parse(text));if(stage==='probe')return probe.parse(JSON.parse(text));return v10Parse(stage,text);}
