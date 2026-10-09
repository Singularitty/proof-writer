import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Suggestion, View } from '../types'
import { editDelta, inferencePrompt, parseSuggestion, promptSection, setOver, summary } from './lib'

const PANE = 'proofs'
const file = atom({ plugin: 'proof-tracker', key: 'file' } as const, null)
const view = atom({ plugin: 'proof-tracker', key: 'view' } as const, null)
const error = atom({ plugin: 'proof-tracker', key: 'error' } as const, null)
const suggestions = atom({ plugin: 'proof-tracker', key: 'suggestions' } as const, {})

const USAGE = 'Usage: /proofs <document.json> to track a document, /proofs to show the pane, /proofs off to stop.'
const MARK = { error: '✗', warning: '!', ok: '✓', info: '·' } as const

// what the file looked like when it was last checked; lost on a reload, which only costs one re-check
let checkedMtime = -1
let isInferring = false

async function home($: EngineInterface) {
  return (await $.env.get('HOME')) ?? ''
}

/** The proof-writer checkout whose checker is run. */
async function checkout($: EngineInterface) {
  return (await $.env.get('PROOF_WRITER_DIR')) ?? `${await home($)}/Projects/proof-writer`
}

async function absolute($: EngineInterface, p: string) {
  return p.startsWith('/') ? p : p.startsWith('~/') ? (await home($)) + p.slice(1) : `${await $.session.cwd()}/${p}`
}

async function storeKey($: EngineInterface) {
  return `file:${await $.session.cwd()}`
}

/** Runs the checker on the tracked document and publishes the result. */
async function refresh($: EngineInterface): Promise<View | null> {
  const f = await read($, file)
  if (!f) return null
  try {
    checkedMtime = (await $.fs.stat(f)).mtimeMs
    const ran = await $.process.run(['node', '--import', 'tsx', 'src/check/cli.ts', f], { cwd: await checkout($) })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `the checker exited with ${ran.exitCode}`)
    const v = (JSON.parse(ran.stdout) as { view: View }).view
    await update($, view, () => v)
    await update($, error, () => null)
    $.ui.status(`proofs: ${summary(v)}`)
    return v
  } catch (e) {
    await update($, error, () => (e instanceof Error ? e.message : String(e)))
    $.ui.status('proofs: could not check')
    return null
  }
}

/** Asks the model about one case analysis the checker could not place. */
async function infer($: EngineInterface, v: View) {
  const f = await read($, file)
  if (!f || isInferring) return
  const known = await read($, suggestions)
  const next = v.groups.flatMap(g => g.inductions).find(i => !i.over && known[i.id]?.intro !== i.intro)
  if (!next) return
  isInferring = true
  try {
    const prompt = inferencePrompt(await $.fs.read(f), next.id)
    const r = prompt ? await $.model.complete({ model: 'sonnet', prompt, timeoutMs: 60000 }) : null
    const s: Suggestion = (r?.isAnswered && parseSuggestion(r.text, v.rulesBlocks, next.intro)) || { block: null, name: '', why: '', intro: next.intro }
    await update($, suggestions, all => ({ ...all, [next.id]: s }))
  } finally {
    isInferring = false
  }
}

async function tick($: EngineInterface) {
  const f = await read($, file)
  if (!f) return
  let mtime = -1
  try {
    mtime = (await $.fs.stat(f)).mtimeMs
  } catch {
    // the file is gone for now (mid-save, or a branch switch); keep the last report
    return
  }
  const v = mtime === checkedMtime ? await read($, view) : await refresh($)
  if (v) await infer($, v)
}

async function track($: EngineInterface, path: string | null) {
  await update($, file, () => path)
  await update($, view, () => null)
  await update($, error, () => null)
  await update($, suggestions, () => ({}))
  checkedMtime = -1
  if (path) await $.store.set(await storeKey($), path)
  else {
    await $.store.delete(await storeKey($))
    $.ui.status(undefined)
  }
}

