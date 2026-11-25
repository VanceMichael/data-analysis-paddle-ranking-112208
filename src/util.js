export function parseValue(value) {
  if (value === '?') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value)
  }
  return value
}

export function parseBool(value) {
  if (typeof value === 'boolean') return value
  return value === 'true'
}

export function parseNumber(value) {
  if (value === null || value === undefined || value === '?') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function membersOf(value) {
  return String(value ?? '')
    .split('+')
    .map((member) => member.trim())
    .filter(Boolean)
}

/** Order-independent key for a crew or pair. */
export function crewKey(members) {
  const list = Array.isArray(members) ? members : membersOf(members)
  return [...list].sort().join('+')
}

export function stageOrder(stage, meets = []) {
  if (stage === '决赛') return Number.MAX_SAFE_INTEGER
  const known = meets.indexOf(stage)
  if (known >= 0) return known + 1
  const n = parseNumber(String(stage).replace(/^M/, ''))
  return n ?? Number.MAX_SAFE_INTEGER - 1
}

export function groupBy(rows, keyFn) {
  const map = new Map()
  for (const row of rows) {
    const key = keyFn(row)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  return map
}

export function maxRevision(rows) {
  return rows.reduce((max, row) => Math.max(max, parseNumber(row.rev) ?? 0), 0)
}

export function selectRevision(entries, revision = Number.POSITIVE_INFINITY) {
  const byEntry = new Map()
  for (const row of entries) {
    const rev = parseNumber(row.rev) ?? 1
    if (rev > revision) continue
    const current = byEntry.get(row.entry)
    if (!current || rev > (parseNumber(current.rev) ?? 0)) {
      byEntry.set(row.entry, row)
    }
  }
  return [...byEntry.values()]
}

export function previousRevision(entries, entryId, revision) {
  return entries
    .filter((row) => row.entry === entryId && (parseNumber(row.rev) ?? 0) < revision)
    .sort((a, b) => (parseNumber(b.rev) ?? 0) - (parseNumber(a.rev) ?? 0))[0]
}

export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd
}

export function stableSort(rows, compare) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compare(a.row, b.row) || a.index - b.index)
    .map(({ row }) => row)
}
