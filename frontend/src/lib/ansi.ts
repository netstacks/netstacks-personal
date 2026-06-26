/** Strip ANSI escape codes from terminal output */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[\?]?[0-9;]*[hlm]|\x1b[()][012AB]/g, '')
}
