export type Severity = 'error' | 'warning' | 'info'

export type ViewIssue = {
  severity: Severity
  code: string
  where: string
  message: string
  block: string
  at?: string
}

export type ViewInduction = {
  id: string
  intro: string
  over: string | null
  source: 'recorded' | 'matched' | null
  covered: number
  expected: number
  missing: string[]
}

export type ViewGroup = {
  id: string | null
  kind: string | null
  title: string
  label: string
  status: 'error' | 'warning' | 'ok'
  hasProof: boolean
  cites: string[]
  inductions: ViewInduction[]
  issues: ViewIssue[]
}

/** The `view` part of what `npm run check` prints in the proof-writer checkout. */
export type View = {
  errors: number
  warnings: number
  groups: ViewGroup[]
  rulesBlocks: { id: string; name: string }[]
}

/** What Claude made of a case analysis the checker could not place; `block` is null when it ranges over no rules block. */
export type Suggestion = { block: string | null; name: string; why: string; intro: string }

declare module 'claude-code' {
  interface PluginState {
    'proof-tracker': {
      file: string | null
      view: View | null
      error: string | null
      suggestions: Record<string, Suggestion>
    }
  }
}
