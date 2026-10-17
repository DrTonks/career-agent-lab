# 数据目录

`synthetic/dataset.json` 是可公开的合成样本；不是实际招聘数据。生成入口为 `npm run synthetic`，也会更新同源技能文件和示例输入。

`imported/` 保存本地原数据导入结果、审计和冲突隔离；`indexes/` 保存 embedding 批次、向量与 manifest。二者均被 Git 忽略，不能因为目录被忽略就删除研究所需的来源快照。

数据解析与校验：[data.ts](../src/data.ts)。知识权限和检索：[retrieval.ts](../src/retrieval.ts)。索引构建：[vectors.ts](../src/vectors.ts)。运行示例见 [README](../README.md)，归档见 [开发说明](../docs/development/contributing.md)。

新增数据需说明来源、授权、版本、字段含义、未知值和冲突规则。正式评估冻结数据与图快照；改变索引模型、前缀或数据后必须重建并产生新指纹，不能混用旧向量。
