import type { Suggestion, View } from '../types'

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function summary(view: View): string {
  const parts = [view.errors && count(view.errors, 'error'), view.warnings && count(view.warnings, 'warning')].filter(Boolean)
  return parts.length ? parts.join(', ') : 'no problems found'
}

/** One line per open error or warning, keyed so two reports can be compared. */
export function openIssues(view: View): Map<string, string> {
  const out = new Map<string, string>()
  for (const g of view.groups) {
    for (const i of g.issues) {
      if (i.severity === 'info') continue
      const line = `${g.title}, ${i.where}: ${i.message}`
      out.set(`${i.code}|${line}`, line)
    }
  }
  return out
}

/** What Claude reads in its system prompt while a document is tracked. */
export function promptSection(file: string, view: View): string {
  const lines = [
    `# Proof tracker`,
    `The Proof Writer document ${file} is being checked automatically. Current state: ${summary(view)}.`,
  ]
  for (const g of view.groups) {
    const open = g.issues.filter(i => i.severity !== 'info')
    const cases = g.inductions.filter(i => i.over).map(i => `${i.covered} of ${i.expected} rules have a case`)
    if (!open.length && !cases.length) continue
    lines.push(`- ${g.title}${cases.length ? ` (${cases.join('; ')})` : ''}`)
    for (const i of open.slice(0, 12)) lines.push(`  - ${i.severity}, ${i.where}: ${i.message}`)
    if (open.length > 12) lines.push(`  - and ${open.length - 12} more`)
  }
  lines.push(
    `Do not describe a statement as proved, finished or complete while it has an error listed here. ` +
      `These checks cover structure only (references, case coverage, proof trees); they say nothing about whether the prose of a proof is correct.`,
  )
  return lines.join('\n')
}

/** What Claude reads after it edits the tracked document. */
export function editDelta(before: View | null, after: View): string {
  const was = before ? openIssues(before) : new Map<string, string>()
  const now = openIssues(after)
  const fixed = [...was].filter(([k]) => !now.has(k)).map(([, v]) => v)
  const fresh = [...now].filter(([k]) => !was.has(k)).map(([, v]) => v)
  const lines = [`Proof tracker after this edit: ${summary(after)}.`]
  if (fresh.length) lines.push('New:', ...fresh.map(l => `- ${l}`))
  if (fixed.length) lines.push('Fixed:', ...fixed.map(l => `- ${l}`))
  if (!fresh.length && !fixed.length && now.size) lines.push('Nothing changed in the open problems.')
  return lines.join('\n')
}

type AnyBlock = { id: string; type: string; [k: string]: unknown }
type CaseItem = { id: string; title: string; body: AnyBlock[] }

function findCases(blocks: AnyBlock[], id: string, owner: AnyBlock | null): { block: AnyBlock; owner: AnyBlock | null } | null {
  for (const b of blocks) {
    if (b.id === id && b.type === 'cases') return { block: b, owner }
    if (b.type === 'theorem' && Array.isArray(b.proof)) {
      const r = findCases(b.proof as AnyBlock[], id, b)
      if (r) return r
    }
    if (b.type === 'cases') {
      for (const c of b.cases as CaseItem[]) {
        const r = findCases(c.body, id, owner)
        if (r) return r
      }
    }
  }
  return null
}

function rulesBlocks(blocks: AnyBlock[], out: AnyBlock[] = []): AnyBlock[] {
  for (const b of blocks) {
    if (b.type === 'rules') out.push(b)
    if (b.type === 'theorem' && Array.isArray(b.proof)) rulesBlocks(b.proof as AnyBlock[], out)
    if (b.type === 'cases') for (const c of b.cases as CaseItem[]) rulesBlocks(c.body, out)
  }
  return out
}

/** The question put to the model about one case analysis, or null if the document no longer holds it. */
export function inferencePrompt(docText: string, casesId: string): string | null {
  let doc: { blocks: AnyBlock[]; snippets?: { kind: string; name: string; body: string }[] }
  try {
    doc = JSON.parse(docText)
  } catch {
    return null
  }
  const found = findCases(doc.blocks, casesId, null)
  if (!found) return null
  const rules = rulesBlocks(doc.blocks).map(b => ({
    id: b.id,
    title: b.title,
    judgment: b.judgment,
    rules: (b.rules as { name: string }[]).map(r => r.name),
  }))
  return [
    'A proof in a programming-languages paper contains a case analysis. Decide which set of inference rules it ranges over: that is, the judgment whose derivation the proof is by induction or case analysis on.',
    '',
    `Statement being proved: ${found.owner ? String(found.owner.statement) : '(none)'}`,
    `Intro of the case analysis: ${String(found.block.intro)}`,
    `Case titles: ${(found.block.cases as CaseItem[]).map(c => c.title).join(' | ')}`,
    '',
    'Math is LaTeX. Text snippets written {{name}} and math macros used above:',
    JSON.stringify((doc.snippets ?? []).map(s => ({ kind: s.kind, name: s.name, body: s.body }))),
    '',
    'The rules blocks of the document:',
    JSON.stringify(rules),
    '',
    'Answer with one JSON object and nothing else: {"block": "<id of a rules block>", "why": "<one short sentence>"}.',
    'If the analysis is not over the rules of any block (a split on a value, or induction on the structure of a term or type), answer {"block": null, "why": "..."}.',
  ].join('\n')
}

/** Reads the model's answer; null when it is not usable. */
export function parseSuggestion(reply: string, blocks: View['rulesBlocks'], intro: string): Suggestion | null {
  const m = /\{[\s\S]*\}/.exec(reply)
  if (!m) return null
  try {
    const v = JSON.parse(m[0]) as { block?: unknown; why?: unknown }
    const why = typeof v.why === 'string' ? v.why.slice(0, 200) : ''
    if (v.block === null) return { block: null, name: '', why, intro }
    const b = blocks.find(x => x.id === v.block)
    return b ? { block: b.id, name: b.name, why, intro } : null
  } catch {
    return null
  }
}

/** The document text with the case analysis recorded as ranging over `block`, written as the app saves it. */
export function setOver(docText: string, casesId: string, block: string): string | null {
  try {
    const doc = JSON.parse(docText) as { blocks: AnyBlock[] }
    const found = findCases(doc.blocks, casesId, null)
    if (!found) return null
    found.block.over = { kind: 'rules', block }
    return JSON.stringify(doc, null, 2)
  } catch {
    return null
  }
}
