import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { IDLE_TIMEOUT_MS, WARNING_BEFORE_MS, useIdleTimeout } from './useIdleTimeout';

const WARNING_AT_MS = IDLE_TIMEOUT_MS - WARNING_BEFORE_MS;

describe('useIdleTimeout (audit 1.2)', () => {
  let logoutSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const originalLogout = useAuthStore.getState().logout;

  beforeEach(() => {
    vi.useFakeTimers();
    logoutSpy = vi.fn(async () => {
      useAuthStore.setState({ isAuthenticated: false });
    });
    useAuthStore.setState({ isAuthenticated: false, logout: logoutSpy });
  });

  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({ isAuthenticated: false, logout: originalLogout });
  });

  function login() {
    act(() => {
      useAuthStore.setState({ isAuthenticated: true });
    });
  }

  it('starts timers after a logged-out -> logged-in transition and warns', () => {
    const { result } = renderHook(() => useIdleTimeout());
    expect(result.current.showWarning).toBe(false);

    login();

    act(() => { vi.advanceTimersByTime(WARNING_AT_MS - 1); });
    expect(result.current.showWarning).toBe(false);

    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.showWarning).toBe(true);
    expect(result.current.secondsRemaining).toBe(WARNING_BEFORE_MS / 1000);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.secondsRemaining).toBe(WARNING_BEFORE_MS / 1000 - 5);

    act(() => { vi.advanceTimersByTime(WARNING_BEFORE_MS); });
    expect(logoutSpy).toHaveBeenCalledTimes(1);
    expect(result.current.showWarning).toBe(false);
  });

  it('does nothing while logged out', () => {
    const { result } = renderHook(() => useIdleTimeout());
    act(() => { vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2); });
    expect(result.current.showWarning).toBe(false);
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  it('user activity resets the idle timer and hides the warning', () => {
    const { result } = renderHook(() => useIdleTimeout());
    login();

    act(() => { vi.advanceTimersByTime(WARNING_AT_MS - 1000); });
    act(() => { window.dispatchEvent(new Event('keydown')); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.showWarning).toBe(false);

    act(() => { vi.advanceTimersByTime(WARNING_AT_MS - 1000); });
    expect(result.current.showWarning).toBe(true);

    act(() => { window.dispatchEvent(new Event('mousedown')); });
    expect(result.current.showWarning).toBe(false);
    act(() => { vi.advanceTimersByTime(WARNING_AT_MS - 1); });
    expect(result.current.showWarning).toBe(false);
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  it('logout clears the warning and all pending timers', () => {
    const { result } = renderHook(() => useIdleTimeout());
    login();
    act(() => { vi.advanceTimersByTime(WARNING_AT_MS); });
    expect(result.current.showWarning).toBe(true);

    act(() => { useAuthStore.setState({ isAuthenticated: false }); });
    expect(result.current.showWarning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    act(() => { vi.advanceTimersByTime(IDLE_TIMEOUT_MS); });
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  it('a fresh login after an external logout does not re-show a stale warning', () => {
    const { result } = renderHook(() => useIdleTimeout());
    login();
    act(() => { vi.advanceTimersByTime(WARNING_AT_MS); });
    expect(result.current.showWarning).toBe(true);

    act(() => { useAuthStore.setState({ isAuthenticated: false }); });
    login();
    expect(result.current.showWarning).toBe(false);
    act(() => { vi.advanceTimersByTime(WARNING_AT_MS); });
    expect(result.current.showWarning).toBe(true);
  });

  it('clears timers on unmount', () => {
    const { unmount } = renderHook(() => useIdleTimeout());
    login();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
