// UI-mock test hooks installed on window by src/mocks/testHooks.ts; shared with e2e/.
interface Window {
  __ns?: { confirm: () => Promise<boolean> }
}
