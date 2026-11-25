import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadDataset } from '../src/load-data.js'
import { analyzeDataset } from '../src/engine.js'
import { rankMeetResults, buildSeasonStandings } from '../src/rankings.js'

const db = await loadDataset()
const result = analyzeDataset(db)

test('当前修订按确认复议改组，并且合组物理名次与年龄组名次分开', () => {
  const m1 = result.rankings.filter((r) => r.meet === 'M1' && r.race === 'R1')
  const e2 = m1.find((r) => r.entry === 'E2')
  assert.equal(e2.physicalRank, 3)
  assert.equal(e2.rank, 2)
  assert.equal(e2.points, 7)
  assert.equal(e2.mergedPhysicalRankMismatch, true)

  const e3 = m1.find((r) => r.entry === 'E3')
  assert.equal(e3.effectiveAgeGroup, 'U14')
  assert.equal(e3.rank, 1)
  assert.equal(e3.points, 10)

  const e1 = m1.find((r) => r.entry === 'E1')
  assert.equal(e1.valid, false)
  assert.equal(e1.invalidReason, '裁判取消资格')
  assert.equal(e1.physicalRank, 2)
})

test('revision=1 可重现送达时的旧成绩和旧组属', () => {
  const oldRanked = rankMeetResults(db, { revision: 1 })
  const oldM1 = oldRanked.filter((r) => r.meet === 'M1' && r.race === 'R1')
  const oldE1 = oldM1.find((r) => r.entry === 'E1')
  const oldE3 = oldM1.find((r) => r.entry === 'E3')
  assert.equal(oldE1.valid, true)
  assert.equal(oldE1.rank, 1)
  assert.equal(oldE1.points, 10)
  assert.equal(oldE3.effectiveAgeGroup, 'U16')
  assert.equal(oldE3.rank, 1)

  const oldStandings = buildSeasonStandings(db, { revision: 1, ranked: oldRanked })
  const ab = oldStandings.find((s) => s.race === 'R1' && s.crew === 'A+B')
  assert.equal(ab.total, 17) // 旧 M1 10 + 两个 7 中最优一站 = 17
})

test('并列成绩使用并列顺延名次积分', () => {
  const tied = result.rankings.filter((r) => r.meet === 'M2' && r.race === 'R1' && r.sec === '131')
  assert.equal(tied.length, 2)
  assert.deepEqual(tied.map((r) => r.rank).sort(), [2, 2])
  assert.deepEqual(tied.map((r) => r.points).sort(), [7, 7])
})

test('多站最优积分与有效站门槛分别计算', () => {
  const cd = result.standings.find((s) => s.race === 'R1' && s.crew === 'C+D')
  assert.equal(cd.seasonRank, 1)
  assert.equal(cd.total, 20)
  assert.equal(cd.validMeetCount, 3)
  assert.equal(cd.requiredValidMeets, 2)

  const ab = result.standings.find((s) => s.race === 'R1' && s.crew === 'A+B')
  assert.equal(ab.total, 14)
  assert.equal(ab.validMeetCount, 2)
  assert.equal(ab.meetsRequirement, true)

  const a = result.standings.find((s) => s.race === 'R2' && s.crew === 'A')
  assert.equal(a.total, 18)
  assert.equal(a.bestMeets, 2)
  assert.equal(a.requiredValidMeets, 1)

  const c = result.standings.find((s) => s.race === 'R2' && s.crew === 'C')
  assert.equal(c.total, 9)
  assert.equal(c.validMeetCount, 1)
})

test('转组核查同时给出原组、转入组有效站和组合依据', () => {
  const e3 = result.transferAudits.find((t) => t.entry === 'E3')
  assert.equal(e3.originalGroup, 'U16')
  assert.equal(e3.targetGroup, 'U14')
  assert.equal(e3.originalMeetsRequirement, true)
  assert.equal(e3.targetMeetsRequirement, false)
  assert.equal(e3.crossMeetCombinationLegal, true)
  assert.equal(e3.finalsGroupEligible, false)
})

