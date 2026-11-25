import {
  crewKey,
  intervalsOverlap,
  parseBool,
  parseNumber,
  selectRevision,
} from './util.js'
import { buildSeasonStandings, resolveEntries } from './rankings.js'
import { finalClub, projectFinalBonusForCrew } from './clubs.js'

export function selectAgenda(agenda, version = Number.POSITIVE_INFINITY) {
  const byRace = new Map()
  for (const row of agenda ?? []) {
    const rowVersion = parseNumber(row.version) ?? 1
    if (rowVersion > version) continue
    const current = byRace.get(row.race)
    if (!current || rowVersion > (parseNumber(current.version) ?? 0)) byRace.set(row.race, row)
  }
  return byRace
}

function ageGroupForMembers(db, members) {
  const groups = members
    .map((athlete) => db.roster?.find((row) => row.athlete === athlete)?.age_group)
    .filter(Boolean)
  return [...new Set(groups)].length === 1 ? groups[0] : groups[0] ?? null
}

function repliesForInvitation(db, invitationId, at) {
  return (db.replies ?? [])
    .filter((row) => row.invitation === invitationId)
    .filter((row) => at === undefined || parseNumber(row.at) <= at)
    .sort((a, b) => parseNumber(a.at) - parseNumber(b.at))
}

function defaultNoticeAt(db) {
  const times = (db.issued_tables ?? []).map((row) => parseNumber(row.delivery_at)).filter(Number.isFinite)
  return times.length ? Math.min(...times) : null
}

