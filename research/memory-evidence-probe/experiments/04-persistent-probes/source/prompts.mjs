import {z} from 'zod';
const role=z.enum(['match','path','report']);
const atom=z.union([z.number(),z.boolean()]);
const branch=z.object({assumptions:z.record(z.string(),atom),eligible:z.boolean()}).strict();
export const taskSchema=z.object({key:z.string().min(1),question:z.string().min(1),factKeys:z.array(z.string()).min(1).max(8),targets:z.array(role).min(1).max(3),refs:z.array(z.string()).min(1),branches:z.array(branch).max(2)}).strict();
// A malformed optional question must not suppress a separately valid read request.
const plan=z.object({answer:z.string(),tasks:z.array(z.unknown()).max(3),close:z.array(z.object({key:z.string(),reason:z.string()}).strict()).max(6),readIds:z.array(z.string()).max(1)}).strict();
const decide=z.object({answer:z.string(),value:z.union([z.boolean(),z.enum(['apply','wait','withdraw','none']),z.null()]),refs:z.array(z.string()).min(1)}).strict();
const common='你在虚构职业规划实验中工作，只输出JSON，answer是简短依据说明而非思维过程。facts为当前已见观测；null表示未知，domains是来源允许范围。规则原件见rule.text。旧建议只代表历史。未读目录的标题不等于证据，不能猜正文。可用逻辑判断所有允许情况结论是否一致；一致可确定，否则为null。不得把假设写成真实事实。';
export function messages(stage,p){
 if(stage==='decide')return [{role:'system',content:common+'你只负责target角色，依据真实已见事实与规则输出{answer,value,refs:[原件ID]}。match/report值只能true,false,null；path只能apply,wait,withdraw,none,null。refs必须包括当前规则ID，并引用所用事实来源。三角色按规则独立维护自己的字段。'}, {role:'user',content:JSON.stringify(p)}];
 if(stage!=='plan')throw Error('Unknown stage');
 const method=p.explicitContrast?'对重要建议明确演练两个来源允许、资格结论不同的条件分支。每分支assumptions只填需要改变的未知条件，eligible填假设下资格值；不得改变已确定事实。找不到可信的两个分支时branches=[]，仍可直接提出有价值的取证问题与读取请求。':'直接根据当前建议、规则及缺少的依据决定需要核实什么，可自由推理；不要求列出条件分支，branches固定为[]。';
 const inst='在生成初始建议时，同时提出建议依赖的关键条件或需要复查的问题；后续收到事件时重新判断。输出{answer,tasks:[{key,question,factKeys,targets,refs,branches}],close:[{key,reason}],readIds:[资料ID]}。最多3个问题，factKeys只能引用facts的字段；targets为match,path,report；refs含当前规则ID和已见原件ID。同一问题续办沿用key，改变问题可更新内容。已有问题状态needs-refresh时重新检查适用性；已得到当前有效证据可用evidence-available关闭；规则使问题无关可用rule-replaced或irrelevant关闭。不得把角色已提交答案当作问题已解决。每次最多读取一份资料，也可不读；所有组均可直接读取，不以是否找到分支为前提。读取选择结合当前规则、未知条件、目录作用域和已经读过的资料；版本号只在读取后可见。问题与分支不直接提供给最终决定角色。';
 const {explicitContrast,...payload}=p;
 const format='严格字段类型：tasks中每项必须含key(问题ID字符串)、question(问题文字)、factKeys(非空字段名数组)、targets(非空角色数组)、refs(已见原件ID数组)、branches(数组)。branches只能为[]或恰好两个对象，每个对象格式为{"assumptions":{"months":3},"eligible":false}；这里数值只示意JSON格式，请自己选择来源允许的具体值。assumptions必须是字段到数值/布尔值的对象，禁止字符串数组、不等式文字或null。eligible必须true或false；若尚有其他未定条件使分支结果未知，应补充允许的假设或不列分支。close只针对pendingQuestions中已有的key；reason只能是evidence-available、rule-replaced、irrelevant三个英文值之一，解释写在answer中。没有要关闭的问题时close=[]。refs不可引用未读目录ID；读取请求只放readIds。';
 const effectiveFormat=p.explicitContrast?format:format.replace(/branches只能为.*?close只针对/s,'branches必须是空数组[]，请把证据需求直接写在question中。close只针对');
 return [{role:'system',content:common+method+inst+effectiveFormat},{role:'user',content:JSON.stringify(payload)}];
}
export function parse(stage,text){return (stage==='plan'?plan:decide).parse(JSON.parse(text));}
