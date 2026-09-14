import type { ReactNode } from 'react';

/**
 * A labelled form row: the small uppercase caption above whatever control the
 * caller puts in it. Every setup page draws the same one, so it lives here
 * rather than being redeclared per page — six identical copies had already
 * accumulated, and the label styling drifted between them.
 *
 * Pair it with the `input` class (defined once in index.css) on the control:
 *   <Field label="Host"><input className="input" … /></Field>
 *
 * `compact` is the denser variant used inside the Sessions edit modal, where
 * the form sits in a dialog rather than on a full page.
 */
export function Field({ label, compact, children }: { label: string; compact?: boolean; children: ReactNode }) {
  return (
    <div>
      <label
        className={`block ${compact ? 'text-[10px] font-bold' : 'text-[11px] font-semibold'} uppercase tracking-wide text-gray-600 mb-1`}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
