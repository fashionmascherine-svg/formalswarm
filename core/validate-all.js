#!/usr/bin/env node
'use strict'
/*
 * validate-all.js — run every offline suite in one process. Zero agent calls,
 * zero cost, no network: this is the gate that must be green before any real
 * debate is launched, and the regression net for the whole protocol.
 *
 *   node core/validate-all.js [--only body|driver|profile|generic]
 */

const SUITES = [
  ['body', () => require('./validate-body.js')],
  ['driver', () => require('./validate-driver.js')],
  ['profile', () => require('./validate-profile.js')],
  ['generic', () => require('./validate-generic.js')],
]

async function runAll(only) {
  const selected = SUITES.filter(([name]) => !only || name === only)
  if (selected.length === 0) throw new Error('unknown suite "' + only + '" (known: ' + SUITES.map((s) => s[0]).join(', ') + ')')
  const results = []
  for (const [name, load] of selected) {
    // eslint-disable-next-line global-require
    const result = await load().runAll()
    results.push(result)
    console.log((result.failed === 0 ? 'OK    ' : 'FAIL  ') + name.padEnd(8) + (result.total - result.failed) + '/' + result.total)
  }
  const total = results.reduce((n, r) => n + r.total, 0)
  const failed = results.reduce((n, r) => n + r.failed, 0)
  console.log('')
  console.log(failed === 0
    ? 'ALL SUITES GREEN — ' + total + ' checks'
    : failed + ' CHECK(S) FAILED out of ' + total)
  return { total: total, failed: failed }
}

module.exports = { runAll: runAll, SUITES: SUITES }

if (require.main === module) {
  const at = process.argv.indexOf('--only')
  const only = at >= 0 ? process.argv[at + 1] : undefined
  runAll(only)
    .then((r) => { process.exit(r.failed === 0 ? 0 : 1) })
    .catch((e) => { console.error('validate-all: ' + (e && e.message)); process.exit(1) })
}
