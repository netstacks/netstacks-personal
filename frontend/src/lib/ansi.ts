/** Strip ANSI escape codes from terminal output */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally matches ESC (\x1b) and BEL (\x07) to strip ANSI escape sequences.
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[?]?[0-9;]*[hlm]|\x1b[()][012AB]/g, '')
}