test('锁定邀约在部分成绩取消后仍可因剩余有效站成立而保留', () => {
  const i1 = result.invitations.find((i) => i.invitation === 'I1')
  assert.equal(i1.responseStatus, 'accepted')
  assert.equal(i1.locked, true)
  assert.equal(i1.basisStatus, 'corrected')
  assert.equal(i1.basis.meetsRequirement, true)
  assert.equal(i1.disposition, 'confirmed_protected_other_blocked')
})

test('改时后 A 的艇/个人和 C 的个人/候补均被识别为冲突，但不自动撤销', () => {
  const i1 = result.invitations.find((i) => i.invitation === 'I1')
  const i2 = result.invitations.find((i) => i.invitation === 'I2')
  const i3 = result.invitations.find((i) => i.invitation === 'I3')
  const i4 = result.invitations.find((i) => i.invitation === 'I4')

  assert.equal(i1.conflicts.some((c) => c.withInvitation === 'I2'), true)
  assert.equal(i2.conflicts.some((c) => c.withInvitation === 'I1'), true)
  assert.equal(i3.conflicts.some((c) => c.withInvitation === 'I4'), true)
  assert.equal(i4.conflicts.some((c) => c.withInvitation === 'I3'), true)
  assert.ok(i1.conflicts[0].preserveConfirmations)
  assert.equal(i1.conflicts[0].previouslyCompatible, true)

  const oldAgenda = analyzeDataset(db, { agendaVersion: 1 })
  const oldI1 = oldAgenda.invitations.find((i) => i.invitation === 'I1')
  assert.equal(oldI1.conflicts.filter((c) => c.active).length, 0)
})

test('答复时间决定部分接受状态和 24 个时间单位的保留窗口', () => {
  const at24 = analyzeDataset(db, { at: 24 })
  const i5At24 = at24.invitations.find((i) => i.invitation === 'I5')
  assert.equal(i5At24.responseStatus, 'pending')

  const at25 = analyzeDataset(db, { at: 25 })
  const i5At25 = at25.invitations.find((i) => i.invitation === 'I5')
  assert.equal(i5At25.responseStatus, 'partial')
  assert.equal(i5At25.responseDeadline, 48)

  const i5 = result.invitations.find((i) => i.invitation === 'I5')
  assert.equal(i5.responseStatus, 'declined')
  assert.equal(i5.ordinaryDecline, true)
  assert.equal(i5.retentionWindowOpen, true)
})

test('替补名单、同艇/确认名单依据和候选人双重保护同时核查', () => {
  const b1 = result.replacements.find((r) => r.boat === 'B1')
  assert.equal(b1.ruleApproved, false)

  const b5 = result.replacements.find((r) => r.boat === 'B5')
  assert.equal(b5.ruleApproved, true)
  assert.equal(b5.candidateHasProtection, true)
  assert.match(b5.recommendation, /必须先征询/)
  assert.equal(b5.candidateProtections[0].invitation, 'I5')
})

test('普通拒绝不删除成绩；候补确定依赖名额释放和冲突选择', () => {
  const wait = result.waitlists.find((w) => w.invitation === 'I3')
  assert.equal(wait.effectiveRank, 1)
  assert.equal(wait.fixedDeterminationTime, null)
  assert.ok(wait.conditions.some((c) => c.includes('I1')))
  assert.ok(wait.conditions.some((c) => c.includes('I4')))
})

test('会员按当时代表关系计入俱乐部，决赛按当前俱乐部审查', () => {
  const k1R1 = result.clubStandings.totals.find((t) => t.club === 'K1' && t.race === 'R1')
  assert.equal(k1R1.total, 14) // M1 的 10 分因 E1 取消而消失
  const k2R1 = result.clubStandings.totals.find((t) => t.club === 'K2' && t.race === 'R1')
  assert.equal(k2R1.total, 27) // 分站分口径；M2 G+H 受 scoring_slots=1 限制不计
  assert.equal(result.bonusAudit.allocations.some((a) => a.invitation === 'I1' && a.club === 'K2'), true)
  assert.equal(result.bonusAudit.allocations.some((a) => a.invitation === 'I1' && a.club === 'K1'), true)
})

