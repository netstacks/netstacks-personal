// frontend/src/components/WindowControls.tsx
import './WindowControls.css'

// Memoize the lazy import so rapid concurrent clicks share a single
// module load (and don't race the module loader).
let winPromise: ReturnType<typeof loadWin> | null = null
async function loadWin() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}
function win() {
  return (winPromise ??= loadWin())
}

export default function WindowControls() {
  return (
    <div className="window-controls" data-tauri-drag-region={undefined}>
      <button type="button" className="wc-btn" data-testid="win-minimize"
        title="Minimize" onClick={() => void win().then(w => w.minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4.5" width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button type="button" className="wc-btn" data-testid="win-maximize"
        title="Maximize" onClick={() => void win().then(w => w.toggleMaximize())}>
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>
      </button>
      <button type="button" className="wc-btn wc-close" data-testid="win-close"
        title="Close" onClick={() => void win().then(w => w.close())}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor"/></svg>
      </button>
    </div>
  )
}
