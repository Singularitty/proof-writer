import { useState } from 'react';
import { Math } from './Math';
import { ProseView } from './ProseView';
import { SmartTextarea } from './SmartTextarea';

interface MathFieldProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  display?: boolean;
  className?: string;
  /** Start in edit mode (e.g. right after creating an empty field). */
  startEditing?: boolean;
  onDone?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** A LaTeX math field: rendered with KaTeX, click to edit the source. */
export function MathField({ value, onChange, placeholder, display, className, startEditing, onDone, onKeyDown }: MathFieldProps) {
  const [editing, setEditing] = useState(!!startEditing);
  if (editing) {
    return (
      <span className={'mathfield editing ' + (className ?? '')}>
        <SmartTextarea
          kind="math"
          value={value}
          onChange={onChange}
          autoFocus
          singleLine
          placeholder={placeholder ?? 'LaTeX math'}
          onBlur={() => { setEditing(false); onDone?.(); }}
          onKeyDown={onKeyDown}
        />
        {value.trim() && <span className="live"><Math tex={value} display={display} /></span>}
      </span>
    );
  }
  return (
    <span
      className={'mathfield ' + (value.trim() ? '' : 'empty ') + (className ?? '')}
      tabIndex={0}
      title="Click to edit"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setEditing(true); } }}
    >
      {value.trim() ? <Math tex={value} display={display} /> : <span className="placeholder">{placeholder ?? 'click to write math'}</span>}
    </span>
  );
}

interface ProseFieldProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inline?: boolean;
  className?: string;
  startEditing?: boolean;
}

/** Prose with $math$, **bold**, *italic*, [[refs]] and {{snippets}}: rendered, click to edit. */
export function ProseField({ value, onChange, placeholder, inline, className, startEditing }: ProseFieldProps) {
  const [editing, setEditing] = useState(!!startEditing);
  if (editing) {
    return (
      <div className={'prosefield editing ' + (className ?? '')}>
        <SmartTextarea
          kind="prose"
          value={value}
          onChange={onChange}
          autoFocus
          singleLine={inline}
          minRows={inline ? 1 : 2}
          placeholder={placeholder ?? 'Text with $math$, **bold**, *italic*, [[references]], {{snippets}}'}
          onBlur={() => setEditing(false)}
        />
      </div>
    );
  }
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag
      className={'prosefield ' + (value.trim() ? '' : 'empty ') + (className ?? '')}
      tabIndex={0}
      onClick={(e) => { if ((e.target as HTMLElement).closest('a')) return; e.stopPropagation(); setEditing(true); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setEditing(true); } }}
    >
      {value.trim() ? <ProseView text={value} inline={inline} /> : <span className="placeholder">{placeholder ?? 'Click to write…'}</span>}
    </Tag>
  );
}

/** A plain single-line text input that commits on every keystroke. */
export function TextInput({ value, onChange, placeholder, className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <input
      autoFocus={autoFocus}
      className={'textinput ' + (className ?? '')}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
    />
  );
}
