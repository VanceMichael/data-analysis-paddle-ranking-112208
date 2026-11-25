import {
  crewKey,
  groupBy,
  parseBool,
  parseNumber,
  previousRevision,
  selectRevision,
  stableSort,
} from './util.js'

export const VALID_ADJUDICATIONS = new Set(['有效', '合组计时', '归属修正'])
export const DNS = '未出发'
export const DNF = '终点未到'

export function appealState(row) {
  if (!row) return '无复议'
  if (row.confirmed === 'true' || parseBool(row.confirmed) === true) return '已确认'
  if (row.confirmed === 'pending' || row.confirmed === '待核实' || row.confirmed === '待确认') {
    return '待核实'
  }
  return '未确认'
}

export function latestAppealFor(appeals, entryId, revision = Number.POSITIVE_INFINITY) {
  return (appeals ?? [])
    .filter((appeal) => appeal.entry === entryId && (parseNumber(appeal.version) ?? 1) <= revision)
    .sort((a, b) => (parseNumber(b.version) ?? 0) - (parseNumber(a.version) ?? 0))[0]
}

export function resolveEntries(db, options = {}) {
  const revision = options.revision ?? Number.POSITIVE_INFINITY
  const applyAppeals = options.applyAppeals ?? true
  const selected = selectRevision(db.entries ?? [], revision)

  return selected.map((row) => {
    const rev = parseNumber(row.rev) ?? 1
    const history = db.entries ?? []
    const prior = previousRevision(history, row.entry, rev)
    const appeal = latestAppealFor(db.appeals, row.entry, revision)
    const state = appealState(appeal)
    const confirmedAppeal = applyAppeals && state === '已确认' ? appeal : null

    let effectiveAgeGroup = row.age_group
    let groupBasis = '记录年龄组'
    if (confirmedAppeal) {
      effectiveAgeGroup = confirmedAppeal.requested_group
      groupBasis = '确认复议'
    } else if (row.adjudication === '归属修正' && prior) {
      // A correction does not change the legal age group until its appeal is confirmed.
      effectiveAgeGroup = prior.age_group
      groupBasis = '修正待复议，沿用原组'
    }

    let valid = VALID_ADJUDICATIONS.has(row.adjudication)
    let invalidReason = null
    if (row.adjudication.includes('取消')) {
      valid = false
      invalidReason = '裁判取消资格'
    } else if (row.adjudication.includes('未出发') || row.adjudication.includes('DNS')) {
      valid = false
      invalidReason = '未出发'
    } else if (row.adjudication.includes('终点未到') || row.adjudication.includes('未完赛') || row.adjudication.includes('DNF')) {
      valid = false
      invalidReason = '终点未到'
    } else if (parseNumber(row.sec) === null && valid) {
      valid = false
      invalidReason = '缺少有效计时'
    }

    return {
      ...row,
      revNumber: rev,
      secNumber: parseNumber(row.sec),
      memberIds: row.members.split('+'),
      crew: crewKey(row.members),
      effectiveAgeGroup,
      groupBasis,
      appealState: state,
      appeal,
      valid,
      invalidReason,
    }
  })
}

function ruleFor(rules, race, ageGroup) {
  return (rules ?? []).find((rule) => rule.race === race && rule.age_group === ageGroup)
}

function quotaRuleFor(quotaRules, race, ageGroup) {
  return (quotaRules ?? []).find((rule) => rule.race === race && rule.age_group === ageGroup)
}

function pointsTable(rule) {
  return String(rule?.medal_points ?? '')
    .split('+')
    .map((n) => parseNumber(n) ?? 0)
}

function assignPhysicalRanks(resolved) {
  const groups = groupBy(resolved, (row) => `${row.meet}\u0000${row.race}`)
  const ranks = new Map()
  for (const rows of groups.values()) {
    const timed = stableSort(
      rows.filter((row) => row.secNumber !== null),
      (a, b) => a.secNumber - b.secNumber,
    )
    let lastTime = null
    let lastRank = 0
    timed.forEach((row, index) => {
      let rank = index + 1
      if (index > 0 && row.secNumber === lastTime) rank = lastRank
      ranks.set(row.entry, rank)
      lastTime = row.secNumber
      lastRank = rank
    })
  }
  return ranks
}

