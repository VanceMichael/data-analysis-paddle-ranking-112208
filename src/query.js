import { analyzeDataset } from './engine.js'

/**
 * Structured query entry point for future CLI/UI/HTTP adapters.
 * request:
 *  - { type: 'ranking', race?, ageGroup?, revision? }
 *  - { type: 'invitation', id, at?, agendaVersion? }
 *  - { type: 'waitlist', id? }
 *  - { type: 'athlete', id? }
 *  - { type: 'table', id? }
 *  - { type: 'clubs' }
 */
export function queryDataset(db, request = { type: 'report' }) {
  const analysis = analyzeDataset(db, request.options ?? request)

  switch (request.type) {
    case 'ranking':
      return analysis.standings.filter(
        (s) =>
          (!request.race || s.race === request.race) &&
          (!request.ageGroup || s.ageGroup === request.ageGroup),
      )
    case 'invitation': {
      const inv = analysis.invitations.find((i) => i.invitation === request.id)
      if (!inv) throw new Error(`unknown invitation: ${request.id}`)
      return { ...inv, explanation: explainInvitation(inv) }
    }
    case 'waitlist':
      return request.id
        ? analysis.waitlists.find((w) => w.invitation === request.id)
        : analysis.waitlists
    case 'athlete':
      return request.id
        ? analysis.athleteDashboard.find((a) => a.athlete === request.id)
        : analysis.athleteDashboard
    case 'table':
      return request.id
        ? analysis.issuedTables.find((t) => t.table === request.id)
        : analysis.issuedTables
    case 'clubs':
      return {
        meetTotals: analysis.clubStandings.totals,
        seasonTotals: analysis.clubStandings.seasonTotals,
        finalBonus: analysis.bonusAudit,
        holds: analysis.holds,
      }
    case 'corrections':
      return analysis.correctionImpacts
    case 'report':
    default:
      return analysis
  }
}

export function explainInvitation(inv) {
  const lines = [
    `${inv.invitation} ${inv.race} ${inv.crew}：${inv.statusZh}`,
    inv.basis
      ? `有效排名 #${inv.basis.seasonRank}，${inv.basis.total} 分，有效站 ${inv.basis.validMeetCount}/${inv.basis.requiredValidMeets}。`
      : '当前找不到有效排名依据。',
  ]
  for (const part of inv.failedParts) {
    lines.push(`失效/变化部分[${part.type}]${part.source ? ` ${part.source}` : ''}：${part.detail}${part.effect ? `；${part.effect}` : ''}`)
  }
  for (const conflict of inv.conflicts.filter((c) => c.active)) {
    lines.push(
      `与 ${conflict.withInvitation} 在 ${conflict.athlete} 处时间重合（${conflict.severity}）；政策为${conflict.policy}，既有确认保留，需征询选择。`,
    )
  }
  if (inv.responseStatus !== 'accepted' && inv.responseDeadline !== null) {
    lines.push(`按通知锚点 ${inv.noticeAt} 和保留期 ${inv.proofPeriod}，席位保留/答复窗口截止 t=${inv.responseDeadline}；实际发邀时间缺失时应替换 noticeAt。`)
  } else if (inv.responseStatus === 'accepted') {
    lines.push(`规则期限为 ${inv.proofPeriod ?? '?'}；已接受/锁定席位不适用待答复保留截止，锁定保护解除需看保护期、释放或裁判裁决。`)
  }
  return lines
}
