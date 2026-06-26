import { getErrorMessage } from '../api/errors'
/**
 * Background AI Enrichment - runs AI agent without UI
 *
 * Executes topology enrichment in background, streaming progress via callbacks.
 */

import { getAvailableTools } from './agentTools';
import { validateReadOnlyCommand } from './readOnlyFilter';
import type { AIProgressLog } from '../components/AIProgressPanel';
import type { AgentMessage } from '../api/agent';
import { listSessions } from '../api/sessions';
import { listEnterpriseSessionDefinitions } from '../api/enterpriseSessions';
import { getClient, getCurrentMode } from '../api/client';

// Convert tools to Anthropic format
function toolsToAnthropicFormat(tools: ReturnType<typeof getAvailableTools>): object[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: tool.parameters.type,
      properties: tool.parameters.properties,
      required: tool.parameters.required,
    },
  }));
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface ToolUseResponse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AgentChatMessage {
  role: string;
  content: string | ContentBlock[];
}

interface AgentChatResponse {
  text: string | null;
  tool_use: ToolUseResponse[];
  stop_reason: string | null;
}

export interface DeviceUpdate {
  deviceId: string;
  platform?: string;
  primaryIp?: string;
  version?: string;
  serial?: string;
  model?: string;
  uptime?: string;
  metadata?: Record<string, string>;
}

export interface EnrichmentCallbacks {
  onLog: (log: AIProgressLog) => void;
  onProgress: (percent: number) => void;
  onTask: (task: string) => void;
  onComplete: (messages: AgentMessage[]) => void;
  onError: (error: string) => void;
  onUpdateDevice?: (update: DeviceUpdate) => void;
}

// Execute a tool
async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  addLog: (msg: string, level: AIProgressLog['level']) => void
): Promise<{ content: string; is_error: boolean }> {
  switch (toolName) {
    case 'list_sessions': {
      try {
        const isEnterprise = getCurrentMode() === 'enterprise';
        let sessionList: Array<{ id: string; name: string; host: string }>;

        if (isEnterprise) {
          const result = await listEnterpriseSessionDefinitions();
          sessionList = result.items.map(s => ({
            id: s.id,
            name: s.name,
            host: s.host || 'unknown',
          }));
        } else {
          const sessions = await listSessions();
          sessionList = sessions.map(s => ({
            id: s.id,
            name: s.name,
            host: s.host || 'unknown',
          }));
        }

        addLog(`Found ${sessionList.length} session(s)`, 'info');
        return {
          content: JSON.stringify(sessionList, null, 2),
          is_error: false,
        };
      } catch (err) {
        return {
          content: `Failed to list sessions: ${getErrorMessage(err)}`,
          is_error: true,
        };
      }
    }

    case 'ai_ssh_execute': {
      const sessionId = input.session_id as string;
      const command = input.command as string;
      const timeoutSecs = (input.timeout_secs as number) || 30;

      // Validate read-only
      const validation = validateReadOnlyCommand(command, undefined);
      if (!validation.allowed) {
        return {
          content: `Command blocked: ${validation.reason}`,
          is_error: true,
        };
      }

      addLog(`Running: ${command.slice(0, 50)}...`, 'info');

      try {
        const isEnterprise = getCurrentMode() === 'enterprise';

        // Both enterprise and standalone use getClient() (routed appropriately by client)
        let result: { success: boolean; output: string; error?: string; execution_time_ms: number };

        const payload = isEnterprise
          ? { session_definition_id: sessionId, command, timeout_secs: timeoutSecs }
          : { session_id: sessionId, command, timeout_secs: timeoutSecs };

        const { data } = await getClient().http.post('/ai/ssh-execute', payload);
        result = data;

        if (!result.success) {
          addLog(`Command failed: ${result.error || 'Unknown error'}`, 'error');
          return {
            content: result.error || 'Command execution failed',
            is_error: true,
          };
        }

        addLog(`Command completed (${result.execution_time_ms}ms)`, 'success');
        return {
          content: result.output,
          is_error: false,
        };
      } catch (err) {
        return {
          content: `SSH execution failed: ${getErrorMessage(err)}`,
          is_error: true,
        };
      }
    }

    case 'run_command': {
      // For background enrichment, we use ai_ssh_execute instead
      addLog('run_command not available in background mode, use ai_ssh_execute', 'warning');
      return {
        content: 'run_command is not available in background enrichment mode. Use ai_ssh_execute instead to connect directly to devices.',
        is_error: true,
      };
    }

    case 'update_topology_device': {
      const topologyId = input.topology_id as string;
      const deviceId = input.device_id as string;

      // Build update payload with only provided fields
      const updatePayload: Record<string, string> = {};
      const fieldNames = ['platform', 'version', 'model', 'serial', 'vendor', 'primary_ip', 'uptime', 'status', 'site', 'role', 'notes'];
      for (const field of fieldNames) {
        if (input[field]) {
          updatePayload[field] = input[field] as string;
        }
      }

      if (Object.keys(updatePayload).length === 0) {
        return {
          content: 'No fields provided to update',
          is_error: true,
        };
      }

      const fieldList = Object.keys(updatePayload).join(', ');
      addLog(`Updating device: ${fieldList}`, 'info');

      try {
        await getClient().http.put(`/topologies/${topologyId}/devices/${deviceId}/details`, updatePayload);

        addLog(`Device updated successfully`, 'success');
        return {
          content: `Successfully updated device with: ${fieldList}`,
          is_error: false,
        };
      } catch (err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        const errMsg = axiosErr.response?.data?.error || (getErrorMessage(err));
        addLog(`Update failed: ${errMsg}`, 'error');
        return {
          content: errMsg || 'Device update failed',
          is_error: true,
        };
      }
    }

    default:
      return { content: `Tool ${toolName} not supported in background mode`, is_error: true };
  }
}

