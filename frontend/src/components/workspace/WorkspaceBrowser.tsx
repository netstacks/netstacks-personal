import { useState, useCallback, useRef } from 'react'

interface WorkspaceBrowserProps {
  initialUrl: string
}

export default function WorkspaceBrowser({ initialUrl }: WorkspaceBrowserProps) {
  const [url, setUrl] = useState(initialUrl)
  const [inputUrl, setInputUrl] = useState(initialUrl)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const handleNavigate = useCallback(() => {
    let target = inputUrl.trim()
    if (target && !target.startsWith('http://') && !target.startsWith('https://') && !target.startsWith('about:')) {
      target = 'http://' + target
    }
    setUrl(target)
  }, [inputUrl])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleNavigate()
  }, [handleNavigate])

  return (
    <div className="workspace-browser">
      <div className="workspace-browser-toolbar">
        <button className="workspace-browser-nav-btn" onClick={() => iframeRef.current?.contentWindow?.history.back()}>
          ◀
        </button>
        <button className="workspace-browser-nav-btn" onClick={() => iframeRef.current?.contentWindow?.history.forward()}>
          ▶
        </button>
        <button className="workspace-browser-nav-btn" onClick={() => iframeRef.current?.contentWindow?.location.reload()}>
          ⟳
        </button>
        <input
          className="workspace-browser-url"
          value={inputUrl}
          onChange={e => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleNavigate}
        />
      </div>
      <iframe
        ref={iframeRef}
        className="workspace-browser-frame"
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  )
}
