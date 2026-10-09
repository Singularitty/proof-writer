/**
 * What to do when the file behind the open document changes on disk:
 * nothing if it holds what we last saved or read, reload if there is nothing
 * to lose, otherwise ask.
 */
export function externalChange(s: { disk: string; saved: string | null; dirty: boolean }): 'ignore' | 'reload' | 'ask' {
  if (s.disk === s.saved) return 'ignore';
  return s.dirty ? 'ask' : 'reload';
}
