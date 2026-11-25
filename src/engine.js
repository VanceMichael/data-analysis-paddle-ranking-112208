import { rankMeetResults, buildSeasonStandings, buildAthleteStandings, auditTransfers } from './rankings.js'
import { buildClubStandings, auditFinalBonus, projectFinalBonusForCrew } from './clubs.js'
import {
  evaluateInvitations,
  buildQuotaLedger,
  evaluateReplacements,
  explainWaitlist,
  buildTimeline,
  buildAthleteDashboard,
} from './invitations.js'
import { buildIssuedSnapshots, buildCorrectionImpacts } from './tables.js'
import { crewKey as crewKeyValue } from './util.js'

export function analyzeDataset(db, options = {}) {
  const ranked = rankMeetResults(db, options)
  const standings = buildSeasonStandings(db, { ...options, ranked })
  const athleteStandings = buildAthleteStandings(db, { ...options, crewStandings: standings })
  const clubStandings = buildClubStandings(db, { ...options, ranked, standings })
  const transferAudits = auditTransfers(db)
  const invitations = evaluateInvitations(db, { ...options, standings })
  const quotaLedger = buildQuotaLedger(db, invitations)
  const athleteDashboard = buildAthleteDashboard(db, invitations, standings)
  const bonusAudit = auditFinalBonus(db, invitations)
  for (const transfer of transferAudits) {
    const alreadyCounted = bonusAudit.allocations.some(
      (a) => a.race === transfer.race && crewKeyValue(a.crew) === transfer.crew,
    )
    transfer.finalBonusProjection = projectFinalBonusForCrew(
      db,
      bonusAudit,
      transfer.race,
      transfer.crew.split('+'),
    ).map((projection) =>
      alreadyCounted
        ? {
            ...projection,
            alreadyCounted: true,
            afterConfirmation: projection.currentUsed,
            wouldExceed: projection.currentUsed > projection.limit,
          }
        : projection,
    )
    transfer.clubQuotaHoldRequired =
      transfer.confirmed &&
      transfer.finalsGroupEligible &&
      transfer.finalBonusProjection.some((p) => p.wouldExceed)
  }
  const replacements = evaluateReplacements(db, invitations, bonusAudit)
  const waitlists = invitations
    .filter((inv) => inv.rawState === '候补' || inv.responseStatus === 'waitlist')
    .map((inv) => explainWaitlist(db, inv.invitation, invitations, quotaLedger))
  const issuedTables = buildIssuedSnapshots(db, {
    ranked,
    standings,
    clubs: clubStandings,
  })
  const correctionImpacts = buildCorrectionImpacts(db, { ranked, standings })

  const contingentClubLimits = invitations
    .filter((inv) => inv.responseStatus !== 'accepted')
    .map((inv) => ({
      invitation: inv.invitation,
      race: inv.race,
      crew: inv.crew,
      ifConfirmed: projectFinalBonusForCrew(db, bonusAudit, inv.race, inv.members),
    }))
    .filter((item) => item.ifConfirmed.some((p) => p.wouldExceed))

  const holds = [
    ...transferAudits
      .filter((t) => t.hold)
      .map((t) => ({
        account: `${t.race}:${t.affectedSlot ?? 'seat'}:${t.entry}`,
        type: 'appeal',
        status: '暂挂',
        reason: t.reason,
      })),
    ...transferAudits
      .filter((t) => t.clubQuotaHoldRequired)
      .map((t) => ({
        account: t.finalBonusProjection.filter((p) => p.wouldExceed).map((p) => `${p.club}:${p.race}:final_bonus`).join(','),
        type: 'group_ruling_club_quota',
        status: '暂挂',
        reason: `${t.entry} 仅修正组别归属也可能改变俱乐部决赛名额/团体账项；争议账项暂挂，不影响资格已确证的个人邀约`,
      })),
    ...bonusAudit.summaries
      .filter((s) => s.overLimit)
      .map((s) => ({
        account: `${s.club}:${s.race}:final_bonus`,
        type: 'club_final_bonus',
        status: '暂挂',
        reason: `已确认决赛出场 ${s.used} 超过团体奖励名额 ${s.limit}`,
      })),
    ...contingentClubLimits.map((item) => ({
      account: item.ifConfirmed.filter((p) => p.wouldExceed).map((p) => `${p.club}:${p.race}:final_bonus`).join(','),
      type: 'contingent_club_final_bonus',
      status: '条件性暂挂预警',
      reason: `${item.invitation} 一旦确认，将超过俱乐部决赛奖励名额；个人邀约审查与团体积分账项分开处理`,
      invitation: item.invitation,
    })),
  ]

  return {
    options: {
      revision: options.revision ?? 'current',
      at: options.at ?? 'latest-reply',
      agendaVersion: options.agendaVersion ?? 'latest',
    },
    rankings: ranked,
    standings,
    athleteStandings,
    transferAudits,
    invitations,
    athleteDashboard,
    quotaLedger,
    replacements,
    waitlists,
    clubStandings,
    bonusAudit,
    contingentClubLimits,
    holds,
    correctionImpacts,
    issuedTables,
    timeline: buildTimeline(db),
  }
}

export * from './util.js'
export * from './load-data.js'
export * from './rankings.js'
export * from './clubs.js'
export * from './invitations.js'
export * from './tables.js'