export function evaluateInvitations(db, options = {}) {
  const at = options.at ?? Math.max(0, ...(db.replies ?? []).map((r) => parseNumber(r.at) ?? 0))
  const noticeAt = options.noticeAt ?? defaultNoticeAt(db)
  const standings = options.standings ?? buildSeasonStandings(db)
  const agenda = options.agenda ?? selectAgenda(db.agenda, options.agendaVersion ?? Number.POSITIVE_INFINITY)
  const baselineAgenda = selectAgenda(db.agenda, 1)
  const resolved = resolveEntries(db)

  const evaluations = (db.offers ?? []).map((offer) => {
    const members = offer.members.split('+')
    const ageGroup = ageGroupForMembers(db, members)
    const rule = db.rules?.find((r) => r.race === offer.race && r.age_group === ageGroup)
    const quotaRule = db.quota_rules?.find((r) => r.race === offer.race && r.age_group === ageGroup)
    const standing = standings.find(
      (s) => s.race === offer.race && s.ageGroup === ageGroup && s.crew === crewKey(members),
    )
    const replies = repliesForInvitation(db, offer.invitation, at)
    const latestReplyByAthlete = new Map()
    for (const reply of replies) latestReplyByAthlete.set(reply.athlete, reply)
    const latestReplies = [...latestReplyByAthlete.values()]
    const acceptedMembers = latestReplies.filter((r) => r.reply === '接受').map((r) => r.athlete)
    const declinePattern = /拒绝|不到场|退回|释放|放弃/
    const declinedReplies = latestReplies.filter((r) => declinePattern.test(r.reply))
    const declinedMembers = [...new Set(declinedReplies.map((r) => r.athlete))]
    const pendingMembers = members.filter(
      (athlete) => !acceptedMembers.includes(athlete) && !declinedMembers.includes(athlete),
    )
    const allAccepted = members.length > 0 && members.every((m) => acceptedMembers.includes(m))
    const ordinaryDecline = declinedReplies.some(
      (r) => !r.reply.includes('裁判') && !r.reply.includes('取消'),
    )

    const dqResults = resolved.filter(
      (row) =>
        row.race === offer.race &&
        row.crew === crewKey(members) &&
        (!row.valid || row.invalidReason?.includes('取消资格')),
    )

    let basisStatus = 'valid'
    if (!standing) basisStatus = 'no_ranking'
    else if (!standing.meetsRequirement) basisStatus = 'invalid'
    else if (dqResults.some((r) => r.invalidReason?.includes('取消资格'))) basisStatus = 'corrected'

    const membership = members.map((athlete) => {
      const rosterRow = db.roster?.find((row) => row.athlete === athlete)
      return {
        athlete,
        rosterClub: rosterRow?.club ?? null,
        currentFinalClub: finalClub(db, athlete),
        ageGroup: rosterRow?.age_group ?? null,
        entrance: rosterRow?.entrance ?? null,
        confirmed: rosterRow?.entrance === '已确认',
      }
    })
    const membershipConfirmed = membership.every((m) => m.confirmed)

    const proofPeriod = parseNumber(quotaRule?.proof_period)
    const holdWindow = proofPeriod
    const responseDeadline =
      Number.isFinite(noticeAt) && Number.isFinite(proofPeriod) ? noticeAt + proofPeriod : null
    const retentionWindowOpen =
      responseDeadline === null ? null : at <= responseDeadline

    let responseStatus
    if (allAccepted) responseStatus = 'accepted'
    else if (declinedMembers.length) responseStatus = 'declined'
    else if (acceptedMembers.length) responseStatus = 'partial'
    else if (offer.state === '候补') responseStatus = 'waitlist'
    else if (offer.state === '已拒绝') responseStatus = 'declined'
    else responseStatus = 'pending'

    const schedule = agenda.get(offer.race)
    return {
      invitation: offer.invitation,
      race: offer.race,
      ageGroup,
      members,
      crew: crewKey(members),
      rawState: offer.state,
      protection: offer.protection,
      locked: offer.protection === '锁定',
      membership,
      membershipConfirmed,
      at,
      noticeAt,
      proofPeriod,
      holdWindow,
      responseDeadline,
      retentionWindowOpen,
      replies,
      latestReplies,
      acceptedAt: acceptedMembers
        .map((athlete) => parseNumber(latestReplyByAthlete.get(athlete)?.at))
        .filter(Number.isFinite)
        .reduce((max, t) => Math.max(max, t), null),
      acceptedMembers,
      declinedMembers,
      pendingMembers,
      allAccepted,
      ordinaryDecline,
      responseStatus,
      basisStatus,
      basis: standing
        ? {
            seasonRank: standing.seasonRank,
            total: standing.total,
            validMeetCount: standing.validMeetCount,
            requiredValidMeets: standing.requiredValidMeets,
            meetsRequirement: standing.meetsRequirement,
            insideQuotaCurrent: standing.insideQuota,
            quota: standing.quota,
            sourceEntries: standing.sourceEntries,
          }
        : null,
      dqResults: dqResults.map((r) => ({ entry: r.entry, rev: r.revNumber, reason: r.invalidReason })),
      schedule: schedule
        ? { slot: schedule.slot, start: parseNumber(schedule.start), end: parseNumber(schedule.end), version: parseNumber(schedule.version) }
        : null,
      conflicts: [],
      failedParts: [],
      disposition: null,
      statusZh: null,
      reasons: [],
    }
  })

  // Build athlete overlap graph using the selected agenda version.
  const byAthlete = new Map()
  for (const inv of evaluations) {
    for (const athlete of inv.members) {
      if (!byAthlete.has(athlete)) byAthlete.set(athlete, [])
      byAthlete.get(athlete).push(inv)
    }
  }

  for (const [athlete, invs] of byAthlete) {
    for (let i = 0; i < invs.length; i++) {
      for (let j = i + 1; j < invs.length; j++) {
        const a = invs[i]
        const b = invs[j]
        const sameRace = a.race === b.race
        const overlap =
          sameRace ||
          (a.schedule &&
            b.schedule &&
            intervalsOverlap(a.schedule.start, a.schedule.end, b.schedule.start, b.schedule.end))
        if (!overlap) continue

        const aCommitted = a.responseStatus === 'accepted' || a.locked || a.responseStatus === 'partial'
        const bCommitted = b.responseStatus === 'accepted' || b.locked || b.responseStatus === 'partial'
        const oldA = baselineAgenda.get(a.race)
        const oldB = baselineAgenda.get(b.race)
        const oldOverlap =
          a.race === b.race ||
          (oldA && oldB && intervalsOverlap(parseNumber(oldA.start), parseNumber(oldA.end), parseNumber(oldB.start), parseNumber(oldB.end)))
        const previouslyCompatible = overlap && !oldOverlap
        const resolvedByRelease =
          a.responseStatus === 'declined' || b.responseStatus === 'declined'
        const active = !resolvedByRelease
        const severity =
          a.responseStatus === 'accepted' && b.responseStatus === 'accepted'
            ? 'confirmed_choice_required'
            : aCommitted || bCommitted
              ? 'blocked_until_choice'
              : 'candidate_overlap'
        const descriptorForA = {
          withInvitation: b.invitation,
          otherRace: b.race,
          athlete,
          severity,
          active,
          resolvedByRelease,
          sameRace,
          previouslyCompatible,
          policy: quotaRuleConflict(db, a.race, a.ageGroup) ?? '征询',
          preserveConfirmations: true,
          schedules: [a.schedule, b.schedule],
        }
        a.conflicts.push(descriptorForA)
        b.conflicts.push({ ...descriptorForA, withInvitation: a.invitation, otherRace: a.race })
      }
    }
  }

  for (const inv of evaluations) {
    for (const dq of inv.dqResults) {
      inv.failedParts.push({
        type: dq.reason?.includes('取消资格') ? 'referee_result' : 'invalid_result',
        source: `${dq.entry}#${dq.rev}`,
        detail: dq.reason,
        effect: inv.basisStatus === 'invalid' ? '剩余有效依据不足，邀约可能必须撤销' : '该站积分失效，但邀约仍有其他有效站可重查',
      })
    }
    if (inv.basisStatus === 'no_ranking') {
      inv.failedParts.push({ type: 'ranking', detail: '找不到同 race/age_group/crew 的有效排名' })
    } else if (inv.basisStatus === 'invalid') {
      inv.failedParts.push({
        type: 'valid_meets',
        detail: `有效站 ${inv.basis.validMeetCount} 低于要求 ${inv.basis.requiredValidMeets}`,
      })
    }
    for (const conflict of inv.conflicts.filter((c) => c.previouslyCompatible)) {
      inv.failedParts.push({
        type: 'schedule_change',
        detail: `裁判调时后与 ${conflict.withInvitation} 重合；原 v1 时刻兼容`,
      })
    }
    for (const athlete of inv.declinedMembers) {
      inv.failedParts.push({
        type: 'ordinary_reply',
        athlete,
        detail: '普通拒绝/不到场/释放；不取消原成绩，但该确认主体失效',
      })
    }

    const blocking = inv.conflicts.some((c) => c.active && c.severity !== 'candidate_overlap')
    if (!inv.membershipConfirmed) {
      inv.disposition = 'membership_review_required'
      inv.statusZh = '决赛成员资格尚未确证，邀请暂不能实际发出/确认'
      inv.reasons.push('决赛邀请必须按当前确证的成员资格审查；转队不影响历史站代表关系')
    } else if (inv.basisStatus === 'invalid' && (inv.allAccepted || inv.locked)) {
      inv.disposition = 'basis_revocation_review'
      inv.statusZh = '有效依据失效，需撤销审查'
      inv.reasons.push('有效站数或有效成绩依据不成立；已确认邀约必须重新判断是否撤销')
    } else if (inv.responseStatus === 'accepted' && inv.conflicts.some((c) => c.active && c.severity === 'confirmed_choice_required')) {
      inv.disposition = 'confirmed_choice_required'
      inv.statusZh = '两项确认时间冲突，保留确认并待征询选择'
      inv.reasons.push('调时造成已确认资格冲突；不自动撤销任一方，报领队/运动员作实际选择')
    } else if (inv.responseStatus === 'accepted' && blocking) {
      inv.disposition = 'confirmed_protected_other_blocked'
      inv.statusZh = '已确认并保护；冲突候选暂不能确认'
      inv.reasons.push('已有确认/锁定资格优先保留，冲突方需先释放或完成征询')
    } else if (inv.responseStatus === 'accepted') {
      inv.disposition = 'confirmed'
      inv.statusZh = inv.locked ? '已接受并锁定' : '已接受'
      if (inv.basisStatus === 'corrected') {
        inv.reasons.push('含被取消成绩，但剩余有效成绩仍满足有效站数，锁定依据经重查仍成立')
      }
      if (inv.basis && !inv.basis.insideQuotaCurrent) {
        inv.reasons.push('当前榜单名次在名额线外；既有锁定席位不被新成绩自动替换，候补仍需等待席位释放')
      }
    } else if (inv.responseStatus === 'partial') {
      inv.disposition = 'partial_hold'
      inv.statusZh = '部分接受，整艇席位保留至答复截止'
      inv.reasons.push(`其余队员未答复；整艇席位最多保留 ${inv.holdWindow ?? '?'} 个时间单位`)
    } else if (inv.responseStatus === 'declined') {
      inv.disposition = inv.retentionWindowOpen ? 'ordinary_decline_substitution_window' : 'ordinary_decline_release'
      inv.statusZh = inv.retentionWindowOpen ? '队员普通拒绝；成绩不取消，替补/递补窗口保留中' : '普通拒绝且窗口届满；沿有效资格递补'
      inv.reasons.push('普通不到场/拒绝不同于裁判取消成绩，原成绩和榜单不因此删除')
    } else if (inv.responseStatus === 'waitlist') {
      inv.disposition = blocking ? 'waitlist_blocked' : 'waitlist_ready_when_quota_opens'
      inv.statusZh = blocking ? '候补有效，但受名额或时间冲突阻塞' : '候补有效，等待名额释放'
    } else {
      inv.disposition = 'awaiting_response'
      inv.statusZh = inv.rawState === '待确认' ? '资格待确认/征询' : '等待答复'
    }
  }

  return evaluations
}

