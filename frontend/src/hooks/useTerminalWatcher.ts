// Buffers recent terminal output so AI features can pull it on demand.
//
// Maintains a ring buffer of recent lines plus a monotonic offset counter
// so the AI can request only new output since its last read (delta-based).

import { useCallback, useMemo, useRef } from 'react';
import type { TerminalContext } from '../api/ai';
import { stripAnsi } from '../lib/ansi';

interface UseTerminalWatcherOptions {
  bufferLines?: number;  // Lines to keep in buffer (default 50)
}

export interface TerminalWatcherDelta {
  recentOutput: string;
  offset: number;
  totalLines: number;
}

export function useTerminalWatcher(options: UseTerminalWatcherOptions = {}) {
  const { bufferLines = 50 } = options;
  const bufferRef = useRef<string[]>([]);
  const offsetRef = useRef<number>(0);

  const addOutput = useCallback((output: string) => {
    const lines = output.split('\n');
    bufferRef.current = [...bufferRef.current, ...lines].slice(-bufferLines);
    offsetRef.current += lines.length;
  }, [bufferLines]);

  const getContext = useCallback((): TerminalContext => {
    return { recentOutput: stripAnsi(bufferRef.current.join('\n')) };
  }, []);

  const getContextSince = useCallback((sinceOffset: number): TerminalWatcherDelta => {
    const currentOffset = offsetRef.current;
    const totalInBuffer = bufferRef.current.length;

    const linesSinceOffset = currentOffset - sinceOffset;
    if (linesSinceOffset <= 0) {
      return { recentOutput: '', offset: currentOffset, totalLines: 0 };
    }

    const linesToReturn = Math.min(linesSinceOffset, totalInBuffer);
    const newLines = bufferRef.current.slice(-linesToReturn);

    return {
      recentOutput: stripAnsi(newLines.join('\n')),
      offset: currentOffset,
      totalLines: linesToReturn,
    };
  }, []);

  const getCurrentOffset = useCallback(() => offsetRef.current, []);

  const clear = useCallback(() => {
    bufferRef.current = [];
  }, []);

  return useMemo(
    () => ({ addOutput, getContext, getContextSince, clear, getCurrentOffset }),
    [addOutput, getContext, getContextSince, clear, getCurrentOffset]
  );
}
