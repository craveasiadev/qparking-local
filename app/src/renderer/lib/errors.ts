/**
 * Turn an error thrown by a bridge (IPC) call into something worth showing an
 * operator.
 *
 * Electron wraps anything the main process throws, so `e.message` arrives as:
 *
 *   Error invoking remote method 'sessions:update': Error: plate_in_use — ABC123 is …
 *
 * The operator needs the last clause; the rest is plumbing that makes a real
 * message look like a crash. The leading `snake_case_code —` is also dropped: it
 * exists so callers can branch on it, and reads as noise in a form banner.
 */
export function bridgeErrorMessage(error: unknown): string {
  const raw = (error as any)?.message ?? String(error);

  // Strip Electron's wrapper, then any stacked "Error:" prefixes it leaves behind.
  let message = String(raw)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Error:\s*)+/, '')
    .trim();

  // `code — human sentence` → keep the sentence. Only when a human sentence
  // actually follows, so a bare code still shows rather than becoming blank.
  const coded = message.match(/^([a-z0-9_]+)\s+—\s+(.*)$/s);
  if (coded && coded[2].trim()) {
    message = coded[2].trim();
  }

  return message || 'Something went wrong.';
}
