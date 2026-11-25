#!/usr/bin/env node
import { loadDataset, validateReferences } from './load-data.js'
import { analyzeDataset } from './engine.js'

function parseArgs(argv) {
  const [command = 'report', ...rest] = argv
  const positional = []
  const flags = {}
  for (const arg of rest) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=')
      flags[key] = value === undefined ? true : value
    } else {
      positional.push(arg)
    }
  }
  const options = {}
  if (flags.revision !== undefined) options.revision = Number(flags.revision)
  if (flags.at !== undefined) options.at = Number(flags.at)
  if (flags['agenda-version'] !== undefined) options.agendaVersion = Number(flags['agenda-version'])
  return { command, positional, flags, options }
}

function line(char = '─', length = 72) {
  return char.repeat(length)
}

function printReport(result, validation) {
  console.log('赛事积分与邀约核对')
  console.log(line('='))
  if (!validation.ok) {
    console.log('数据引用错误：')
    for (const error of validation.errors) console.log(`  ! ${error}`)
  }

  console.log('\n【有效赛季排名】（按当前确认复议与最新修订）')
  let lastGroup = ''
  for (const s of result.standings) {
    const group = `${s.race}/${s.ageGroup}`
    if (group !== lastGroup) {
      console.log(`\n  ${group}  名额 ${s.quota ?? '-'}  最优 ${s.bestMeets} 站，最低有效站 ${s.requiredValidMeets}`)
      lastGroup = group
    }
    const quotaMark = s.insideQuota ? '名额内' : '名额外'
    const meetMark = s.meetsRequirement ? '站数达标' : `站数不足(${s.validMeetCount}/${s.requiredValidMeets})`
    console.log(
      `    #${s.seasonRank} ${s.crew.padEnd(7)} 积分${String(s.total).padStart(2)}  ${meetMark}  ${quotaMark}  证据 ${s.sourceEntries.join(', ')}`,
    )
  }

  console.log('\n【分站重排与合组警告】')
  for (const r of result.rankings.filter((x) => x.mergedPhysicalRankMismatch)) {
    console.log(
      `  ${r.meet} ${r.race}/${r.effectiveAgeGroup} ${r.entry} ${r.crew}：合组物理名次 ${r.physicalRank}，按年龄组有效成绩重排为第 ${r.rank}，积分 ${r.points}`,
    )
  }
  for (const r of result.rankings.filter((x) => !x.valid)) {
    console.log(`  ${r.meet} ${r.entry} ${r.crew}：${r.invalidReason}，不计有效成绩`)
  }
  for (const t of result.transferAudits) {
    console.log(`  转组核查 ${t.entry} ${t.originalGroup}→${t.requestedGroup}：${t.reason}`)
  }

  console.log('\n【邀约、答复与时间冲突】')
  for (const i of result.invitations) {
    const deadline =
      i.responseStatus === 'accepted'
        ? `规则期限 ${i.proofPeriod ?? '?'}；已接受/锁定席位不按待答复保留期处理，锁定截止需另有时间字段`
        : i.responseDeadline === null
          ? '答复截止时间缺通知时间'
          : `席位保留/答复截止 t=${i.responseDeadline}（时长 ${i.holdWindow}）`
    console.log(`  ${i.invitation} ${i.race} ${i.crew} [${i.rawState}/${i.protection}] => ${i.statusZh}`)
    console.log(`      依据：${i.basis ? `榜单#${i.basis.seasonRank}，${i.basis.total}分，有效站${i.basis.validMeetCount}/${i.basis.requiredValidMeets}` : '无排名'}；${deadline}`)
    for (const reason of i.reasons) console.log(`      · ${reason}`)
    for (const c of i.conflicts) {
      console.log(`      ⚠ 与 ${c.withInvitation} 在队员 ${c.athlete} 处时间重合（${c.severity}，政策：${c.policy}；既有确认均保留）`)
    }
  }

  console.log('\n【名额台账】')
  for (const l of result.quotaLedger) {
    console.log(
      `  ${l.race}/${l.ageGroup}：额度${l.quota}，已确认${l.confirmedCount}，锁定${l.lockedCount}，保留中${l.retentionHoldCount}，可新发${l.freeConfirmedSlots}；候补顺序 ${l.waitlistOrder.map((w) => w.invitation).join('、') || '无'}`,
    )
  }

  console.log('\n【替补核查】')
  for (const r of result.replacements) {
    console.log(`  ${r.boat} ${r.outgoing}→${r.candidate}：${r.ruleApproved ? '规则认可' : '不生效'}；${r.recommendation}`)
  }

  console.log('\n【候补何时确定】')
  for (const w of result.waitlists) {
    console.log(`  ${w.invitation}（有效榜次 #${w.effectiveRank}）：${w.fixedDeterminationTime === null ? '无单一固定时间' : `t=${w.fixedDeterminationTime}`}`)
    for (const condition of w.conditions) console.log(`      · ${condition}`)
    console.log(`      ${w.timeBasis}`)
  }

  console.log('\n【俱乐部团体积分】（每站先适用 scoring_slots）')
  for (const t of result.clubStandings.totals.sort((a, b) => b.total - a.total)) {
    console.log(`  ${t.club} ${t.race}：${t.total} 分，计入 ${t.countedResults.length} 个有效名次`)
  }
  console.log('  决赛奖励名额：')
  for (const b of result.bonusAudit.summaries) {
    console.log(`    ${b.club}/${b.race} ${b.used}/${b.limit}${b.overLimit ? ' 超额' : ''}`)
  }

  console.log('\n【暂挂账项】')
  if (!result.holds.length) console.log('  无')
  for (const h of result.holds) console.log(`  [${h.status}] ${h.account}：${h.reason}`)

  console.log('\n【已送达榜表可重现】')
  for (const t of result.issuedTables) {
    console.log(
      `  ${t.table} ${t.club}/${t.race} rev${t.revision} hash=${t.reproductionHash}：送达时俱乐部 ${t.correctionScope.publishedClubTotal}，当前重算 ${t.correctionScope.currentClubTotal}；原榜次保留`,
    )
  }
}

function printRankingTable(result, flags) {
  const rows = flags.revision !== undefined
    ? result.standings
    : result.standings
  for (const s of rows) {
    if (flags.race && s.race !== flags.race) continue
    if (flags['age-group'] && s.ageGroup !== flags['age-group']) continue
    console.log([s.race, s.ageGroup, `#${s.seasonRank}`, s.crew, s.total, `${s.validMeetCount}/${s.requiredValidMeets}`, s.insideQuota ? 'quota' : ''].join('\t'))
  }
}

async function main() {
  const { command, positional, flags, options } = parseArgs(process.argv.slice(2))
  const db = await loadDataset()
  const validation = validateReferences(db)
  const result = analyzeDataset(db, options)

  if (flags.json || command === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (command === 'rankings') {
    printRankingTable(result, flags)
    return
  }
  if (command === 'invitations') {
    const id = positional[0]
    const rows = id ? result.invitations.filter((i) => i.invitation === id) : result.invitations
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (command === 'waitlist') {
    const id = positional[0]
    const rows = id ? result.waitlists.filter((w) => w.invitation === id) : result.waitlists
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (command === 'athlete') {
    const id = positional[0]
    const rows = id ? result.athleteDashboard.filter((a) => a.athlete === id) : result.athleteDashboard
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (command === 'clubs') {
    console.log(JSON.stringify({ totals: result.clubStandings.totals, bonus: result.bonusAudit, holds: result.holds }, null, 2))
    return
  }
  if (command === 'corrections') {
    console.log(JSON.stringify(result.correctionImpacts, null, 2))
    return
  }
  if (command === 'tables') {
    const id = positional[0]
    const rows = id ? result.issuedTables.filter((t) => t.table === id) : result.issuedTables
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (command === 'validate') {
    console.log(JSON.stringify(validation, null, 2))
    if (!validation.ok) process.exitCode = 1
    return
  }
  if (command !== 'report') {
    console.error(`未知命令：${command}；可用 report|json|rankings|invitations|waitlist|athlete|corrections|clubs|tables|validate`)
    process.exitCode = 2
    return
  }
  printReport(result, validation)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