test('已送达 T1 可用 revision=1 重现，且保留旧榜次与更正范围', () => {
  const t1 = result.issuedTables.find((t) => t.table === 'T1')
  assert.equal(t1.reproductionHash.length, 16)
  assert.equal(t1.correctionScope.publishedClubTotal, 24)
  assert.equal(t1.correctionScope.currentClubTotal, 14)
  assert.ok(t1.correctionScope.correctedEntries.some((e) => e.entry === 'E1' && e.affectsPublishedClub))
  assert.ok(t1.correctionScope.rankingCorrections.every((c) => c.issuedRankRemainsOnDeliveredTable))
})

test('并列均分规则会平均对应名次积分并向零截位', () => {
  const tieDb = structuredClone(db)
  tieDb.quota_rules.find((r) => r.race === 'R1' && r.age_group === 'U14').tie = '并列均分'
  for (const entry of tieDb.entries) {
    if (['E1', 'E2', 'E3'].includes(entry.entry) && entry.rev === '2' && entry.entry === 'E1') {
      entry.adjudication = '有效'
    }
    if (['E1', 'E2', 'E3'].includes(entry.entry) && entry.rev === '1') entry.sec = '130'
    if (entry.entry === 'E1' && entry.rev === '2') {
      entry.sec = '130'
      entry.adjudication = '有效'
    }
    if (entry.entry === 'E3' && entry.rev === '2') entry.sec = '130'
  }
  const tieResult = analyzeDataset(tieDb)
  const m1 = tieResult.rankings.filter((r) => r.meet === 'M1' && r.race === 'R1' && r.effectiveAgeGroup === 'U14')
  assert.equal(m1.length, 3)
  assert.deepEqual(m1.map((r) => r.points), [7, 7, 7]) // (10+7+5)/3 = 7.333 -> 7
  assert.equal(m1[0].truncatedSharedPoints, 7)
})

test('改判影响整艇所有稳定选手，并保留逐人积分变化', () => {
  const e1Impact = result.correctionImpacts.find((x) => x.entry === 'E1')
  assert.deepEqual(e1Impact.affectedAthletes, ['A', 'B'])
  assert.equal(e1Impact.before.points, 10)
  assert.equal(e1Impact.after.valid, false)
  assert.deepEqual(e1Impact.teammateScoreEffect.map((x) => x.scoreDelta), [-3, -3])
})

test('未确认复议时受影响席位暂挂且年龄组沿用原组', () => {
  const pendingDb = structuredClone(db)
  pendingDb.appeals.find((a) => a.entry === 'E3').confirmed = 'pending'
  const pending = analyzeDataset(pendingDb)
  const e3 = pending.rankings.find((r) => r.entry === 'E3')
  assert.equal(e3.effectiveAgeGroup, 'U16')
  assert.ok(pending.holds.some((h) => h.type === 'appeal' && h.status === '暂挂'))
})

test('有效站门槛提高会把已接受邀约送入撤销审查', () => {
  const strictDb = structuredClone(db)
  strictDb.rules.find((r) => r.race === 'R1' && r.age_group === 'U14').valid_meets = '3'
  const strict = analyzeDataset(strictDb)
  const i1 = strict.invitations.find((i) => i.invitation === 'I1')
  assert.equal(i1.basisStatus, 'invalid')
  assert.equal(i1.disposition, 'basis_revocation_review')
})

test('接受时间与资格释放会共同改变候补是否可接到邀约', () => {
  const releasedDb = structuredClone(db)
  releasedDb.replies.push(
    { invitation: 'I4', athlete: 'C', at: '30', reply: '释放' },
    { invitation: 'I1', athlete: 'A', at: '49', reply: '释放' },
    { invitation: 'I1', athlete: 'B', at: '49', reply: '释放' },
  )
  const after = analyzeDataset(releasedDb, { at: 49 })
  const i3 = after.invitations.find((i) => i.invitation === 'I3')
  const wait = after.waitlists.find((w) => w.invitation === 'I3')
  assert.equal(i3.conflicts.filter((c) => c.active).length, 0)
  assert.equal(after.quotaLedger.find((l) => l.race === 'R1' && l.ageGroup === 'U14').freeConfirmedSlots, 1)
  assert.equal(i3.disposition, 'waitlist_ready_when_quota_opens')
  assert.equal(wait.conditions.some((c) => c.includes('I4')), false)
})
