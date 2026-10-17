# 追问解决状态与证据

正式 [reply](follow-up.md) 将上一轮问题交给新任务；本模块要求专家明确记录这些问题怎样被本轮输入解决。实现位于 [clarification.ts](../../src/clarification.ts)，通过 DomainTools 的 clarification_update 与 expert_finish 接入两种架构。

## 问题身份与状态

continuation.questions 中每项有稳定 questionId，由冻结续接快照、原位置和问题内容生成。不同领域只能更新自己的问题，其他运行/角色的 ID 被拒绝。旧问题可能包含“尚未提供”这样的历史判断，它不是当前事实。

| 状态 | 含义 | 要求 |
| --- | --- | --- |
| answered | 本次已给出可引用回答 | 非空claims，remaining为空 |
| partial | 复合问题只解决了一部分 | 已知回答与引文，remaining列具体未解决字段 |
| unanswered | 尚未形成可核验回答 | claims为空，保留remaining与原因 |
| conflict | 来源仍有冲突 | 至少两条不同声明及不同引文，保留待澄清项 |
| not_applicable | 当前任务不再需要回答该问题 | claims及remaining为空，说明范围原因 |

例如原问题询问“学校、专业、学历、毕业时间”，当前原文是“本科计算机专业，应届毕业生”，应记录学历/专业/应届身份已知，学校与年月仍待确认。不能因为未给学校而把整个教育背景继续写成缺失。

clarification_update 接受 updates 批次，每项有 questionId、expectedVersion、status、claims、remaining、reason。每条claim包含subject、text及citations（evidenceId与逐字quote）。首次版本为0，后续显式更正使用当前版本。updates=[] 可查看问题、当前记录、输入读取进度和来源矩阵，不修改状态。只在本领域有续接问题时开放该工具，不给每个普通任务无条件增加工具。

## 读取和引用

更新前必须完整读取本轮 request 与 resume。input_read 的实际offset范围与工具结果哈希形成独立回执；画像的 resume_read 可证明完整读取当前简历，空输入也必须实际读取。首尾页不覆盖中间空隙，重复文本不会被当作已读所有位置。进度由实际调用产生，不从模型返回或任意知识对象中的同名字段推断。

`execution-state-v2`的`inputCoverage`区分累计覆盖与页尾：`complete=true`时`nextOffset=null`；未完整读取时返回首个未读缺口。`totalChars`只表示总长度，不能用作继续读取的位置。`input_read`的`containsWholeSource`表示单页是否包含整个输入，`pageEndReached`表示本页到达末尾；到达末尾不等于此前所有位置已读。

非空输入在末尾或越界调用会返回`input_read_at_end`及真实累计覆盖状态，不授予空页引用权限。模型应在完整覆盖后处理追问、评分或结束；有缺口则从缺口续读。空输入仍需一次offset=0读取，完成后不需要继续读取。领域知识分页保留原契约，此变更仅针对当前用户输入。旧任务绑定原实现指纹，不能把新接口直接用于恢复旧版已冻结任务。

续接问题来自全部专家的unknowns，可能询问个人材料、岗位条件或系统状态，不能统一只接受个人来源。v2按每条声明的主体限制来源：

| subject | 可引用的已读来源kind | 示例与边界 |
| --- | --- | --- |
| user | request、resume、memory | 本人经历、偏好；记忆是用户确认的记录，非外部独立证明 |
| domain | job、category、graph、rule、calculation | 岗位双休字段、路径边、检索数量；岗位要求不能证明本人已具备技能 |
| state | artifact、calculation | 画像尚未评估的维度、筛选运行结果；规则只能描述应如何做，不能证明已执行 |

复合回答拆为多条claim并分别引用，不把所有引用与一段混合回答捆绑。明确由collaboration_request产生的user_input问题，已回答/部分回答/冲突状态至少需要一条user声明，领域资料不能独立代替用户回应。代码不能从自由文本自动推断所有unknown问题的主体。

来源错误区分未读（clarification_source_unread）、已读但类型不符（clarification_source_kind）及逐字引用不匹配（clarification_quote_mismatch）。工具事件和Runtime反馈保留questionId、claimIndex、subject、evidenceId、实际已读类型和允许类型；类型不符明确说明重复读取不会改变类型，不诱导模型反复读同一来源。反馈不授予跨角色、跨运行或旧版本访问权限。

状态与版本错误通过同一ClarificationFeedbackError通道返回。反馈定位首个无效条目的updateIndex、questionId、当前可见问题、currentVersion、提交状态及remaining，并给出对应修正说明。applied=[]明确整个批次没有提交，模型可修正该项后重交，或提交其他有效子集；不自动接受部分条目。未知/其他角色的问题不会返回其正文或版本。输入未完整读取时返回coverage，指明续读偏移。

