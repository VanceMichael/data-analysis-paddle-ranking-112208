# 赛事易组时的资格积分和递补核算

成绩以秒计，赛站与名额使用合成赛季规则。entry 标识一次有效参赛，艇组成员均为稳定选手号。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

年龄组实际变更以确认的裁判复议为准。有效站数按项目计算，以赛季最优站积分合计；总决赛同一时间段不可同时确认两项。已有锁定邀约在保护期内，已确认的取消资格需重查锁定资格的有效依据。

- `entries.json` 记录字段为 `entry`、`meet`、`race`、`age_group`、`boat`、`members`、`sec`、`adjudication`、`rev`。
- `rules.json` 记录字段为 `race`、`age_group`、`medal_points`、`valid_meets`、`quota`、`slot`、`reserve`。
- `offers.json` 记录字段为 `invitation`、`race`、`members`、`state`、`protection`。
- `replacements.json` 记录字段为 `boat`、`member`、`candidate`、`eligible`。
- `quota_rules.json` 记录字段为 `race`、`age_group`、`best_meets`、`tie`、`conflict`、`proof_period`。
- `appeals.json` 记录字段为 `entry`、`requested_group`、`confirmed`、`version`。
- `roster.json` 记录字段为 `athlete`、`club`、`age_group`、`entrance`。
- `replies.json` 记录字段为 `invitation`、`athlete`、`at`、`reply`。
- `agenda.json` 记录字段为 `version`、`race`、`slot`、`start`、`end`、`state`。
- `roster_terms.json` 记录字段为 `race`、`suitable_meets`、`acceptance`、`substitute_policy`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