/** After an edit to the tracked document: what the edit fixed and broke, for Claude to read. */
async function editNote($: EngineInterface, edited: string): Promise<string | null> {
  const f = await read($, file)
  if (!f || (await absolute($, edited)) !== f) return null
  const before = await read($, view)
  const after = await refresh($)
  return after ? editDelta(before, after) : null
}

async function accept($: EngineInterface, casesId: string, block: string) {
  const f = await read($, file)
  if (!f) return
  const text = setOver(await $.fs.read(f), casesId, block)
  if (!text) return
  await $.fs.write(f, text)
  await update($, suggestions, ({ [casesId]: _done, ...rest }) => rest)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'proofs', description: 'Track a Proof Writer document: /proofs <document.json>' })
    const remembered = await $.store.get(await storeKey($))
    if (typeof remembered === 'string' && (await read($, file)) === null) await update($, file, () => remembered)
    void $.clock.every(2000, () => tick($))

    return next(e)
  })

  on('command.run', { command: 'proofs' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await track($, null)

      return { text: 'Stopped tracking.' }
    }
    if (arg) {
      const path = await absolute($, arg)
      if (!(await $.fs.exists(path))) return { text: `No file at ${path}.` }
      await track($, path)
    }
    const f = await read($, file)
    if (!f) return { text: USAGE }
    const v = await refresh($)
    await $.ui.open({ id: PANE, title: 'Proofs' })

    return { text: v ? `Tracking ${f}: ${summary(v)}.` : `Tracking ${f}, but it could not be checked: ${await read($, error)}` }
  })

  // After Claude edits the tracked document, it is told what the edit fixed and broke.
  // A failure here never stands in the way of the edit.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const note = await editNote($, e.file_path)

    return note === null ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const note = await editNote($, e.file_path)

    return note === null ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const f = await read($, file)
    const v = await read($, view)
    if (!f || !v) return composed

    return { sections: [...composed.sections, { id: 'proof-tracker:state', text: promptSection(f, v), scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const f = await read($, file)
    const v = await read($, view)
    const problem = await read($, error)
    const suggested = await read($, suggestions)

    if (!f) return <Text dimColor>{USAGE}</Text>

    const dismiss = (casesId: string) => update($, suggestions, all => ({ ...all, [casesId]: { ...all[casesId]!, block: null } }))

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-start">{f}</Text>
        {problem !== null && <Text color="error">Could not check: {problem}</Text>}
        {v !== null && (
          <Text bold color={v.errors ? 'error' : v.warnings ? 'warning' : 'success'}>
            {summary(v)}
          </Text>
        )}
        {v?.groups.map(g => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              <Text color={g.status === 'error' ? 'error' : g.status === 'warning' ? 'warning' : 'success'}>{MARK[g.status]}</Text> {g.title}
            </Text>
            {g.inductions.map(i => {
              const s = suggested[i.id]
              const suggestedBlock = !i.over && s?.intro === i.intro ? s.block : null

              return (
                <Box flexDirection="column">
                  <Text dimColor>
                    {'  '}
                    {i.over
                      ? `cases: ${i.covered} of ${i.expected} rules${i.missing.length ? `, missing ${i.missing.join(', ')}` : ''}${i.source === 'matched' ? ' (matched)' : ''}`
                      : 'cases: coverage not checked'}
                  </Text>
                  {suggestedBlock !== null && (
                    <Box>
                      <Text>{'  '}Claude suggests: over {s!.name}. </Text>
                      <Button key={`accept-${i.id}`} label="Accept" variant="primary" onPress={() => accept($, i.id, suggestedBlock)} />
                      <Text> </Text>
                      <Button key={`dismiss-${i.id}`} label="Dismiss" onPress={() => dismiss(i.id)} />
                    </Box>
                  )}
                </Box>
              )
            })}
            {g.issues.map(i => (
              <Text dimColor={i.severity === 'info'}>
                {'  '}
                <Text color={i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'subtle'}>{MARK[i.severity]}</Text> {i.where}: {i.message}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
