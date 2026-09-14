import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Copies a value to the clipboard and says so for a moment. Used for the
 * things an installer has to re-type somewhere else — a camera's webhook URL,
 * a terminal's callback address.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold text-gray-500 hover:text-gray-900"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
