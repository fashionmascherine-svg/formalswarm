/**
 * The DeepSeek Harness row of FormalSwarm.
 *
 * Registers the FormalSwarm protocol as a runtime skill on `ctx.skills`, so a
 * session on this harness learns the protocol the same way it learns any other
 * capability. The skill body ships as `skills/formalswarm/SKILL.md`; the deep
 * dives beside it (`references/`) are exposed as directory resources, so the
 * loaded skill can point the model at exactly the file it needs.
 *
 * This row publishes no service and reads no repository: it is a pure document
 * capability, which is why the bundle patch does not wrap it in an isolate realm.
 * Everything executable lives in `core/` and is invoked through the bash tool,
 * identically on DeepSeek Harness, Claude Code and ZCode.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'formalswarm-skills'
export const inject = ['skills']

const SKILL_NAME = 'formalswarm'
const SKILL_DESCRIPTION =
  'Repo-agnostic multi-agent validation protocol: independent thesis writers, adversarial critics, ' +
  'and a seal whose verdict is computed deterministically from real command exit codes, case counts ' +
  'and check coverage — never from an agent\'s prose. Ships a repository profiler, a single workflow ' +
  'body shared by DeepSeek Harness, Claude Code and ZCode, and a round driver for runtimes without a ' +
  'workflow tool.'
const SKILL_WHEN_TO_USE =
  'Use when a proposed change, a refactor, an audit, or any technical claim about a repository must be ' +
  'validated before it is applied, when a verdict must be backed by commands that were actually run, ' +
  'or when the user asks for a debate, an adversarial review, a seal, or a fail-closed verification of ' +
  'someone else\'s (or the agent\'s own) work.'

/** Absolute directory of the bundled skill, used as its resource base. */
const skillDir = fileURLToPath(new URL('../skills/formalswarm/', import.meta.url))

export function apply(ctx, config) {
  const settings = config || {}
  if (settings.skills === false) return undefined
  const log = ctx.logger || console
  let body
  try {
    // Read at apply time so a config change or HMR re-reads the shipped file.
    body = readFileSync(skillDir + 'SKILL.md', 'utf8')
  } catch (error) {
    log.warn('formalswarm-skills: bundled SKILL.md unreadable, skill not registered: %s', error)
    return undefined
  }
  const disposer = ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    source: 'runtime',
    content: body,
    resourceBase: { kind: 'directory', path: skillDir },
  })
  log.info('formalswarm-skills: registered runtime skill "%s"', SKILL_NAME)
  return disposer
}
