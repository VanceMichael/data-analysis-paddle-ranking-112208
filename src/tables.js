import { createHash } from 'node:crypto'
import { rankMeetResults, buildSeasonStandings } from './rankings.js'
import { buildClubStandings, clubAtStage } from './clubs.js'
import { parseNumber } from './util.js'

function hashSnapshot(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

export function buildCorrectionImpacts(db, current = {}) {
  const currentRanked = current.ranked ?? rankMeetResults(db)
  const currentStandings = current.standings ?? buildSeasonStandings(db, { ranked: currentRanked })
  const oldRanked = rankMeetResults(db, { revision: 1 })
  const oldStandings = buildSeasonStandings(db, { revision: 1, ranked: oldRanked })
  const correctedIds = [...new Set((db.entries ?? []).filter((e) => Number(e.rev) > 1).map((e) => e.entry))]

  return correctedIds.map((entryId) => {
    const before = oldRanked.find((r) => r.entry === entryId)
    const after = currentRanked.find((r) => r.entry === entryId)
    const race = after?.race ?? before?.race
    const crew = after?.crew ?? before?.crew
    const oldGroup = before?.effectiveAgeGroup
    const newGroup = after?.effectiveAgeGroup
    const oldSeason = oldStandings.find((s) => s.race === race && s.crew === crew && s.ageGroup === oldGroup)
    const newSeason = currentStandings.find((s) => s.race === race && s.crew === crew && s.ageGroup === newGroup)

    const neighboringChanges = oldStandings
      .filter((s) => s.race === race)
      .map((oldS) => {
        const newS = currentStandings.find((n) => n.race === oldS.race && n.crew === oldS.crew)
        if (!newS || newS.ageGroup !== oldS.ageGroup) return null
        if (oldS.seasonRank === newS.seasonRank && oldS.total === newS.total) return null
        return {
          ageGroup: oldS.ageGroup,
          crew: oldS.crew,
          oldRank: oldS.seasonRank,
          newRank: newS.seasonRank,
          oldTotal: oldS.total,
          newTotal: newS.total,
        }
      })
      .filter(Boolean)

    return {
      entry: entryId,
      race,
      crew,
      affectedAthletes: after?.memberIds ?? before?.memberIds ?? [],
      before: before
        ? {
            revision: before.revNumber,
            ageGroup: before.effectiveAgeGroup,
            valid: before.valid,
            rank: before.rank,
            physicalRank: before.physicalRank,
            points: before.points,
            adjudication: before.adjudication,
          }
        : null,
      after: after
        ? {
            revision: after.revNumber,
            ageGroup: after.effectiveAgeGroup,
            valid: after.valid,
            rank: after.rank,
            physicalRank: after.physicalRank,
            points: after.points,
            adjudication: after.adjudication,
          }
        : null,
      teammateScoreEffect: (after?.memberIds ?? before?.memberIds ?? []).map((athlete) => ({
        athlete,
        oldSeasonTotal: oldSeason?.total ?? null,
        newSeasonTotal: newSeason?.total ?? null,
        scoreDelta:
          oldSeason && newSeason ? newSeason.total - oldSeason.total : null,
      })),
      neighboringChanges,
      explanation:
        '艇组成绩归属于每名稳定选手；改判后所有队员的该站积分和赛季最优站积分一起重算',
    }
  })
}

export function buildIssuedSnapshots(db, current = {}) {
  const currentRanked = current.ranked ?? rankMeetResults(db)
  const currentStandings = current.standings ?? buildSeasonStandings(db, { ranked: currentRanked })
  const currentClubs = current.clubs ?? buildClubStandings(db, { ranked: currentRanked })

  return (db.issued_tables ?? []).map((meta) => {
    const revision = parseNumber(meta.revision) ?? 1
    const ranked = rankMeetResults(db, { revision })
    const standings = buildSeasonStandings(db, { revision, ranked })
    const clubs = buildClubStandings(db, { revision, ranked })

    const raceStandings = standings.filter((s) => s.race === meta.race)
    const clubTotal = clubs.totals.find((t) => t.club === meta.club && t.race === meta.race) ?? null
    const clubMeets = clubs.meetSummaries.filter((m) => m.club === meta.club && m.race === meta.race)

    const published = {
      table: meta.table,
      club: meta.club,
      race: meta.race,
      revision,
      deliveryAt: meta.delivery_at,
      state: meta.state,
      clubTotal,
      clubMeets,
      rankings: raceStandings,
      sourceEntries: ranked
        .filter((r) => r.race === meta.race)
        .map((r) => `${r.entry}#${r.revNumber}`)
        .sort(),
    }

    const correctedEntries = (db.entries ?? [])
      .filter((e) => e.race === meta.race && (parseNumber(e.rev) ?? 1) > revision)
      .map((e) => {
        const memberClubs = e.members
          .split('+')
          .map((athlete) => clubAtStage(db, athlete, e.meet))
        return {
          entry: e.entry,
          revision: parseNumber(e.rev),
          meet: e.meet,
          adjudication: e.adjudication,
          ageGroup: e.age_group,
          affectsPublishedClub: memberClubs.includes(meta.club),
        }
      })

    const rankingCorrections = raceStandings.map((oldStanding) => {
      const nowStanding = currentStandings.find(
        (s) =>
          s.race === oldStanding.race &&
          s.ageGroup === oldStanding.ageGroup &&
          s.crew === oldStanding.crew,
      )
      return {
        ageGroup: oldStanding.ageGroup,
        crew: oldStanding.crew,
        publishedRank: oldStanding.seasonRank,
        publishedTotal: oldStanding.total,
        currentRank: nowStanding?.seasonRank ?? null,
        currentTotal: nowStanding?.total ?? null,
        issuedRankRemainsOnDeliveredTable: true,
        correction:
          nowStanding && nowStanding.total !== oldStanding.total
            ? nowStanding.total - oldStanding.total
            : 0,
      }
    })

    const currentClubTotal =
      currentClubs.totals.find((t) => t.club === meta.club && t.race === meta.race) ?? null

    return {
      ...published,
      reproductionHash: hashSnapshot(published),
      reproducibleWithRevision: revision,
      correctionScope: {
        correctedEntries,
        rankingCorrections,
        publishedClubTotal: clubTotal?.total ?? 0,
        currentClubTotal: currentClubTotal?.total ?? 0,
        disputedAccountsOnGroupOnlyRuling: [],
        policy: '已送达榜次不覆盖；仅在更正范围和当前重算中体现变化',
      },
    }
  })
}