/**
 * Rerank each meet/race/effective age group from valid results.
 * Merged starts are physically ordered together but awarded separately.
 */
export function rankMeetResults(db, options = {}) {
  const resolved = resolveEntries(db, options)
  const physicalRanks = assignPhysicalRanks(resolved)
  const groups = groupBy(
    resolved,
    (row) => `${row.meet}\u0000${row.race}\u0000${row.effectiveAgeGroup}`,
  )
  const ranked = []

  for (const rows of groups.values()) {
    const sample = rows[0]
    const rule = ruleFor(db.rules, sample.race, sample.effectiveAgeGroup)
    const quotaRule = quotaRuleFor(db.quota_rules, sample.race, sample.effectiveAgeGroup)
    const tiePolicy = quotaRule?.tie ?? '并列顺延'
    const table = pointsTable(rule)
    const valid = stableSort(
      rows.filter((row) => row.valid),
      (a, b) => a.secNumber - b.secNumber || a.entry.localeCompare(b.entry),
    )

    let index = 0
    while (index < valid.length) {
      let end = index + 1
      while (end < valid.length && valid[end].secNumber === valid[index].secNumber) end++
      const tieSize = end - index
      const competitionRank = index + 1
      const tiedPointValues = table.slice(index, end)
      const averagedPoints =
        tieSize > 1 ? Math.trunc(tiedPointValues.reduce((sum, n) => sum + n, 0) / tieSize) : null

      for (let i = index; i < end; i++) {
        const row = valid[i]
        let points = table[competitionRank - 1] ?? 0
        let pointBasis = `第${competitionRank}名积分`
        if (tieSize > 1 && (tiePolicy.includes('均分') || tiePolicy.includes('平均'))) {
          points = averagedPoints
          pointBasis = `并列${competitionRank}名，${tiedPointValues.join('+')}均分后截位`
        } else if (tieSize > 1) {
          pointBasis = `并列第${competitionRank}名，按${tiePolicy}使用该名次积分；均分截位备选值 ${averagedPoints}`
        }

        ranked.push({
          ...row,
          rank: competitionRank,
          tieSize,
          points,
          truncatedSharedPoints: averagedPoints,
          pointBasis,
          physicalRank: physicalRanks.get(row.entry) ?? null,
          ageGroupRank: competitionRank,
          mergedPhysicalRankMismatch:
            physicalRanks.has(row.entry) && physicalRanks.get(row.entry) !== competitionRank,
        })
      }
      index = end
    }

    for (const row of rows.filter((row) => !row.valid)) {
      ranked.push({
        ...row,
        rank: null,
        tieSize: 0,
        points: 0,
        truncatedSharedPoints: null,
        pointBasis: row.invalidReason,
        physicalRank: physicalRanks.get(row.entry) ?? null,
        ageGroupRank: null,
        mergedPhysicalRankMismatch: false,
      })
    }
  }

  return stableSort(
    ranked,
    (a, b) =>
      a.meet.localeCompare(b.meet) ||
      a.race.localeCompare(b.race) ||
      a.effectiveAgeGroup.localeCompare(b.effectiveAgeGroup) ||
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      a.entry.localeCompare(b.entry),
  )
}

function compareStandings(a, b) {
  return (
    b.total - a.total ||
    b.validMeetCount - a.validMeetCount ||
    b.bestSingle - a.bestSingle ||
    a.crew.localeCompare(b.crew)
  )
}

function assignSeasonRanks(standings) {
  const sorted = stableSort(standings, compareStandings)
  let lastTotal = null
  let lastRank = 0
  sorted.forEach((standing, index) => {
    let rank = index + 1
    if (index > 0 && standing.total === lastTotal) rank = lastRank
    standing.seasonRank = rank
    standing.quota = parseNumber(standing.rule?.quota) ?? null
    standing.insideQuota = standing.quota === null ? true : rank <= standing.quota
    lastTotal = standing.total
    lastRank = rank
  })
  return sorted
}