partial且remaining仍为原问题全文会被拒绝；相关工作经历不能自动回答工作形式偏好，受指导行为也不自动回答自主学习问题。真正未回答时使用unanswered、claims=[]，reason说明原因。反馈不建议靠改写措辞来规避检查，也不能自动证明问题在语义上已缩小。30条批次的精确定位、修正提交、幂等、迟到版本和两架构模型消息反馈都有回归用例。

代码核对来源类型与逐字引用，**不证明subject声明正确、引文蕴含回答或问题真正解决**。禁止通过把个人断言标成domain绕过限制，但不能宣称代码已实现通用语义识别；unanswered也不证明全世界不存在该事实。conflict检查两条不同声明/引文的结构，不证明二者语义矛盾。用户明确更正应按新陈述更新，不能仅因历史不同就制造冲突。状态仍需语义审核与独立评审。

## 原子性、恢复与交接

每个执行尝试拥有自己的账本。批次先完整校验，再在同一事务中写入不可变版本、幂等提交回执和事件；一个问题失败时整批不提交。重复旧调用返回当时的 applied 回执和当前最新状态，不把当前记录倒退。重新建立 DomainTools 后读取持久化版本和输入回执，校验记录哈希、输入哈希与续接快照。

正常 expert_finish 必须已登记本领域所有旧问题。运行时把真实账本写入 artifact.clarifications，并把其引用加入发布来源；模型不能直接伪造该字段绕过账本。与已登记问题逐字相同的旧unknowns被其remaining替换，避免机械重复旧问题。全量remaining保存在结构化记录中；顶层unknowns超过30项时给出有数量提示的摘要，不删除账本。

failed结果或collaboration_request让出控制时可以留下未完成问题，记录中保留未评估项；不要求专家在失败或请求其他人协助前假装解决所有问题。新的尝试须重新评估，不沿用失效尝试的判断。跨专家通过正常产物交接读解决记录，再读取其发布来源；这些记录不是长期记忆，也不授予领域外知识权限。

持久化记录携带schemaVersion=clarification-v2，仅保存claims，不再重复保存派生的answer和顶层citations。v1封存记录保留原貌，不自动改写为v2，不接受旧平面输入字段。源码/提示词指纹已变化的历史任务不能原地恢复；要测试新契约须创建新任务。已有续接、输入版本、事务及幂等边界不变。

该机制只自动替换逐字相同的旧unknown标签，不会理解所有自由文本中的同义矛盾。旧questions与新答案的语义匹配、范围判断、引用支持程度仍可能出错；例如模型可以把已给出的事实误标unanswered，或在facts自由字段写出矛盾内容。必须用真实业务记录检查，不能把完成登记当作事实正确。

## 验证

`artifact.openQuestions`（`open-questions-v1`）：运行时从问题账本和本轮新未知项生成全量未解决列表，覆盖模型提交的同名元数据。顶层 `result.unknowns` 仍可保留 30 项摘要，但新续接通过 `complete-open-questions-v1` 读取全量列表，避免第 31 项以后在下一轮丢失。只在同一产物内合并空白等价文本，不合并不同专家的问题或语义相似但责任不同的问题。

新 continuation 记录 `questionPolicy`；历史未记录该策略的 v2 续接按 legacy 解释，避免改变旧请求哈希。`open-questions.test.ts` 验证 40 个问题经 4 次续接仍完整、无机械累加，以及模型伪造元数据不能删掉运行时问题。它不证明模型识别了所有同义问题，也不解决一般语义循环。

[clarification.test.ts](../../tests/clarification.test.ts)检查复合问题、实际读取空隙、来源/角色/状态限制、批次原子性、版本更正与旧调用重试、重建及篡改拒绝。两个实际子进程分别在账本提交前后被终止，恢复后保持一个版本和一条更新事件；该故障用例使用真实DomainTools与SQLite，不声称同时验证了模型语义。两架构Runtime与CLI回归见[follow-up.test.ts](../../tests/follow-up.test.ts)。

[clarification-subjects.test.ts](../../tests/clarification-subjects.test.ts)覆盖四角色规则来源、混合用户/岗位/计算/产物声明、错误类型/未读/错引文的反馈与整批拒绝、发布来源下游仍需实际读取、用户问题与冲突结构，以及两架构完整Runtime收到反馈后重新提交。回放验证控制流程，不作为模型质量评分。
