# 项目地图

从[项目首页](../README.md)了解功能，按[运行指南](architecture/runtime-usage.md)使用CLI，再阅读[系统设计](architecture/system-design.md)与[实现边界](development/implementation-status.md)。

~~~text
src/                  总控、专家循环、工具、检索、记忆与持久化
prompts/              总控与四专家的专业指令
knowledge/            领域规则及可引用知识
skills/               同源专业指令的对照实现
data/synthetic/       可公开的合成岗位、类别与路径图
tests/                确定性机制和进程故障测试
scripts/              数据、索引、开发与验证工具
evals/                CLI示例、可复用场景及配置
docs/architecture/    当前机制、设计取舍与使用说明
docs/assets/          公开界面截图与图示；截图来源见 assets/screenshots/README.md
docs/development/     实现边界与开发说明
docs/evaluation/      架构选择、最终结论和统计
.github/workflows/    CI
~~~

本地另有var/、.planning/、历史报告、导入数据与模型缓存，由Git忽略，不属于公开目录。完整记录继续保留，公开仓库不展示逐日工作日志。

## 架构阅读顺序

| 主题 | 文档 |
| --- | --- |
| 总控与四专家 | [系统设计](architecture/system-design.md)、[技术选型](architecture/technology-decisions.md) |
| 通信与依赖 | [动态协调](architecture/dynamic-coordination.md)、[证据授权](architecture/evidence.md) |
| 多轮与记忆 | [用户续接](architecture/follow-up.md)、[原始输入](architecture/input-history.md)、[追问](architecture/clarification.md)、[记忆生命周期](architecture/memory-lifecycle.md) |
| 上下文与检索 | [上下文管理](architecture/context-management.md)、[检索](architecture/retrieval.md) |
| 结果核验与恢复 | [领域校验](architecture/domain-validation.md)、[计算证据](architecture/calculation-evidence.md)、[最终核验](architecture/final-review.md)、[故障恢复](architecture/recovery.md) |
| 开发与使用边界 | [实现状态](development/implementation-status.md)、[开发说明](development/contributing.md)、[测试地图](../tests/README.md) |
| 附带对照结论 | [选择multi-agent的理由](evaluation/multi-agent-rationale.md)、[最终统计](evaluation/results.md) |

## 代码地图