function quotaRuleConflict(db, race, ageGroup) {
  return db.quota_rules?.find((r) => r.race === race && r.age_group === ageGroup)?.conflict
}

export function buildQuotaLedger(db, evaluations) {
  const keys = new Set((db.rules ?? []).map((r) => `${r.race}\u0000${r.age_group}`))
  const ledgers = []
  for (const key of keys) {
    const [race, ageGroup] = key.split('\u0000')
    const rule = db.rules.find((r) => r.race === race && r.age_group === ageGroup)
    const invs = evaluations.filter((i) => i.race === race && i.ageGroup === ageGroup)
    const confirmed = invs.filter(
      (i) => i.responseStatus === 'accepted' && i.basisStatus !== 'invalid' && i.membershipConfirmed,
    )
    const locks = invs.filter((i) => i.locked)
    const retentionHolds = invs.filter(
      (i) => (i.responseStatus === 'partial' || i.responseStatus === 'declined') && i.retentionWindowOpen !== false,
    )
    const waitlist = invs
      .filter((i) => i.responseStatus === 'waitlist' || i.rawState === '候补')
      .sort((a, b) => (a.basis?.seasonRank ?? 999) - (b.basis?.seasonRank ?? 999))

    ledgers.push({
      race,
      ageGroup,
      quota: parseNumber(rule.quota),
      slot: rule.slot,
      designatedReserve: rule.reserve,
      confirmedCount: confirmed.length,
      lockedCount: locks.length,
      retentionHoldCount: retentionHolds.length,
      freeConfirmedSlots: Math.max(0, parseNumber(rule.quota) - confirmed.length),
      overQuota: confirmed.length > parseNumber(rule.quota),
      confirmed: confirmed.map((i) => i.invitation),
      locks: locks.map((i) => i.invitation),
      retentionHolds: retentionHolds.map((i) => i.invitation),
      waitlistOrder: waitlist.map((i) => ({
        invitation: i.invitation,
        rank: i.basis?.seasonRank ?? null,
        disposition: i.disposition,
      })),
    })
  }
  return ledgers
}

