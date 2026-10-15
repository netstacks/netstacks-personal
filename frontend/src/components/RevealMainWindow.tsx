import { useEffect } from 'react'
import { isTauri, revealMainWindow } from '../lib/nativeWindow'

/** Shows the hidden main window once React has committed its first tree,
 *  whatever that tree is (vault unlock, login, or the shell). */
export default function RevealMainWindow() {
  useEffect(() => {
    if (isTauri()) void revealMainWindow()
  }, [])
  return null
}
