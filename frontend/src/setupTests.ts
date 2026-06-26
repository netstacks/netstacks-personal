import '@testing-library/jest-dom'

// Mock DOM APIs that Monaco expects but jsdom doesn't implement.
// defineProperty avoids the `as any` cast — window.matchMedia is a
// read-only getter in TS's Window type but we genuinely need to override
// it for tests, so go through the descriptor API instead.
document.queryCommandSupported = () => false
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }),
})