export function evaluateReplacements(db, invitationEvaluations = [], bonusAudit = null) {
  const currentEntries = selectRevision(db.entries ?? [])
  const resolved = resolveEntries(db)
  return (db.replacements ?? []).map((replacement) => {
    const boatEntry = currentEntries.find((e) => e.boat === replacement.boat)
    const race = boatEntry?.race
    const crewMembers = boatEntry?.members.split('+') ?? []
    const retainedMembers = crewMembers.filter((m) => m !== replacement.member)
    const proposedCrew = [...retainedMembers, replacement.candidate]
    const sourceEligible = parseBool(replacement.eligible)
    const term = db.roster_terms?.find((t) => t.race === race)
    const sharedBoatResult = resolved.some(
      (row) => row.valid && row.race === race && row.crew === crewKey(proposedCrew),
    )
    const confirmedListPolicy = term?.substitute_policy?.includes('另有确认名单') ?? false
    const combinationBasis =
      sourceEligible && (sharedBoatResult || confirmedListPolicy || (term?.suitable_meets?.includes('至少一站同艇') ? sharedBoatResult : true))
    const ruleApproved = sourceEligible && combinationBasis

    const outgoingProtections = invitationEvaluations.filter(
      (inv) => inv.race === race && inv.members.includes(replacement.member),
    )
    const candidateProtections = invitationEvaluations.filter((inv) =>
      inv.members.includes(replacement.candidate),
    )
    const triggerPresent = outgoingProtections.some(
      (inv) => inv.responseStatus === 'declined' || inv.declinedMembers.includes(replacement.member),
    )
    const outgoingFinalClub = finalClub(db, replacement.member)
    const candidateFinalClub = finalClub(db, replacement.candidate)

    const candidateHasProtection = candidateProtections.some(
      (p) => p.locked || p.allAccepted || p.acceptedMembers.length > 0 || ['accepted', 'partial'].includes(p.responseStatus),
    )

    let recommendation
    if (!sourceEligible) recommendation = '替补名单明确为 false，不予认可'
    else if (!combinationBasis) recommendation = '候选与保留队员缺少规则认可的组合/同艇依据'
    else if (candidateHasProtection) {
      recommendation = '替补规则有效，但候选人已有另一艇/项目保护或已个人接受，必须先征询'
    } else if (!triggerPresent) recommendation = '资格审查通过；需原队员拒绝、释放或不能到场后才生效'
    else recommendation = '可在原队员释放后生效'

    return {
      boat: replacement.boat,
      entry: boatEntry?.entry,
      race,
      outgoing: replacement.member,
      candidate: replacement.candidate,
      retainedMembers,
      proposedCrew,
      sourceEligible,
      sharedBoatResult,
      confirmedListPolicy,
      combinationBasis,
      ruleApproved,
      triggerPresent,
      candidateHasProtection,
      outgoingProtections: outgoingProtections.map((i) => i.invitation),
      candidateProtections: candidateProtections.map((i) => ({
        invitation: i.invitation,
        race: i.race,
        status: i.statusZh,
        responseStatus: i.responseStatus,
      })),
      clubChange: outgoingFinalClub !== candidateFinalClub,
      outgoingFinalClub,
      candidateFinalClub,
      clubBonusProjection: bonusAudit
        ? projectFinalBonusForCrew(db, bonusAudit, race, proposedCrew)
        : null,
      recommendation,
    }
  })
}