| 文件 | 负责什么 | 建议关注的入口 |
| --- | --- | --- |
| [review-memory-context.ts](../src/review-memory-context.ts) | 从历史模型输入导出候选专属的有效记忆视图；校验身份、范围和时间 | reviewMemoryContexts |
| [contracts.ts](../src/contracts.ts) | 公共类型、Zod schema、计划合法性 | Request、Plan、ExpertResult、Evidence |
| [cli.ts](../src/cli.ts) | JSON CLI、身份与运行操作 | run/reply/resume/approve/inspect |
| [clarification.ts](../src/clarification.ts) | 追问解决状态、原文依据、输入读取回执与版本恢复 | Clarifications |
| [follow-up.ts](../src/follow-up.ts) | 续接输入、父问题快照与角色视图 | followUpInput、continuationContext |
| [conversation-inputs.ts](../src/conversation-inputs.ts) | 授权祖先链的原始用户输入、v1/v2身份验证、只读目录和分页 | conversationInputs、inputHistoryPage、inputHistoryRead |
| [input-history-tools.ts](../src/input-history-tools.ts) | 总控/专家共用的历史工具、各自读取回执与固定/动态状态分离 | InputHistoryTools |
| [runtime.ts](../src/runtime.ts) | 总控图、专家循环、skills 连续上下文、压缩 | plan、expert、graph、execute |
| [planning-progress.ts](../src/planning-progress.ts) | 总控历史读取进度和有界计划收尾 | PlanningProgress |
| [history-read-loop.ts](../src/history-read-loop.ts) | 专家同批历史重读检测、行动反馈与尝试隔离 | historyReadLoop |
| [coordination.ts](../src/coordination.ts) | 协调决策、修订计划和失效传播 | revisePlan、allowedInputs |
| [failures.ts](../src/failures.ts) | 类型化故障、自动重试边界 | RuntimeLimitError、classifyFailure |
| [artifact-reuse.ts](../src/artifact-reuse.ts) | 约束变化时保留可核验画像事实 | profileFacts |
| [tools.ts](../src/tools.ts) | 专家工具权限、业务检查、交接、报告草稿 | DomainTools、validateResult |
| [profile-grounding.ts](../src/profile-grounding.ts) | 零分自述的维度与上下文检查、确认记忆的当前值 | inspectExplicitAbsence、personalContext |
| [evidence.ts](../src/evidence.ts) | 多页已读记录、来源版本一致性、逐字引用验证 | rememberEvidence、supportsQuote |
| [final-review.ts](../src/final-review.ts) | 综合事实清单、抽取契约和一致性比对 | finalFacts、inspectFinal |
| [review-submission.ts](../src/review-submission.ts) | 审阅提交契约、证据片段 ID 与精确原文绑定 | ReviewSubmission、citationCatalog、inspectSubmission |
| [review-plan.ts](../src/review-plan.ts) | 分段选源、跨段关系及有界协议纠正 | planReview、inspectGlobal、validatedReview |
| [assertion-review.ts](../src/assertion-review.ts) | 逐句覆盖、来源资格和澄清/状态分类检查 | reviewUnits、reviewSources、inspectAssertions |
| [review-evidence.ts](../src/review-evidence.ts) | 核验来源目录、有界原文补读与回执身份 | ReviewEvidenceRead、readReviewEvidence、reviewReadRecord |
| [source-fields.ts](../src/source-fields.ts) | 授权JSON字段目录、来源哈希与计算查询范围补读 | structuredSource、fieldRanges |
| [json-locations.ts](../src/json-locations.ts) | 规范JSON的精确键/值UTF-16区间与JSON Pointer | jsonSpans |
| [calculation-review.ts](../src/calculation-review.ts) | 直接检索计数、实际已读计算字段与提交绑定 | countCandidates、calculationFacts、validateCalculationClaims |
| [memory-calculation.ts](../src/memory-calculation.ts) | 记忆计数的角色/查询/分页范围、主体与状态口径 | memoryCalculationScope、countSubject、countToolMatches |
| [capacity.ts](../src/capacity.ts) | 在原运行上限内保留最终阶段容量 | phaseCapacity |
| [storage.ts](../src/storage.ts) | 运行、事件、产物、记忆、租约、约束版本 | Store |
| [checkpointer.ts](../src/checkpointer.ts) | LangGraph 的 SQLite checkpoint 适配 | SqliteSaver |
| [providers.ts](../src/providers.ts) | 流式模型调用与显式回放 | CompatibleProvider、ReplayProvider |
| [provider-request.ts](../src/provider-request.ts) | 无凭证传输计划、DeepSeek 可选严格 schema 投影 | providerRequest、deepseekStrictSchema |
| [stream.ts](../src/stream.ts) | 流式语义片段校验与部分响应重建 | StreamState |
| [data.ts](../src/data.ts) | 数据导入、去重隔离、字段解析 | importLegacy、validateDataset |
| [retrieval.ts](../src/retrieval.ts) | 知识视图、BM25/RRF、硬条件、图路径 | Knowledge、jobConstraintCheck |
| [vectors.ts](../src/vectors.ts) | 本地 embedding、批次缓存、向量索引 | buildIndex、ExactVectors |
| [chunking.ts](../src/chunking.ts) | 按实际 token 计数完整切分并保留原文位置 | chunkText |
| [memory-search.ts](../src/memory-search.ts) | 授权后记忆排名、快照绑定分页与失效值隔离 | searchMemories |
| [config.ts](../src/config.ts) | 本地配置、指纹与输入估计 | config、implementationHash |
| [evaluation.ts](../src/evaluation.ts) | 从执行记录提取非货币指标 | runMetrics |
| [comparison.ts](../src/comparison.ts) | 冻结统一场景/配置/快照，配对调度与中断恢复 | prepareComparison、verifyComparison、executeComparisonUnit |
| [comparison-analysis.ts](../src/comparison-analysis.ts) | 保留失败/缺失分母，逐场景配对资源差 | analyzeComparison |
| [memory-review.ts](../src/memory-review.ts) | 盲评中的候选专属审批记忆历史和快照校验 | memoryReviewTimeline |
| [blind-materials.ts](../src/blind-materials.ts) | 原始记录核对、共同来源、匿名答案与独立映射 | prepareBlindMaterials |
| [blind-conversations.ts](../src/blind-conversations.ts) | 逐轮用户更正、候选专属历史、父子链验证与匿名材料 | prepareConversationMaterials |
| [review-tool-observations.ts](../src/review-tool-observations.ts) | 真实工具参数/结果、执行与缓存身份、评分指针和恢复覆盖 | reviewToolObservations |
| [blind-review.ts](../src/blind-review.ts) | 开发评分锚点、顺序安排、证据绑定与评分契约 | reviewSchedule、validateJudgment |
| [blind-runner.ts](../src/blind-runner.ts) | 独立评审调用、尝试/流持久化、租约恢复与分歧 | BlindRunner |
| [tool-reference.ts](../src/tool-reference.ts) | 提取历史快照中精确工具代码参考，不执行快照代码 | toolReferences |
| [working-set.ts](../src/working-set.ts) | 压缩后保留当前任务的路径/检索计算结果与重读参数 | WorkingSet、workReceipt |
| [calculation.ts](../src/calculation.ts) | 绑定运行/快照的工具计算来源与正文hash | calculationEvidence、parseCalculation |
| [judge-calibration.ts](../src/judge-calibration.ts) | 预先构造评审控制与按原响应核对分析 | calibrationMaterials、analyzeCalibration |
| [human-review.ts](../src/human-review.ts) | 人工材料身份、严格评分校验与按会话配对统计 | humanPacket、validateHumanSubmission、analyzeHuman |
| [human-review-page.ts](../src/human-review-page.ts) | 离线独立会话评分页、备份导入导出 | humanReviewPage |
| [scripts/human-review.ts](../scripts/human-review.ts) | 核对原记录并导出匿名会话；导入单评审者结果 | --experiment / --scores |

模块拆分在后续功能扩展时按真实边界进行，不仅为了目录好看而移动源码。移动源码或改变接口必须更新此表、测试和快照逻辑。



## 文档维护

稳定文档采用描述性kebab-case命名。目录表达主题，文件说明机制和边界；修改接口时同步文档与相关测试。过程记录留本地，公开导航不链接被Git忽略的历史材料。代码中的评估与导出模块保留为可复用开发工具，不因隐藏实验日志而删除。