/** Best N meet scores plus the separate minimum valid-meet requirement. */
export function buildSeasonStandings(db, options = {}) {
  const ranked = options.ranked ?? rankMeetResults(db, options)
  const validRanked = ranked.filter((row) => row.valid && row.rank !== null)
  const groups = groupBy(validRanked, (row) => `${row.race}\u0000${row.effectiveAgeGroup}\u0000${row.crew}`)
  const standings = []

  for (const rows of groups.values()) {
    const first = rows[0]
    const rule = ruleFor(db.rules, first.race, first.effectiveAgeGroup)
    const quotaRule = quotaRuleFor(db.quota_rules, first.race, first.effectiveAgeGroup)
    const tiePolicy = quotaRule?.tie ?? '并列顺延'
    const meetMap = new Map()
    for (const row of rows) {
      const existing = meetMap.get(row.meet)
      if (!existing || row.points > existing.points || row.rank < existing.rank) {
        meetMap.set(row.meet, row)
      }
    }

    const meetResults = [...meetMap.values()].sort((a, b) => a.meet.localeCompare(b.meet))
    const bestMeets =
      parseNumber(quotaRule?.best_meets) ?? parseNumber(rule?.valid_meets) ?? meetResults.length
    const sortedPoints = [...meetResults].sort((a, b) => b.points - a.points)
    const counted = sortedPoints.slice(0, bestMeets)
    const discarded = sortedPoints.slice(bestMeets)
    const sharedSortedPoints = [...meetResults]
      .map((row) => (row.tieSize > 1 ? row.truncatedSharedPoints : row.points))
      .sort((a, b) => b - a)
    const sharedCounted = sharedSortedPoints.slice(0, bestMeets)
    const requiredValidMeets = parseNumber(rule?.valid_meets) ?? 0
    const memberIds = first.crew.split('+')

    standings.push({
      kind: memberIds.length > 1 ? '艇组' : '个人',
      race: first.race,
      ageGroup: first.effectiveAgeGroup,
      crew: first.crew,
      members: memberIds,
      boatIds: [...new Set(meetResults.map((row) => row.boat))],
      total: counted.reduce((sum, row) => sum + row.points, 0),
      sharedPointTotal: sharedCounted.reduce((sum, n) => sum + (n ?? 0), 0),
      pointPolicy: tiePolicy,
      bestMeets,
      validMeetCount: meetResults.length,
      requiredValidMeets,
      meetsRequirement: meetResults.length >= requiredValidMeets,
      bestSingle: meetResults.reduce((max, row) => Math.max(max, row.points), 0),
      countedResults: counted.map((row) => ({
        entry: row.entry,
        rev: row.revNumber,
        meet: row.meet,
        rank: row.rank,
        points: row.points,
      })),
      discardedResults: discarded.map((row) => ({
        entry: row.entry,
        rev: row.revNumber,
        meet: row.meet,
        rank: row.rank,
        points: row.points,
      })),
      meetResults: meetResults.map((row) => ({
        entry: row.entry,
        rev: row.revNumber,
        meet: row.meet,
        boat: row.boat,
        rank: row.rank,
        physicalRank: row.physicalRank,
        points: row.points,
        sharedPoints: row.tieSize > 1 ? row.truncatedSharedPoints : row.points,
        sec: row.sec,
        adjudication: row.adjudication,
      })),
      sourceEntries: meetResults.map((row) => `${row.entry}#${row.revNumber}`),
      rule,
      quotaRule,
      seasonRank: null,
      quota: parseNumber(rule?.quota),
      insideQuota: false,
    })
  }

  for (const group of groupBy(standings, (s) => `${s.race}\u0000${s.ageGroup}`).values()) {
    assignSeasonRanks(group)
  }
  return standings.sort(
    (a, b) => a.race.localeCompare(b.race) || a.ageGroup.localeCompare(b.ageGroup) || a.seasonRank - b.seasonRank,
  )
}

