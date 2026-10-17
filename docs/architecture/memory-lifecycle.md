# 记忆生命周期、审批和进程恢复

本文对应当前 CLI 实现。工作上下文与 checkpoint 属于执行记忆，跨任务事实进入按用户/领域分区的长期记忆，后者通过版本、来源、人工审批和撤回管理。

## 事实、版本和撤回

主键是 `(userId, namespace, key)`，namespace 为 shared 或四专家之一。批准写入、用户纠正和撤回都使 version 加一；调用方提供 expectedVersion，冲突时整个批次回滚。pending 提议不改变已确认事实。active 事实可以按权限读取；expired 和 retracted 不进入事实召回，但版本仍存在。撤回保留墓碑，旧提议不能将其当作首次写入复活。superseded 提议已因上游修复或用户纠正失效，不可提交。

`memory_recall` 返回有效事实及版本头，读取后产生 `memory:<namespace>:<key>:v<version>` 证据。这表示用户确认的信息，不能冒充外部独立核验。未实际读取的记忆不能作为引用；领域权限与普通交接一致。

模型使用 `memory_propose` 提议 upsert 或 retract，两者均须来源和人工批准。用户通过 CLI 显式纠正/撤回，无需模型批准。`memory_history` 保留变更来源与版本；旧数据库迁移仅导入现存版本，注明缺失历史，不补造记录。

## CLI 操作

任务上下文从当前角色可见的全部有效记忆做 BM25 召回，默认最多 8 条；无命中时回退到最近 8 条。查询不是只在最近 40 条中搜索。`memory_recall` 支持 query、limit（1–20）和 nextCursor 分页；游标绑定用户、角色、查询、版本快照和失效状态，任何变化都需重新查询。includeInactive=true 可读过期/撤回版本头，但不返回旧值或旧证据，也不让旧值影响排名。检索是词法匹配，尚未证明长程语义召回质量。

先查询版本：

```powershell
npm run cli -- memory --user alice
npm run cli -- memory history --user alice
npm run cli -- memory search --user alice --role match --query 城市 --limit 8
# 继续翻页时保持相同 query 和 --inactive 设置，添加 --cursor 上次返回的nextCursor
npm run cli -- memory search --user alice --role match --inactive
```

将操作保存为本地 JSON，例如 `var/city-correction.json`：

```json
{
  "operation": "correct",
  "operationId": "city-correction-001",
  "namespace": "shared",
  "key": "city",
  "expectedVersion": 1,
  "value": "成都",
  "reason": "用户更正希望工作的城市"
}
```

```powershell
npm run cli -- memory change --user alice --case var/city-correction.json
```

撤回使用 operation=`retract`，省略 value，提供最新 expectedVersion 和新的 operationId。同一 ID、相同内容可安全重试；复用 ID 修改内容会被拒绝。纠正只针对已有键；初次记忆通过带来源的提议和审批建立。user 参数是本地 CLI 身份选择，不是远程认证；含个人信息的 JSON 应放在忽略目录。

## 防止旧上下文复活

运行记录启动时的记忆版本快照。用户纠正/撤回使该用户未结束的运行失效，撤销其待审批提议；未来运行不复用快照不匹配的旧产物。简历变化也会阻止旧成功产物复用。过期跨越在下一次检查时使旧上下文失效。

当前采用保守的用户级失效，不猜测自然语言结论是否与修改无关。新请求读取新的有效记忆。批准本次产物和提议时，同一事务更新该运行的快照，允许已审阅结果继续完成。

撤回是语义失效，审计历史仍保留。`forget --user alice --confirm` 清除当前运行数据库内该用户的事实、历史、幂等记录、运行、产物、事件和 checkpoint；仍持有有效租约时需等待执行退出。独立归档文件不属于该命令的删除范围，数据库删除不能描述为全盘擦除。

## 固定审批与恢复

准备审批时保存当前产物、提议、约束版本和记忆快照的哈希，生成固定 approvalId。对象变化拒绝旧审批，不能悄悄加入未审阅的新提议。提议来源必须是当前有效尝试，失败或失效尝试不可提交事实。

决策回执、记忆批次、提议状态和事件在一个 SQLite 事务中提交。事务后、根图 checkpoint 前退出，恢复读取既有回执，不重复审批或递增版本。事务前退出则没有提交证据，需要显式提供审批决定。相同决定可幂等返回，相反决定不能覆盖回执。

默认租约有效期 5 秒，每 250 毫秒续期。进程突然退出后，过期即可接管；运行状态、产物和 checkpoint 写入校验所有权，旧执行者不能覆盖接管者结果。恢复仍检查代码、提示词、模型、知识和检索指纹。取消、记忆变化或失去租约会拒绝迟到结果；已经收到的模型响应和 usage 保留为审计数据，不因结果被拒绝而删除。

## 验证边界

`tests/memory.test.ts` 覆盖版本冲突、事务回滚、幂等、纠正/撤回、权限、过期和固定审批回执。`tests/process.test.ts` 在独立 Node 子进程内于审批事务前/后实际 SIGKILL，验证恢复只提交一版记忆；另测并发租约与旧所有者写入拦截。全部使用显式模型回放，不调用供应商。

进程测试还覆盖两种架构在专家完成后、产物保存前/后的实际 SIGKILL：恢复从已完成专家 checkpoint 或持久产物继续，模型调用次数不增加，待审批提议仅一条且未写成长期事实。

沙箱可能以 EPERM 禁止子进程启动，需要在允许本地子进程的环境运行完整 `npm run check`；不能跳过后声称通过。当前尚未覆盖全部模型、工具、checkpoint 故障窗口，也未证明真实模型长期记忆的语义质量，G2 仍需扩展矩阵和多轮业务验收。

完整响应保存、提议提交、工具缓存前后的两架构真实退出矩阵现已补充；具体恢复行为与未知外部结果边界见 [执行恢复](recovery.md)。

当前请求原话可以通过 input_read（source=request）成为带 run ID 和文本哈希的已读证据，供 memory_propose 引用。即使用户原话含“请记住”，调用仍只生成待审批提议，不代替 CLI 的明确批准。两架构均有真实运行时回放验证；审批来源不等于对所有提议语义的独立验证。
