import { crewKey, groupBy, parseNumber, stageOrder } from './util.js'
import { rankMeetResults, buildSeasonStandings } from './rankings.js'

export function clubAtStage(db, athlete, stage) {
  const rows = (db.affiliations ?? [])
    .filter((row) => row.athlete === athlete)
    .sort((a, b) => stageOrder(b.from_meet) - stageOrder(a.from_meet))
  const stageIndex = stageOrder(stage)
  const active = rows.find(
    (row) => stageOrder(row.from_meet) <= stageIndex && stageIndex <= stageOrder(row.to_meet),
  )
  if (active) return active.club
  return db.roster?.find((row) => row.athlete === athlete)?.club ?? null
}

export function finalClub(db, athlete) {
  return clubAtStage(db, athlete, '决赛')
}

function limitFor(db, club, race) {
  return (db.club_limits ?? []).find((row) => row.club === club && row.race === race)
}

/**
 * Club points from meet results. A mixed-club crew is attributed to every
 * represented member club; each club's scoring_slots cap is then applied.
 */
export function buildClubStandings(db, options = {}) {
  const ranked = options.ranked ?? rankMeetResults(db, options)
  const candidates = []

  for (const result of ranked) {
    if (!result.valid || result.rank === null) continue
    const memberClubs = Object.fromEntries(
      result.memberIds.map((athlete) => [athlete, clubAtStage(db, athlete, result.meet)]),
    )
    const clubs = [...new Set(Object.values(memberClubs).filter(Boolean))]
    for (const club of clubs) {
      candidates.push({
        club,
        race: result.race,
        meet: result.meet,
        ageGroup: result.effectiveAgeGroup,
        entry: result.entry,
        rev: result.revNumber,
        boat: result.boat,
        crew: result.crew,
        rank: result.rank,
        physicalRank: result.physicalRank,
        points: result.points,
        memberClubs,
        mixedClub: clubs.length > 1,
        source: `${result.entry}#${result.revNumber}`,
      })
    }
  }

  const meetGroups = groupBy(candidates, (c) => `${c.club}\u0000${c.race}\u0000${c.meet}`)
  const scoredCandidates = []
  const meetSummaries = []

  for (const group of meetGroups.values()) {
    const first = group[0]
    const limit = limitFor(db, first.club, first.race)
    const slots = parseNumber(limit?.scoring_slots) ?? Number.POSITIVE_INFINITY
    const sorted = group.sort((a, b) => b.points - a.points || a.rank - b.rank || a.entry.localeCompare(b.entry))
    sorted.forEach((candidate, index) => {
      candidate.scoringSlot = index + 1
      candidate.countsForTeamTable = index < slots
      candidate.scoringSlotsLimit = Number.isFinite(slots) ? slots : null
      scoredCandidates.push(candidate)
    })
    meetSummaries.push({
      club: first.club,
      race: first.race,
      meet: first.meet,
      scoringSlots: Number.isFinite(slots) ? slots : null,
      points: sorted.filter((c) => c.countsForTeamTable).reduce((sum, c) => sum + c.points, 0),
      candidates: sorted,
    })
  }

  const totalGroups = groupBy(
    scoredCandidates.filter((c) => c.countsForTeamTable),
    (c) => `${c.club}\u0000${c.race}`,
  )
  const totals = [...totalGroups.values()].map((rows) => ({
    club: rows[0].club,
    race: rows[0].race,
    total: rows.reduce((sum, row) => sum + row.points, 0),
    countedResults: rows.map((row) => ({
      meet: row.meet,
      entry: row.entry,
      rev: row.rev,
      ageGroup: row.ageGroup,
      crew: row.crew,
      rank: row.rank,
      points: row.points,
    })),
  }))

  for (const limit of db.club_limits ?? []) {
    if (!totals.some((t) => t.club === limit.club && t.race === limit.race)) {
      totals.push({ club: limit.club, race: limit.race, total: 0, countedResults: [] })
    }
  }

  const seasonStandings = options.standings ?? buildSeasonStandings(db, { ...options, ranked })
  const seasonCandidateGroups = groupBy(candidates, (c) => `${c.club}\u0000${c.race}\u0000${c.crew}`)
  const seasonCandidates = [...seasonCandidateGroups.values()].map((rows) => {
    const first = rows[0]
    const standing = seasonStandings.find(
      (s) => s.race === first.race && s.ageGroup === first.ageGroup && s.crew === first.crew,
    )
    return {
      club: first.club,
      race: first.race,
      crew: first.crew,
      ageGroup: first.ageGroup,
      seasonRank: standing?.seasonRank ?? null,
      championshipTotal: standing?.total ?? rows.reduce((sum, r) => sum + r.points, 0),
      allMeetPointsSum: rows.reduce((sum, r) => sum + r.points, 0),
      meetCount: new Set(rows.map((r) => r.meet)).size,
    }
  })

  const seasonTotals = []
  for (const [key, rows] of groupBy(seasonCandidates, (c) => `${c.club}\u0000${c.race}`)) {
    const [club, race] = key.split('\u0000')
    const limit = limitFor(db, club, race)
    const slots = parseNumber(limit?.scoring_slots) ?? Number.POSITIVE_INFINITY
    const sorted = rows.sort(
      (a, b) => b.championshipTotal - a.championshipTotal || (a.seasonRank ?? 999) - (b.seasonRank ?? 999),
    )
    sorted.forEach((candidate, index) => {
      candidate.candidateSlot = index + 1
      candidate.countsForSeasonTeamTable = index < slots
      candidate.scoringSlotsLimit = Number.isFinite(slots) ? slots : null
    })
    seasonTotals.push({
      club,
      race,
      scoringSlots: Number.isFinite(slots) ? slots : null,
      // Preferred season-board interpretation: limited candidates contribute
      // their rule-truncated best-meet championship total.
      total: sorted
        .filter((c) => c.countsForSeasonTeamTable)
        .reduce((sum, c) => sum + c.championshipTotal, 0),
      allMeetPointsTotal: sorted
        .filter((c) => c.countsForSeasonTeamTable)
        .reduce((sum, c) => sum + c.allMeetPointsSum, 0),
      candidates: sorted,
    })
  }

  return { candidates: scoredCandidates, meetSummaries, totals, seasonCandidates, seasonTotals }
}

