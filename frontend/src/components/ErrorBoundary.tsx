import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', gap: '12px', padding: '24px', fontFamily: 'monospace',
          background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)',
        }}>
          <div style={{ fontSize: '18px', fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: '13px', opacity: 0.6, maxWidth: '480px', textAlign: 'center' }}>
            {this.state.error.message}
          </div>
          <button
            className="ns-btn ns-btn--primary ns-btn--large"
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: '8px' }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
