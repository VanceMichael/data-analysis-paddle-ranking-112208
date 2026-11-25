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
- `affiliations.json` 记录字段为 `athlete`、`club`、`from_meet`、`to_meet`。
- `club_limits.json` 记录字段为 `club`、`race`、`scoring_slots`、`final_bonus_limit`。
- `issued_tables.json` 记录字段为 `table`、`club`、`race`、`revision`、`delivery_at`、`state`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。

## 核算引擎

无第三方依赖，入口为 `src/engine.js`，库出口为根目录 `index.js`。

```sh
npm run report                 # 中文文本核查报告
npm run json                   # 完整结构化结果
node src/cli.js rankings --revision=1
node src/cli.js invitations I3
node src/cli.js waitlist I3
node src/cli.js athlete A
node src/cli.js tables T1
node src/cli.js validate
```

也可以在代码中使用：

```js
import { loadDataset, analyzeDataset } from './index.js'

const db = await loadDataset()
const result = analyzeDataset(db, { at: 26, agendaVersion: 2 })
```

`analyzeDataset` 返回有效分站排名、赛季积分、转组核查、邀约状态、时间冲突、名额台账、
替补审查、候补确定条件、运动员个人视图、俱乐部积分/决赛名额、暂挂账项和已送达榜表快照。

### 核算口径

- 同一 `entry` 取不超过 `revision` 的最高 `rev`；当前分析取最新修订，已送达的 `T1/T2/T3`
  用各自的 `revision=1` 重现。
- `confirmed:"true"` 的复议才改变年龄组；未确认的“归属修正”沿用前一修订的组属并暂挂席位。
- 合组出发只按 `meet + race` 计算物理名次；计奖排名按有效成绩在
  `meet + race + effectiveAgeGroup` 内重排。因此 `E2` 的合组物理名次为第 3，
  本年龄组有效名次为第 2。
- `取消资格`、`未出发`、`终点未到` 均不计有效成绩；普通拒绝/释放不删除比赛成绩，
  只改变邀约和递补状态。
- `rules.valid_meets` 是有效站门槛，`quota_rules.best_meets` 是积分合计时选取的最优站数，
  两者分开计算。
- `tie:"并列顺延"` 使用竞赛排名；并列记录同时给出 `truncatedSharedPoints`，
  供赛季规则要求“并列名次积分平均后截位”时切换/复核。
- `proof_period` 是答复/证明保留时长。由于 `offers.json` 没有单独发邀时间，
  CLI 暂以已送达榜表的最早 `delivery_at=24` 为通知锚点；接入真实数据时应传入
  `analyzeDataset(db, { noticeAt: <实际发邀时间> })`。
- 会员在某站按 `affiliations` 中覆盖该站的代表关系计数；决赛资格按 `决赛`
  所属俱乐部审查。混合俱乐部艇的成绩会分别追溯到成员当时所在俱乐部，
  再应用该俱乐部的 `scoring_slots`。
- `clubStandings.totals` 是分站积分并在每站应用名额上限的口径；
  `clubStandings.seasonTotals` 是按赛季艇组候选应用 `scoring_slots`
  并取最优站积分的口径。
- 俱乐部 `final_bonus_limit` 只限制团体积分/奖励账项，不自动撤销运动员个人邀约；
  可能超额时放入 `holds` 或 `contingentClubLimits`。

## 当前合成资料的关键结论

- `C+D`（I3）当前 R1/U14 榜次第 1，20 分、3 个有效站；但 I1 是已接受锁定席位，
  且 C 已接受 R2 的 I4。R2 改到 R1/S1 时间后，I3 必须等待 I1 释放/失效并完成 C 的冲突选择。
- `A+B` 的 M1 `E1` 已在 rev2 取消资格，但 M2/M3 仍有两个有效站，故 I1 的锁定依据经重查后
  仍有可确认部分；被取消的是 E1/该站 10 分，而不是剩余两站。
- A 的 R2 个人资格当前 18 分、榜次第 1；改时后与 I1 冲突。I4/C 为已接受锁定，
  系统保留双方记录并要求征询，不自动二选一。
- I5 中 G 已接受、H 普通拒绝；R1 标准保留窗口为 24 个时间单位（锚点 24 时截止 t=48）。
  普通拒绝不影响 G+H 的比赛成绩，但原艇已不能全员接受。
- `B5/D→G` 在确认替补名单中为 `eligible:true`，组合依据成立；但 G 有 I5 保护/已接受部分，
  必须先征询。`B1/B→F` 为 `false`，不能生效。
- `E3` 已确认由 U16 转入 U14，原组 1 站满足 U16 要求，但转入 U14 只有 1 个有效站、
  未达到 2 站门槛。
- T1 可用 rev1 重现：K1/R1 旧口径为 24 分，当前重算为 14 分；已送达榜次不覆盖，
  更正范围限定在后续修订及关联账项。

## 复用到新赛季

替换 `data/` 中同名 JSON 即可；若新增状态文案，优先在 `src/rankings.js`
和 `src/invitations.js` 的状态分类函数中补充同义词。规则、名额、期限和俱乐部上限
均从数据表读取，核心核算不写死选手号。