/** Count currently confirmed final starts against final_bonus_limit. */
export function auditFinalBonus(db, invitationEvaluations = []) {
  const allocations = []
  for (const invitation of invitationEvaluations) {
    if (invitation.responseStatus !== 'accepted') continue
    if (invitation.basisStatus === 'invalid' || invitation.membershipConfirmed === false) continue
    const clubs = [...new Set(invitation.members.map((athlete) => finalClub(db, athlete)).filter(Boolean))]
    for (const club of clubs) {
      allocations.push({
        club,
        race: invitation.race,
        invitation: invitation.invitation,
        crew: invitation.members.join('+'),
        members: invitation.members,
      })
    }
  }

  const summaries = (db.club_limits ?? []).map((limit) => {
    const used = allocations.filter((a) => a.club === limit.club && a.race === limit.race).length
    const finalBonusLimit = parseNumber(limit.final_bonus_limit) ?? 0
    return {
      club: limit.club,
      race: limit.race,
      used,
      limit: finalBonusLimit,
      remaining: Math.max(0, finalBonusLimit - used),
      overLimit: used > finalBonusLimit,
      allocations: allocations.filter((a) => a.club === limit.club && a.race === limit.race),
    }
  })

  return { allocations, summaries }
}

export function projectFinalBonusForCrew(db, bonusAudit, race, members) {
  const clubs = [...new Set(members.map((athlete) => finalClub(db, athlete)).filter(Boolean))]
  return clubs.map((club) => {
    const current = bonusAudit.summaries.find((s) => s.club === club && s.race === race)
    const used = current?.used ?? 0
    const limit = current?.limit ?? parseNumber(limitFor(db, club, race)?.final_bonus_limit) ?? 0
    return {
      club,
      race,
      currentUsed: used,
      afterConfirmation: used + 1,
      limit,
      wouldExceed: used + 1 > limit,
    }
  })
}

export { crewKey }