// Call the agent API
async function callAgentApi(
  messages: AgentChatMessage[],
  tools: object[]
): Promise<AgentChatResponse> {
  const { data } = await getClient().http.post('/ai/agent-chat', { messages, tools });
  return data;
}

/**
 * Run background topology enrichment
 */
export async function runBackgroundEnrichment(
  prompt: string,
  callbacks: EnrichmentCallbacks
): Promise<void> {
  const { onLog, onProgress, onTask, onComplete, onError } = callbacks;

  // Helper to add log
  const addLog = (msg: string, level: AIProgressLog['level']) => {
    onLog({ timestamp: new Date(), message: msg, level });
  };

  // Get available tools (limited set for background)
  const tools = toolsToAnthropicFormat(
    getAvailableTools({
      hasSessions: true,
      hasExecuteCommand: true, // We handle this specially
      hasTerminalContext: false,
      hasDocuments: false,
    })
  );

  // Conversation history
  const conversation: AgentChatMessage[] = [
    { role: 'user', content: prompt },
  ];

  // Stored messages for transfer to AI panel
  const agentMessages: AgentMessage[] = [
    { id: crypto.randomUUID(), type: 'user', content: prompt, timestamp: new Date() },
  ];

  let iteration = 0;
  const maxIterations = 20;

  onProgress(15);
  onTask('AI analyzing topology...');

  try {
    while (iteration < maxIterations) {
      iteration++;

      // Call AI
      addLog(`AI thinking... (turn ${iteration})`, 'info');
      const response = await callAgentApi(conversation, tools);

      // Process text response
      if (response.text) {
        const textPreview = response.text.split('\n')[0].slice(0, 60);
        onTask(textPreview);
        agentMessages.push({
          id: crypto.randomUUID(),
          type: 'agent-thinking',
          content: response.text,
          timestamp: new Date(),
        });
      }

      // Check if done
      if (response.stop_reason === 'end_turn' || response.tool_use.length === 0) {
        addLog('AI completed analysis', 'success');
        onProgress(100);
        onTask('Complete');
        onComplete(agentMessages);
        return;
      }

      // Build assistant message with tool uses
      const assistantContent: ContentBlock[] = [];
      if (response.text) {
        assistantContent.push({ type: 'text', text: response.text });
      }
      for (const toolUse of response.tool_use) {
        assistantContent.push({
          type: 'tool_use',
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        });
      }
      conversation.push({ role: 'assistant', content: assistantContent });

      // Execute tools
      const toolResults: ContentBlock[] = [];
      for (const toolUse of response.tool_use) {
        const result = await executeTool(toolUse.name, toolUse.input, addLog);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: result.is_error,
        });
      }

      // Add tool results
      conversation.push({ role: 'user', content: toolResults });

      // Update progress
      const progressPercent = Math.min(15 + (iteration * 4), 90);
      onProgress(progressPercent);
    }

    addLog('Max iterations reached', 'warning');
    onComplete(agentMessages);
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    addLog(`Error: ${errorMsg}`, 'error');
    onError(errorMsg);
  }
}