export function explainWaitlist(db, invitationId, evaluations, ledger) {
  const inv = evaluations.find((i) => i.invitation === invitationId)
  if (!inv) throw new Error(`unknown invitation ${invitationId}`)
  const raceLedger = ledger.find((l) => l.race === inv.race && l.ageGroup === inv.ageGroup)
  const ahead = evaluations.filter(
    (other) =>
      other.invitation !== inv.invitation &&
      other.race === inv.race &&
      other.ageGroup === inv.ageGroup &&
      (other.responseStatus === 'accepted' ||
        other.responseStatus === 'partial' ||
        (other.locked && other.responseStatus !== 'declined')),
  )

  const conditions = []
  if (raceLedger?.freeConfirmedSlots === 0) {
    conditions.push(`等待当前占用名额释放：${raceLedger.confirmed.join('、') || '无'}`)
  }
  for (const other of ahead) {
    if (other.locked) conditions.push(`${other.invitation} 为锁定邀约，需保护期结束、本人释放或裁判依据失效后撤销`)
  }
  for (const conflict of inv.conflicts.filter((c) => c.active)) {
    conditions.push(`队员 ${conflict.athlete} 与 ${conflict.withInvitation} 时间/项目冲突，需其完成选择或对方释放`)
  }
  if (inv.basis && !inv.basis.meetsRequirement) {
    conditions.push(`本邀约自身有效站数不足（${inv.basis.validMeetCount}/${inv.basis.requiredValidMeets}）`)
  }

  const fixedDeadline = conditions.some((c) => c.includes('锁定') || c.includes('裁判') || c.includes('冲突'))
    ? null
    : inv.responseDeadline
  return {
    invitation: invitationId,
    effectiveRank: inv.basis?.seasonRank ?? null,
    disposition: inv.disposition,
    conditions,
    fixedDeterminationTime: fixedDeadline,
    timeBasis:
      fixedDeadline !== null
        ? `以通知时间 ${inv.noticeAt} 加举证/保留期 ${inv.proofPeriod} 计算`
        : '答复截止不能决定锁定、裁判复议或征询选择；这些事件发生后才能确定',
  }
}

