import { expect, test } from 'claude-code/testing'

import type { View } from '../types'
import { editDelta, inferencePrompt, parseSuggestion, promptSection, setOver, summary } from './lib'

const view = (issues: View['groups'][0]['issues'], missing: string[] = []): View => ({
  errors: issues.filter(i => i.severity === 'error').length,
  warnings: issues.filter(i => i.severity === 'warning').length,
  rulesBlocks: [{ id: 'r1', name: 'Typing' }],
  groups: [
    {
      id: 's1', kind: 'theorem', title: 'Progress', label: 'thm:progress', status: issues.length ? 'error' : 'ok', hasProof: true, cites: [],
      inductions: [{ id: 'c1', intro: 'By induction.', over: 'r1', source: 'matched', covered: 2 - missing.length, expected: 2, missing }],
      issues,
    },
  ],
})
const missing = { severity: 'error' as const, code: 'missing-case', where: 'case analysis', message: 'No case for T-If', block: 'c1' }
const dangling = { severity: 'error' as const, code: 'dangling-ref', where: 'case T-App', message: '[[lem:x]] does not name a statement or a rule', block: 't1' }

const doc = JSON.stringify({
  version: 1, snippets: [],
  blocks: [
    { id: 'r1', type: 'rules', title: 'Typing', judgment: 'G |- e : t', rules: [{ id: 'a', name: 'T-If' }] },
    { id: 's1', type: 'theorem', statement: 'Well-typed terms do not get stuck.', proof: [{ id: 'c1', type: 'cases', intro: 'By induction on typing.', cases: [{ id: 'k1', title: 'T-If', body: [] }] }] },
  ],
})

test('summarises a clean document and a broken one', () => {
  expect(summary(view([]))).toBe('no problems found')
  expect(summary(view([missing, dangling]))).toBe('2 errors')
})

test('the prompt section lists open problems under their statement and tells Claude not to call it proved', () => {
  const text = promptSection('/p/doc.json', view([missing], ['T-If']))
  expect(text).toContain('/p/doc.json')
  expect(text).toContain('- Progress (1 of 2 rules have a case)')
  expect(text).toContain('error, case analysis: No case for T-If')
  expect(text).toContain('Do not describe a statement as proved')
})

test('an edit that fixes one problem and adds another reports both', () => {
  const text = editDelta(view([missing]), view([dangling]))
  expect(text).toContain('New:\n- Progress, case T-App: [[lem:x]]')
  expect(text).toContain('Fixed:\n- Progress, case analysis: No case for T-If')
})

test('an edit that changes nothing says so', () => {
  expect(editDelta(view([missing]), view([missing]))).toContain('Nothing changed')
})

test('the inference question carries the statement, the intro and the rules blocks', () => {
  const q = inferencePrompt(doc, 'c1')!
  expect(q).toContain('Well-typed terms do not get stuck.')
  expect(q).toContain('By induction on typing.')
  expect(q).toContain('"id":"r1"')
  expect(inferencePrompt(doc, 'nope')).toBe(null)
})

test('reads a suggestion, a decline, and refuses an unknown block', () => {
  const blocks = [{ id: 'r1', name: 'Typing' }]
  expect(parseSuggestion('Sure: {"block": "r1", "why": "typing derivation"}', blocks, 'i')).toEqual({ block: 'r1', name: 'Typing', why: 'typing derivation', intro: 'i' })
  expect(parseSuggestion('{"block": null, "why": "split on a boolean"}', blocks, 'i')?.block).toBe(null)
  expect(parseSuggestion('{"block": "zz", "why": ""}', blocks, 'i')).toBe(null)
  expect(parseSuggestion('no idea', blocks, 'i')).toBe(null)
})

test('accepting records the rules block on the case analysis and nothing else', () => {
  const out = JSON.parse(setOver(doc, 'c1', 'r1')!)
  expect(out.blocks[1].proof[0].over).toEqual({ kind: 'rules', block: 'r1' })
  delete out.blocks[1].proof[0].over
  expect(out).toEqual(JSON.parse(doc))
  expect(setOver(doc, 'nope', 'r1')).toBe(null)
})
