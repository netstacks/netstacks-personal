/**
 * Feed one line of an SSE stream into the parser.
 *
 * `currentEvent` is the event name seen on the most recent `event:` line;
 * the return value is the name to carry into the next call. `data:` lines
 * are dispatched with the current event name; a blank line ends the
 * message and resets it. Purely positional — never searches the line
 * list, so duplicate lines (e.g. repeated `data: ` output) can't be
 * mis-attributed to another stream.
 */
export function consumeSseLine(
  line: string,
  currentEvent: string,
  onData: (eventType: string, data: string) => void,
): string {
  if (line.startsWith('event: ')) {
    return line.slice(7).trim()
  }
  if (line.startsWith('data: ')) {
    onData(currentEvent, line.slice(6))
    return currentEvent
  }
  if (line === '' || line === '\r') {
    return ''
  }
  return currentEvent
}