export function buildAthleteStandings(db, options = {}) {
  const crewStandings = options.crewStandings ?? buildSeasonStandings(db, options)
  const map = new Map()
  for (const standing of crewStandings) {
    for (const athlete of standing.members) {
      const key = `${standing.race}\u0000${standing.ageGroup}\u0000${athlete}`
      if (!map.has(key)) {
        map.set(key, {
          athlete,
          race: standing.race,
          ageGroup: standing.ageGroup,
          totals: 0,
          crews: [],
          validMeetCount: 0,
        })
      }
      const item = map.get(key)
      item.crews.push(standing.crew)
      item.totals += standing.total
      item.validMeetCount += standing.validMeetCount
    }
  }
  return [...map.values()].sort((a, b) => a.athlete.localeCompare(b.athlete) || a.race.localeCompare(b.race))
}

export function findStanding(standings, { race, ageGroup, members }) {
  const key = crewKey(members)
  return standings.find(
    (standing) => standing.race === race && standing.ageGroup === ageGroup && standing.crew === key,
  )
}

/** Confirm both the old and new group still have the required valid meets. */
export function auditTransfers(db) {
  const current = buildSeasonStandings(db)
  const beforeCorrection = buildSeasonStandings(db, { applyAppeals: false })
  const resolvedCurrent = resolveEntries(db)

  return (db.appeals ?? []).map((appeal) => {
    const versions = (db.entries ?? [])
      .filter((row) => row.entry === appeal.entry)
      .sort((a, b) => (parseNumber(b.rev) ?? 0) - (parseNumber(a.rev) ?? 0))
    const latest = versions[0]
    const confirmed = appealState(appeal) === '已确认'
    const before = previousRevision(db.entries, appeal.entry, parseNumber(appeal.version) ?? latest?.revNumber)
    const originalGroup = before?.age_group ?? latest?.age_group
    const targetGroup = appeal.requested_group
    const key = crewKey(latest?.members ?? '')
    const original = beforeCorrection.find(
      (s) => s.race === latest.race && s.ageGroup === originalGroup && s.crew === key,
    )
    const target = current.find(
      (s) => s.race === latest.race && s.ageGroup === targetGroup && s.crew === key,
    )
    const term = (db.roster_terms ?? []).find((row) => row.race === latest.race)
    const racedTogether = resolvedCurrent.some(
      (row) => row.valid && row.race === latest.race && row.crew === key,
    )
    const sameBoatBasis = term?.suitable_meets?.includes('至少一站同艇') ? racedTogether : true

    return {
      entry: appeal.entry,
      race: latest.race,
      crew: key,
      requestedGroup: targetGroup,
      targetGroup,
      originalGroup,
      appealState: appealState(appeal),
      confirmed,
      originalValidMeets: original?.validMeetCount ?? 0,
      originalRequiredMeets: original?.requiredValidMeets ?? null,
      originalMeetsRequirement: original?.meetsRequirement ?? false,
      targetValidMeets: target?.validMeetCount ?? 0,
      targetRequiredMeets: target?.requiredValidMeets ?? null,
      targetMeetsRequirement: target?.meetsRequirement ?? false,
      crossMeetCombinationLegal: sameBoatBasis,
      finalsGroupEligible: confirmed && sameBoatBasis && (target?.meetsRequirement ?? false),
      affectedSlot: db.rules?.find((r) => r.race === latest.race && r.age_group === targetGroup)?.slot ?? null,
      hold: !confirmed,
      reason: !confirmed
        ? '复议尚未确认，受影响席位暂挂'
        : !(target?.meetsRequirement ?? false)
          ? `转入组有效站数 ${target?.validMeetCount ?? 0}，未达到 ${target?.requiredValidMeets} 站要求`
          : !sameBoatBasis
            ? '跨站/替补组合缺少规则认可的同艇依据'
            : '转组程序和有效站数核查通过',
    }
  })
}
