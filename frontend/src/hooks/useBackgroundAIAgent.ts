/**
 * useBackgroundAIAgent - Wrapper for running AI agent in background
 *
 * Streams progress to callbacks instead of managing UI messages.
 * Used for topology enrichment where the AI side panel shouldn't open.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAIAgent, type UseAIAgentOptions, type AgentMessage } from './useAIAgent';
import type { AIProgressLog } from '../components/AIProgressPanel';

export interface BackgroundAIProgress {
  isRunning: boolean;
  currentTask: string;
  logs: AIProgressLog[];
  progress: number;
  messages: AgentMessage[]; // Stored for transfer to AI panel
}

export interface UseBackgroundAIAgentOptions extends UseAIAgentOptions {
  onProgress?: (progress: BackgroundAIProgress) => void;
  onComplete?: (messages: AgentMessage[]) => void;
}

export function useBackgroundAIAgent(options: UseBackgroundAIAgentOptions = {}) {
  const { onProgress, onComplete, ...agentOptions } = options;

  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<AIProgressLog[]>([]);
  const [currentTask, setCurrentTask] = useState('');
  const [progress, setProgress] = useState(0);
  const lastMessageCountRef = useRef(0);

  // Store callbacks in refs to avoid re-firing effects when callers pass inline functions
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  // Use the core AI agent hook
  const agent = useAIAgent({
    provider: 'anthropic', // Default provider for token tracking
    ...agentOptions,
    // Always use auto for background execution
    permissionMode: 'auto',
  });

  // Convert agent messages to progress logs
  useEffect(() => {
    const newMessages = agent.messages.slice(lastMessageCountRef.current);
    lastMessageCountRef.current = agent.messages.length;

    if (newMessages.length === 0) return;

    const newLogs: AIProgressLog[] = [];

    for (const msg of newMessages) {
      switch (msg.type) {
        case 'agent-thinking': {
          // Extract first line or truncate for task
          const taskText = msg.content.split('\n')[0].slice(0, 80);
          setCurrentTask(taskText);
          newLogs.push({
            timestamp: new Date(),
            message: taskText,
            level: 'info',
          });
          break;
        }

        case 'command-result':
          newLogs.push({
            timestamp: new Date(),
            message: `Ran: ${msg.command} on ${msg.sessionName}`,
            level: 'info',
          });
          break;

        case 'error':
          newLogs.push({
            timestamp: new Date(),
            message: msg.content,
            level: 'error',
          });
          break;

        case 'recommendation':
          newLogs.push({
            timestamp: new Date(),
            message: `Config recommendation for ${msg.sessionName || 'device'}`,
            level: 'success',
          });
          break;
      }
    }

    if (newLogs.length > 0) {
      setLogs(prev => [...prev, ...newLogs]);
    }
  }, [agent.messages]);

  // Update progress based on agent state
  useEffect(() => {
    switch (agent.agentState) {
      case 'thinking':
        setProgress(prev => Math.min(prev + 10, 80));
        break;
      case 'executing':
        setProgress(prev => Math.min(prev + 5, 90));
        break;
      case 'idle':
        if (isRunning && agent.messages.length > 1) {
          // Agent finished
          setProgress(100);
          setCurrentTask('Complete');
          setLogs(prev => [...prev, {
            timestamp: new Date(),
            message: 'AI enrichment complete',
            level: 'success',
          }]);
          setIsRunning(false);
          onCompleteRef.current?.(agent.messages);
        }
        break;
      case 'error':
        setIsRunning(false);
        break;
    }
  }, [agent.agentState, isRunning, agent.messages.length]);

  // Notify parent of progress changes
  useEffect(() => {
    if (isRunning || progress === 100) {
      onProgressRef.current?.({
        isRunning,
        currentTask,
        logs,
        progress,
        messages: agent.messages,
      });
    }
  }, [isRunning, currentTask, logs, progress, agent.messages]);

  // Start enrichment
  const startEnrichment = useCallback(async (prompt: string, taskName: string) => {
    // Reset state
    setIsRunning(true);
    setProgress(10);
    setCurrentTask(taskName);
    setLogs([{
      timestamp: new Date(),
      message: `Starting: ${taskName}`,
      level: 'info',
    }]);
    lastMessageCountRef.current = 0;

    // Clear previous conversation
    agent.clearMessages();

    // Send the enrichment prompt
    await agent.sendMessage(prompt);
  }, [agent]);

  // Stop the agent
  const stop = useCallback(() => {
    agent.stopAgent();
    setIsRunning(false);
    setLogs(prev => [...prev, {
      timestamp: new Date(),
      message: 'Stopped by user',
      level: 'warning',
    }]);
  }, [agent]);

  // Reset for new run
  const reset = useCallback(() => {
    agent.clearMessages();
    setIsRunning(false);
    setLogs([]);
    setCurrentTask('');
    setProgress(0);
    lastMessageCountRef.current = 0;
  }, [agent]);

  return {
    isRunning,
    currentTask,
    logs,
    progress,
    messages: agent.messages,
    agentState: agent.agentState,
    startEnrichment,
    stop,
    reset,
  };
}
