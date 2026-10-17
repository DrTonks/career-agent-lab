# 知识视图、长文档和索引恢复

当前实现使用共享语料上的角色授权视图；画像、匹配、路径、报告只能访问各自许可的文档。岗位先按不可变的用户硬条件筛选，未知条件进入独立候选集合，再做 BM25 和语义召回。语义检索只给许可的文档评分；RRF 合并文档级排名，结果保留来源和版本。领域规则属于证据，不是可覆盖系统权限的指令。

## 完整编码与原文定位

本地 BGE-small 中文模型使用 CPU、q8、CLS pooling、归一化与 512 维输出。模型固定到不可变 revision。分块使用该模型实际 tokenizer（包括前缀和特殊 token）计数，每块不超过 512 tokens；编码入口再次检查，超长输入报错。原文按 Unicode 码点边界切分，最多 2,048 码点，相邻块最多重叠 64 码点，短块使用更小重叠；所有原文都被覆盖，保存 UTF-16 起止偏移和文本哈希。

长查询也分块。候选文档的语义分数是其各块与查询各块的最大余弦相似度，每个父文档只参与一次 RRF，避免重复段落累加分数。返回最佳段的位置，工具搜索结果最多提供约 4,000 字符的原文片段，并标注完整性、偏移与原文长度；需要上下文时用 `knowledge_read` 分页读取。片段保留父文档 evidence ID，不能把未读原文当作已核验来源。

这是当前检索策略，不能据此断言相关性最优。最大值聚合可能偏好含单个匹配段的长文档，需要在标注集上评估 Recall@k、MRR/nDCG、尾部条件召回以及最终回答的引用支持。

## 索引格式与中断

v2 manifest 保存语料指纹、模型/revision、前缀、维度、分块策略、文档 ID、块偏移/哈希和向量校验和。按批次缓存，可复用同一配置与语料的成功编码结果；缓存也检查维度、有限值和非零向量。

向量文件以内容哈希命名，先写临时文件再重命名，最后原子替换 manifest。取消构建不发布不完整索引；此前有效的 manifest 保持可用。加载检查模型/语料配置和向量校验和，索引指纹纳入运行恢复条件。v1 截断索引被明确拒绝，需在新目录构建 v2；旧实验索引保留，不覆盖历史快照。实验归档复制 manifest 实际指定的向量文件。

```powershell
npm run cli -- index build --dataset data/synthetic/dataset.json --out data/indexes/synthetic-v2
npm run cli -- run --case evals/examples/full-plan.json --index data/indexes/synthetic-v2 --live
```

首次需要下载模型，缓存位于 `.models/`；已缓存时可设置 `CAREER_EMBEDDING_LOCAL_ONLY=true` 禁止下载。更换模型需指定其不可变 revision，并验证 tokenizer、输出维度和编码配方，不能混用向量。

## 验证和剩余工作

[确定性测试](../../tests/retrieval-memory.test.ts) 使用显式测试编码器验证 Unicode、尾部覆盖、父文档聚合、权限、缓存、取消和损坏检测，不用它宣称真实语义质量。

[本地 ONNX 检查](../../scripts/verify-retrieval.ts) 仅使用缓存模型，不调用聊天供应商：

```powershell
npm run build
node dist/scripts/verify-retrieval.js --out var/validation/NEW_ID
```


索引审计逐块重算tokenizer长度、文本哈希与原文覆盖，并检查零候选、未知条件与来源自检。来源自检不是用户查询的独立相关性标注，不能据此推断混合检索优于BM25。

```powershell
npm run build
node dist/scripts/audit-retrieval.js --dataset data/imported/legacy.json --index data/indexes/legacy-v2 --out var/validation/NEW_ID
```

此审计使用本地模型缓存，无聊天供应商调用。独立检索标注、真实模型读取关键条件的业务验证和端到端语义验收仍未完成。

`jobs_search.categoryCoverage` 在所选类别内给出总语料量、城市匹配量、合格/未知/排除量及逐条件排除计数。它在 top-k 截断前统计，防止将“当前经验不足而被排除”描述成“没有中高级岗位”。原因可以重叠，不可相加当作互斥总数；所选类别的覆盖也不能代表未检索类别或真实市场供给。多轮工程测试覆盖当前 0 年经验排除未来级别、同时保留对应语料计数。

评分规范与知识变更会改变索引指纹。旧索引保留本地追溯用途，新运行需重建并校验编码、来源与知识版本。


固定版本模型缓存完整时（config/tokenizer/tokenizer_config/q8 ONNX 四文件齐全），加载器直接使用该 revision 的本地目录。当前 transformers 4.3.1 的元数据探测会丢失 revision/local_files_only，因此不能仅传参数并假设离线可靠。修订后的实际 ONNX 验证在禁用全部 fetch 时成功、网络尝试为0；仅本地模式缺文件会在加载前报错，不降级到 main。首次联网准备模型仍需要下载，模型配置与维度校验继续执行。

加载修订还与既有合成索引做了实际编码比对：使用原先8条一批的相同批次时，第一条向量余弦约1；单条独立编码余弦约0.9963。q8批次/填充条件会影响数值，不把单条与批次编码强行宣称为逐位一致；两次验证都保留，检索质量仍需独立相关性标注。
