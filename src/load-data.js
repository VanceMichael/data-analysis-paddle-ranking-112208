import { readFile } from 'node:fs/promises'

export const TABLE_NAMES = [
  'entries',
  'rules',
  'offers',
  'replacements',
  'quota_rules',
  'appeals',
  'roster',
  'replies',
  'agenda',
  'roster_terms',
  'affiliations',
  'club_limits',
  'issued_tables',
]

export async function loadDataset(dataDir = new URL('../data/', import.meta.url)) {
  const db = {}
  await Promise.all(
    TABLE_NAMES.map(async (name) => {
      const url = new URL(`${name}.json`, dataDir)
      db[name] = JSON.parse(await readFile(url, 'utf8'))
    }),
  )
  return db
}

/** Reference validation in addition to the source-shape test. */
export function validateReferences(db) {
  const errors = []
  const warnings = []
  const entryIds = new Set(db.entries?.map((row) => row.entry) ?? [])
  const invitationIds = new Set(db.offers?.map((row) => row.invitation) ?? [])
  const athleteIds = new Set(db.roster?.map((row) => row.athlete) ?? [])
  const boatIds = new Set(db.entries?.map((row) => row.boat) ?? [])
  const raceIds = new Set(db.rules?.map((row) => row.race) ?? [])

  for (const appeal of db.appeals ?? []) {
    if (!entryIds.has(appeal.entry)) errors.push(`appeals references missing entry ${appeal.entry}`)
  }
  for (const reply of db.replies ?? []) {
    if (!invitationIds.has(reply.invitation)) {
      errors.push(`replies references missing invitation ${reply.invitation}`)
    }
    if (!athleteIds.has(reply.athlete)) warnings.push(`reply athlete ${reply.athlete} is absent from roster`)
  }
  for (const replacement of db.replacements ?? []) {
    if (!boatIds.has(replacement.boat)) errors.push(`replacement references missing boat ${replacement.boat}`)
    if (!athleteIds.has(replacement.candidate)) {
      warnings.push(`replacement candidate ${replacement.candidate} is absent from roster`)
    }
  }
  for (const offer of db.offers ?? []) {
    if (!raceIds.has(offer.race)) errors.push(`offer ${offer.invitation} references missing race ${offer.race}`)
  }
  for (const agenda of db.agenda ?? []) {
    if (!raceIds.has(agenda.race)) errors.push(`agenda references missing race ${agenda.race}`)
  }
  return { ok: errors.length === 0, errors, warnings }
}