export function buildAthleteDashboard(db, evaluations, standings) {
  return (db.roster ?? []).map((person) => {
    const athlete = person.athlete
    const invitations = evaluations.filter((inv) => inv.members.includes(athlete))
    const qualifications = (standings ?? [])
      .filter((s) => s.members.includes(athlete))
      .map((s) => ({
        race: s.race,
        ageGroup: s.ageGroup,
        crew: s.crew,
        kind: s.kind,
        seasonRank: s.seasonRank,
        total: s.total,
        insideQuota: s.insideQuota,
        meetsRequirement: s.meetsRequirement,
      }))

    return {
      athlete,
      club: person.club,
      currentFinalClub: finalClub(db, athlete),
      ageGroup: person.age_group,
      entrance: person.entrance,
      membershipConfirmed: person.entrance === '已确认',
      invitations: invitations.map((inv) => {
        const activeConflicts = inv.conflicts.filter((c) => c.active)
        const committedConflict = activeConflicts.some((c) => {
          const other = evaluations.find((i) => i.invitation === c.withInvitation)
          return other && (other.responseStatus === 'accepted' || other.locked)
        })
        return {
          invitation: inv.invitation,
          race: inv.race,
          crew: inv.crew,
          responseStatus: inv.responseStatus,
          statusZh: inv.statusZh,
          acceptedByMe: inv.acceptedMembers.includes(athlete),
          declinedByMe: inv.declinedMembers.includes(athlete),
          responseDeadline: inv.responseDeadline,
          activeConflicts,
          canConfirm:
            inv.membershipConfirmed &&
            inv.basisStatus !== 'invalid' &&
            !committedConflict &&
            !inv.declinedMembers.includes(athlete),
          confirmationHint: !inv.membershipConfirmed
            ? '当前成员资格尚未确证'
            : committedConflict
              ? '存在已确认/锁定的冲突项目；不能同时确认，需先完成征询或释放'
              : inv.basisStatus === 'invalid'
                ? '有效依据不足，不能据此确认'
                : '可在答复截止前确认',
        }
      }),
      qualifications,
      candidateIndividualQualifications: qualifications.filter(
        (q) => q.kind === '个人' && q.meetsRequirement,
      ),
      partialBoatSeats: invitations
        .filter((i) => i.responseStatus === 'partial')
        .map((i) => i.invitation),
    }
  })
}

export function buildTimeline(db) {
  const events = []
  for (const reply of db.replies ?? []) {
    events.push({
      at: parseNumber(reply.at),
      type: 'reply',
      invitation: reply.invitation,
      athlete: reply.athlete,
      detail: reply.reply,
      consequence:
        reply.reply === '拒绝'
          ? '普通拒绝：有效成绩保留，启动替补/递补判断'
          : reply.reply === '接受'
            ? '接受时间参与席位和冲突判断'
            : reply.reply,
    })
  }
  for (const table of db.issued_tables ?? []) {
    events.push({ at: parseNumber(table.delivery_at), type: 'issued_table', table: table.table, detail: table.state })
  }
  return events.sort((a, b) => a.at - b.at || a.type.localeCompare(b.type))
}
