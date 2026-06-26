/**
 * PopoutAIChat — standalone AI chat for a popped-out window (the floating chat).
 *
 * Renders the AI side panel in its full 'tab' variant. NOTE: a separate window
 * can't reach the MAIN window's open terminals, so the terminal capability
 * callbacks (run_command, terminal context, etc.) are intentionally absent —
 * this chat does general + backend-driven work (SSH to devices via the agent,
 * etc.). The chat backend connection is established by initializeClient() in
 * main.tsx's bootstrap.
 */
import AISidePanel from './AISidePanel';

export default function PopoutAIChat() {
  return (
    <div style={{ height: '100vh', overflow: 'hidden' }}>
      <AISidePanel variant="tab" isOpen onClose={() => {}} />
    </div>
  );
}
