# NetStacks Terminal Frontend API Client Layer Audit Report

**Audit Date:** 2026-06-25  
**Scope:** `/frontend/src/api/` — 20 files  
**Auditor:** Automated Code Review

---

## Executive Summary

The API client layer implements a **dual-mode architecture** (standalone/enterprise) with a singleton client pattern. The codebase demonstrates **strong security practices** overall, with proper auth token handling, TLS error detection, and JWT refresh queue implementation. However, several areas require attention including hardcoded URLs, inconsistent error handling, and potential security concerns around token exposure in WebSocket URLs.

**Key Findings:**
- ✅ **Auth Token Handling:** Secure Bearer token injection via interceptors; tokens never persisted to disk
- ✅ **JWT Refresh:** Proper queue-based refresh with concurrent 401 handling
- ✅ **TLS Detection:** Comprehensive TLS error detection for enterprise mode
- ⚠️ **Hardcoded URLs:** Multiple localhost URLs hardcoded for Ollama/LiteLLM
- ⚠️ **WebSocket Token Exposure:** Tokens passed as query parameters (unavoidable for WebSocket API)
- ⚠️ **Error Handling Inconsistency:** Mixed patterns across files (some use custom errors, others generic)
- ℹ️ **Timeout Configuration:** 30s default, with 60s for AI and 15s for SNMP interface stats

---

## 1. client.ts — Main HTTP Client Initialization

**File:** `frontend/src/api/client.ts:1-127`

### Architecture
- **Singleton Pattern:** Single `clientInstance` initialized at app startup
- **Mode Detection:** Reads app config to determine standalone vs enterprise mode
- **Remote Agent Support:** Accepts `remoteAgentUrl` and `remoteAgentToken` via URL query params

### Base URL Configuration
| Mode | Base URL Pattern | Source |
|------|------------------|--------|
| Standalone (Local) | `https://127.0.0.1:{port}/api` | `localClient.ts:36-39` |
| Standalone (Remote) | `{remoteAgentUrl}/api` | URL query param `remoteAgentUrl` |
| Enterprise | `{controllerUrl}/api` | App config `controllerUrl` |

### Auth Token Handling
- **Standalone:** Token set via Tauri event (`setSidecarAuthToken`), never persisted
- **Enterprise:** JWT from auth store, injected via request interceptor
- **Remote Agent:** Token from URL query param `remoteAgentToken`

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ⚠️ Medium | Remote agent token passed via URL query param | `client.ts:32` | Document security implications; consider alternative for production |
| ℹ️ Low | Health check on init uses relative path `../health` | `client.ts:60` | Verify this resolves correctly to `/health` not `/api/../health` |

---

## 2. localClient.ts — Local Agent Client

**File:** `frontend/src/api/localClient.ts:1-156`

### Hardcoded Values
| Value | Location | Purpose |
|-------|----------|---------|
| `127.0.0.1` | `localClient.ts:10` | Local agent host (IPv4 literal for Windows compatibility) |
| `8080` | `localClient.ts:37, 121` | Fallback port when sidecar port not yet set |

### Auth Token Flow
```typescript
// Token set by Tauri event at startup
setSidecarAuthToken(token: string)  // localClient.ts:18-21
setSidecarPort(port: number)         // localClient.ts:27-30

// Injected per-request via interceptor
config.headers.Authorization = `Bearer ${token}`  // localClient.ts:101
```

### WebSocket URL Construction
```typescript
// localClient.ts:120-125
wsUrl(path: string): string {
  const port = sidecarPort || 8080;
  const base = `wss://${LOCAL_AGENT_HOST}:${port}${path}`;
  const token = getSidecarAuthToken();
  return token ? appendTokenToWsUrl(base, token) : base;
}
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ℹ️ Info | Fallback port 8080 used before sidecar port arrives | `localClient.ts:37, 121` | Documented behavior; acceptable for startup race condition |

---

## 3. controllerClient.ts — Enterprise Controller Client

**File:** `frontend/src/api/controllerClient.ts:1-229`

### JWT Refresh Queue Implementation
**Location:** `controllerClient.ts:14-196`

```typescript
// Queue for concurrent 401s
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}>[];
```

**Flow:**
1. First 401 triggers refresh, sets `isRefreshing = true`
2. Subsequent 401s queue up waiting
3. On refresh success: all queued requests retry with new token
4. On refresh failure: all queued requests reject, auth state cleared

### TLS Error Detection
**Location:** `controllerClient.ts:45-76`

| Error Code | Detection | Message |
|------------|-----------|---------|
| `ERR_CERT_AUTHORITY_INVALID` | ✅ | "Ensure the Controller certificate is trusted by your operating system" |
| `ERR_CERT_COMMON_NAME_INVALID` | ✅ | Same as above |
| `ERR_CERT_DATE_INVALID` | ✅ | Same as above |
| `ERR_SSL_PROTOCOL_ERROR` | ✅ | Same as above |
| `ECONNREFUSED` | ✅ | "Ensure the Controller is running and accessible" |
| `ERR_NETWORK` | ✅ | "Check URL, certificate, and network configuration" |

### Request Interceptors
| Interceptor | Purpose | Location |
|-------------|---------|----------|
| Bearer token injection | Attach JWT access token | `controllerClient.ts:94-98` |
| Org ID injection | Add `org_id` query param for plugin routes | `controllerClient.ts:99` |
| X-User-Id header | Inject user ID for plugin write endpoints | `controllerClient.ts:105-107` |

### WebSocket Auth
```typescript
// controllerClient.ts:213-227
wsUrlWithAuth(path: string): string {
  const { accessToken } = getAuthState();
  return appendTokenToWsUrl(this.wsUrl(path), accessToken);
}
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ℹ️ Info | WebSocket tokens passed as query params | `controllerClient.ts:226` | Unavoidable for WebSocket API; document security implications |

---

## 4. auth.ts — Authentication Flows

**File:** `frontend/src/api/auth.ts:1-82`

### API Endpoints

| Function | Method | Path | Auth Required | Location |
|----------|--------|------|---------------|----------|
| `login` | POST | `/auth/login` | ❌ No | `auth.ts:15-19` |
| `refreshToken` | POST | `/auth/refresh` | ❌ No (uses plain axios) | `auth.ts:26-34` |
| `logout` | POST | `/auth/logout` | ✅ Yes | `auth.ts:39-47` |
| `getCurrentUser` | GET | `/auth/me` | ✅ Yes | `auth.ts:53-57` |
| `getAuthProviders` | GET | `/auth/providers` | ❌ No | `auth.ts:69-82` |

### Request/Response Types

```typescript
// auth.ts:3-9 (imported from types/auth)
interface LoginRequest { email: string; password: string }
interface LoginResponse { access_token: string; refresh_token: string; user: User }
interface RefreshRequest { refresh_token: string }
interface RefreshResponse { access_token: string; refresh_token: string }
interface User { id: string; email: string; org_id?: string }
```

### Special Handling
- **refreshToken** uses plain `axios.post` to avoid triggering 401 interceptor (prevents infinite loop)
- **logout** catches errors and continues local logout anyway

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean implementation | — | — |

---

## 5. sessions.ts — Session Management

**File:** `frontend/src/api/sessions.ts:1-678`

### API Endpoints

| Function | Method | Path | Mode Gate | Location |
|----------|--------|------|-----------|----------|
| `listSessions` | GET | `/sessions` | Standalone only | `sessions.ts:232-236` |
| `getSession` | GET | `/sessions/{id}` | — | `sessions.ts:238-241` |
| `createSession` | POST | `/sessions` | — | `sessions.ts:243-246` |
| `updateSession` | PUT | `/sessions/{id}` | — | `sessions.ts:271-274` |
| `deleteSession` | DELETE | `/sessions/{id}` | — | `sessions.ts:276-278` |
| `bulkDeleteSessions` | POST | `/sessions/bulk-delete` | — | `sessions.ts:284-287` |
| `getSessionJumpDependents` | GET | `/sessions/{id}/jump-dependents` | — | `sessions.ts:266-269` |
| `listFolders` | GET | `/folders` | Standalone only | `sessions.ts:290-294` |
| `createFolder` | POST | `/folders` | Standalone only | `sessions.ts:296-300` |
| `updateFolder` | PUT | `/folders/{id}` | Standalone only | `sessions.ts:451-455` |
| `deleteFolder` | DELETE | `/folders/{id}` | Standalone only | `sessions.ts:457-460` |
| `moveSession` | PUT | `/sessions/{id}/move` | Standalone only | `sessions.ts:474-478` |
| `moveFolder` | PUT | `/folders/{id}/move` | Standalone only | `sessions.ts:480-484` |
| `getVaultStatus` | GET | `/vault/status` | Standalone only | `sessions.ts:303-307` |
| `setMasterPassword` | POST | `/vault/password` | Standalone only | `sessions.ts:309-312` |
| `unlockVault` | POST | `/vault/unlock` | Standalone only | `sessions.ts:314-317` |
| `storeCredential` | POST | `/credentials/{sessionId}` | Standalone only | `sessions.ts:319-322` |
| `listSessionSnippets` | GET | `/sessions/{id}/snippets` | — | `sessions.ts:325-328` |
| `createSessionSnippet` | POST | `/sessions/{id}/snippets` | — | `sessions.ts:330-333` |
| `deleteSessionSnippet` | DELETE | `/sessions/{id}/snippets/{snippetId}` | — | `sessions.ts:335-337` |
| `listHistory` | GET | `/history` | Standalone only | `sessions.ts:358-362` |
| `createHistory` | POST | `/history` | Standalone only | `sessions.ts:364-368` |
| `deleteHistory` | DELETE | `/history/{id}` | Standalone only | `sessions.ts:370-373` |
| `exportAll` | GET | `/sessions/export` | Standalone only | `sessions.ts:415-419` |
| `exportSession` | GET | `/sessions/{id}/export` | Standalone only | `sessions.ts:421-425` |
| `exportFolder` | GET | `/folders/{id}/export` | Standalone only | `sessions.ts:427-431` |
| `importSessions` | POST | `/sessions/import` | Standalone only | `sessions.ts:433-437` |
| `listJumpHosts` | GET | `/jump-hosts` | Standalone only | `sessions.ts:651-655` |
| `getJumpHost` | GET | `/jump-hosts/{id}` | Standalone only | `sessions.ts:657-661` |
| `createJumpHost` | POST | `/jump-hosts` | Standalone only | `sessions.ts:663-667` |
| `updateJumpHost` | PUT | `/jump-hosts/{id}` | Standalone only | `sessions.ts:669-673` |
| `deleteJumpHost` | DELETE | `/jump-hosts/{id}` | Standalone only | `sessions.ts:675-678` |

### Mode Gating Pattern
```typescript
// sessions.ts:232-236
export async function listSessions(): Promise<Session[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/sessions');
  return data;
}
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ℹ️ Info | Large file (678 lines) with mixed concerns | — | Consider splitting into separate files |

---

## 6. vault.ts — Credential Vault API

**File:** `frontend/src/api/vault.ts:1-218`

### API Endpoints

| Function | Method | Path | Location |
|----------|--------|------|----------|
| `hasVaultApiKey` | GET | `/vault/api-keys/{keyType}/exists` | `vault.ts:24-36` |
| `getVaultApiKey` | GET | `/vault/api-keys/{keyType}` | `vault.ts:41-53` |
| `storeVaultApiKey` | PUT | `/vault/api-keys/{keyType}` | `vault.ts:58-61` |
| `deleteVaultApiKey` | DELETE | `/vault/api-keys/{keyType}` | `vault.ts:66-77` |
| `lockVault` | POST | `/vault/lock` | `vault.ts:125-128` |
| `changeMasterPassword` | PUT | `/vault/password` | `vault.ts:135-144` |
| `wipeVault` | POST | `/vault/wipe` | `vault.ts:151-156` |
| `getBiometricStatus` | GET | `/vault/biometric/status` | `vault.ts:179-187` |
| `enableBiometric` | POST | `/vault/biometric/enable` | `vault.ts:193-198` |
| `unlockVaultWithBiometric` | POST | `/vault/biometric/unlock` | `vault.ts:205-210` |
| `disableBiometric` | DELETE | `/vault/biometric` | `vault.ts:215-218` |

### Security Features
- **URL Encoding:** `encodeURIComponent(keyType)` used for API key type in URL path
- **404 Handling:** Returns `null`/`false` for missing keys instead of throwing
- **Mode Gating:** `ensureStandaloneVault()` helper throws for enterprise mode

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean implementation with proper security | — | — |

---

## 7. ai.ts — AI Assistant API

**File:** `frontend/src/api/ai.ts:1-1380+`

### Hardcoded URLs

| URL | Purpose | Location |
|-----|---------|----------|
| `http://localhost:11434` | Default Ollama URL | `ai.ts:37` |
| `http://localhost:4000` | Default LiteLLM URL | `ai.ts:40` |

### API Endpoints

| Function | Method | Path | Timeout | Location |
|----------|--------|------|---------|----------|
| `fetchOllamaModels` | GET | `{ollamaUrl}/api/tags` | 3s | `ai.ts:43-62` |
| `checkOllamaStatus` | GET | `{ollamaUrl}/api/tags` | 3s | `ai.ts:65-79` |
| `getAiConfig` | GET | `/settings/ai.provider_config` or `/user-settings/ai.provider_config` | 30s | `ai.ts:193-207` |
| `setAiConfig` | PUT | `/settings/ai.provider_config` or `/user-settings/ai.provider_config` | 30s | `ai.ts:210-216` |
| `getAiAgentConfig` | GET | `/settings/ai.agent_config` or `/user-settings/ai.agent_config` | 30s | `ai.ts:232-245` |
| `setAiAgentConfig` | PUT | `/settings/ai.agent_config` or `/user-settings/ai.agent_config` | 30s | `ai.ts:248-254` |
| `testAiConnection` | POST | `/ai/chat` | 30s | `ai.ts:302-318` |
| `sendChatMessage` | POST | `/ai/chat` | 30s | `ai.ts:454-499` |
| `getAiStatus` | GET | `/ai/status` | 30s | `ai.ts:519-526` |
| `analyzeHighlights` | POST | `/ai/analyze-highlights` | 60s | `ai.ts:584-617` |
| `getSanitizationConfig` | GET | `/settings/ai.sanitization_config` or `/admin/sanitization/config` | 30s | `ai.ts:678-698` |
| `setSanitizationConfig` | PUT | `/settings/ai.sanitization_config` or `/admin/sanitization/config` | 30s | `ai.ts:701-717` |
| `testSanitization` | POST | `/ai/sanitization/test` | 30s | `ai.ts:720-730` |
| `listAiMemories` | GET | `/ai/memory` | 30s | `ai.ts:1305-1309` |
| `createAiMemory` | POST | `/ai/memory` | 30s | `ai.ts:1311-1314` |
| `updateAiMemory` | PUT | `/ai/memory/{id}` | 30s | `ai.ts:1316-1318` |
| `deleteAiMemory` | DELETE | `/ai/memory/{id}` | 30s | `ai.ts:1320-1322` |
| `enableAiConfigMode` | POST | `/ai/config-mode/enable` | 30s | `ai.ts:1364-1370` |
| `disableAiConfigMode` | POST | `/ai/config-mode/disable` | 30s | `ai.ts:1373-1376` |
| `getAiConfigModeStatus` | GET | `/ai/config-mode/status` | 30s | `ai.ts:1380+` |

### Settings Prefix Pattern
```typescript
// ai.ts:159-161
function settingsPrefix(): string {
  return getCurrentMode() === 'enterprise' ? '/user-settings' : '/settings';
}
```

### Custom Error Class
```typescript
// ai.ts:502-507
export class AiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ⚠️ Medium | Hardcoded localhost URLs for Ollama/LiteLLM | `ai.ts:37, 40` | Make configurable or document as defaults |
| ⚠️ Medium | Direct `fetch()` to Ollama bypasses auth interceptors | `ai.ts:46-49, 68-71` | Document that Ollama is expected to be local/unauthenticated |
| ℹ️ Info | Large file (1380+ lines) | — | Consider splitting prompt constants to separate file |

---

## 8. snmp.ts — SNMP API

**File:** `frontend/src/api/snmp.ts:1-290`

### API Endpoints

| Function | Method | Path | Timeout | Location |
|----------|--------|------|---------|----------|
| `snmpGet` | POST | `/snmp/get` | 30s | `snmp.ts:143-168` |
| `snmpWalk` | POST | `/snmp/walk` | 30s | `snmp.ts:173-197` |
| `snmpTryCommunities` | POST | `/snmp/try-communities` | 30s | `snmp.ts:203-224` |
| `snmpInterfaceStats` | POST | `/snmp/interface-stats` | 15s | `snmp.ts:236-261` |
| `snmpTryInterfaceStats` | POST | `/snmp/try-interface-stats` | 15s | `snmp.ts:267-290` |

### Mode-Aware Request Bodies
```typescript
// snmp.ts:144-151 (Enterprise mode)
const { data } = await getClient().http.post('/snmp/get', {
  deviceId: req.deviceId,
  oids: req.oids,
  port: req.port,
});

// snmp.ts:154-162 (Standalone mode)
const { data } = await getClient().http.post('/snmp/get', {
  host: req.host,
  community: req.community,
  oids: req.oids,
  port: req.port,
  profileId: req.profileId,
  jumpHostId: req.jump_host_id,
  jumpSessionId: req.jump_session_id,
});
```

### Custom Timeout
```typescript
// snmp.ts:231
const INTERFACE_STATS_TIMEOUT_MS = 15000;  // 15s for interface stats
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean mode-aware implementation | — | — |

---

## 9. tunnels.ts — Tunnel Management

**File:** `frontend/src/api/tunnels.ts:1-149`

### API Endpoints

| Function | Method | Path | Location |
|----------|--------|------|----------|
| `listTunnels` | GET | `/tunnels` | `tunnels.ts:80-83` |
| `createTunnel` | POST | `/tunnels` | `tunnels.ts:85-88` |
| `updateTunnel` | PUT | `/tunnels/{id}` | `tunnels.ts:90-93` |
| `deleteTunnel` | DELETE | `/tunnels/{id}` | `tunnels.ts:95-97` |
| `startTunnel` | POST | `/tunnels/{id}/start` | `tunnels.ts:99-101` |
| `stopTunnel` | POST | `/tunnels/{id}/stop` | `tunnels.ts:103-105` |
| `reconnectTunnel` | POST | `/tunnels/{id}/reconnect` | `tunnels.ts:107-109` |
| `getTunnelStatus` | GET | `/tunnels/status` | `tunnels.ts:111-114` |
| `startAllTunnels` | POST | `/tunnels/start-all` | `tunnels.ts:116-118` |
| `stopAllTunnels` | POST | `/tunnels/stop-all` | `tunnels.ts:120-122` |

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean implementation | — | — |

---

## 10. tasks.ts — Task API

**File:** `frontend/src/api/tasks.ts:1-278`

### API Endpoints

| Function | Method | Path | Mode | Location |
|----------|--------|------|------|----------|
| `createTask` | POST | `/tasks` | Standalone | `tasks.ts:87-88` |
| `createTask` (enterprise) | POST | `/tasks/agent-schedules` + `/tasks/agent-schedules/{id}/run` | Enterprise | `tasks.ts:61-69` |
| `listTasks` | GET | `/tasks` | Standalone | `tasks.ts:132-133` |
| `listTasks` (enterprise) | GET | `/admin/agent-tasks/history` | Enterprise | `tasks.ts:106` |
| `getTask` | GET | `/tasks/{id}` | Standalone | `tasks.ts:194-195` |
| `getTask` (enterprise) | GET | `/admin/agent-tasks/history/{id}` | Enterprise | `tasks.ts:177` |
| `getTaskMessages` | GET | `/tasks/{taskId}/messages` | Standalone only | `tasks.ts:213-216` |
| `deleteTask` | DELETE | `/tasks/{id}` | Standalone | `tasks.ts:236` |
| `deleteTask` (enterprise) | POST | `/tasks/executions/{id}/cancel` | Enterprise | `tasks.ts:230` |
| `cancelTask` | DELETE | `/tasks/{taskId}` | Standalone | `tasks.ts:257` |
| `cancelTask` (enterprise) | POST | `/tasks/executions/{taskId}/cancel` | Enterprise | `tasks.ts:249` |

### Enterprise Workaround
```typescript
// tasks.ts:47-84
// Enterprise mode creates a disabled schedule then runs it immediately
// because controller has no "one-off agent task" endpoint
const scheduleResp = await client.http.post('/tasks/agent-schedules', {
  name: `One-off: ${req.prompt.slice(0, 30)} [${Date.now()}]`,
  prompt: req.prompt,
  cron_expression: '0 0 1 1 *',  // Valid cron that never fires
  enabled: false,
});
const runResp = await client.http.post(`/tasks/agent-schedules/${scheduleResp.data.id}/run`);
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ℹ️ Info | Enterprise workaround for one-off tasks | `tasks.ts:47-84` | Document; replace when controller exposes proper endpoint |

---

## 11. scripts.ts — Script Execution API

**File:** `frontend/src/api/scripts.ts:1-422`

### API Endpoints

| Function | Method | Path | Location |
|----------|--------|------|----------|
| `listScripts` | GET | `/scripts` | `scripts.ts:129-132` |
| `getScript` | GET | `/scripts/{id}` | `scripts.ts:134-137` |
| `createScript` | POST | `/scripts` | `scripts.ts:139-157` |
| `updateScript` | PUT | `/scripts/{id}` | `scripts.ts:159-167` |
| `deleteScript` | DELETE | `/scripts/{id}` | `scripts.ts:169-176` |
| `createScriptAsAi` | POST | `/scripts` (with `X-NetStacks-AI-Origin: true` header) | `scripts.ts:184-194` |
| `approveScript` | POST | `/scripts/{id}/approve` | `scripts.ts:201-209` |
| `analyzeScript` | GET | `/scripts/{id}/analyze` | `scripts.ts:211-214` |
| `runScriptStream` | POST | `/scripts/{id}/stream` (SSE) | `scripts.ts:220-285` |
| `runScript` | POST | `/scripts/{id}/run` | `scripts.ts:287-397` |
| `generateScript` | POST | `/ai/generate-script` | `scripts.ts:399-422` |

### SSE Streaming Implementation
```typescript
// scripts.ts:242-284
const response = await fetch(`${baseUrl}/api/scripts/${id}/stream`, {
  method: 'POST',
  headers,
  body: JSON.stringify(options || {}),
  signal,
});
// Manual SSE parsing with event/data lines
```

### Enterprise Polling for Script Execution
```typescript
// scripts.ts:318-371
// Poll /scripts/executions/{execId} with exponential backoff
const maxWait = 120000; // 2 minute timeout
let pollInterval = 1000;
// Back off to 8s max on consecutive errors
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ⚠️ Medium | SSE uses `fetch()` directly, bypassing axios interceptors | `scripts.ts:242` | Manually injects auth token; acceptable but document |
| ℹ️ Info | 2-minute polling timeout for enterprise script execution | `scripts.ts:319` | Consider WebSocket for long-running scripts |

---

## 12. sftp.ts — SFTP API

**File:** `frontend/src/api/sftp.ts:1-223`

### API Endpoints

| Function | Method | Path | Location |
|----------|--------|------|----------|
| `sftpConnect` | POST | `/sftp/{sftpId}/connect` | `sftp.ts:25-40` |
| `sftpDisconnect` | POST | `/sftp/{sftpId}/disconnect` | `sftp.ts:43-50` |
| `sftpLs` | GET | `/sftp/{sftpId}/ls` | `sftp.ts:53-66` |
| `sftpDownload` | GET | `/sftp/{sftpId}/download` | `sftp.ts:86-109` |
| `sftpUpload` | POST | `/sftp/{sftpId}/upload` | `sftp.ts:114-137` |
| `sftpMkdir` | POST | `/sftp/{sftpId}/mkdir` | `sftp.ts:140-149` |
| `sftpRm` | DELETE | `/sftp/{sftpId}/rm` | `sftp.ts:152-165` |
| `sftpRename` | POST | `/sftp/{sftpId}/rename` | `sftp.ts:168-181` |
| `sftpStat` | GET | `/sftp/{sftpId}/stat` | `sftp.ts:184-197` |

### Progress Callbacks
```typescript
// sftp.ts:80
export type SftpTransferProgress = (loaded: number, total: number | undefined) => void;

// Used with axios onDownloadProgress/onUploadProgress
onDownloadProgress: onProgress ? (e) => onProgress(e.loaded, e.total) : undefined
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean implementation with proper abort signal support | — | — |

---

## 13. discovery.ts — Network Discovery API

**File:** `frontend/src/api/discovery.ts:1-56`

### API Endpoints

| Function | Method | Path | Timeout | Location |
|----------|--------|------|---------|----------|
| `runBatchDiscovery` | POST | `/discovery/batch` | 300s (5 min) | `discovery.ts:27-34` |
| `resolveTracerouteHops` | POST | `/discovery/traceroute-resolve` | 30s | `discovery.ts:41-46` |
| `getDiscoveryCapabilities` | GET | `/discovery/capabilities` | 30s | `discovery.ts:53-56` |

### Custom Timeout
```typescript
// discovery.ts:25
const DISCOVERY_BATCH_TIMEOUT_MS = 300_000;  // 5 minutes for large discovery batches
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Appropriate timeout for long-running operation | — | — |

---

## 14. topology.ts — Topology API

**File:** `frontend/src/api/topology.ts:1-762`

### API Endpoints

| Function | Method | Path | Location |
|----------|--------|------|----------|
| `listTopologies` | GET | `/topologies` | `topology.ts:40-47` |
| `createTopology` | POST | `/topologies` | `topology.ts:50-53` |
| `getTopology` | GET | `/topologies/{id}` | `topology.ts:179-182` |
| `updateTopologyName` | PUT | `/topologies/{id}` | `topology.ts:185-187` |
| `deleteTopology` | DELETE | `/topologies/{id}` | `topology.ts:190-192` |
| `updateDevicePosition` | PUT | `/topologies/{topologyId}/devices/{deviceId}/position` | `topology.ts:195-197` |
| `createDevice` | POST | `/topologies/{topologyId}/devices` | `topology.ts:211-224` |
| `updateDevice` | PUT | `/topologies/{topologyId}/devices/{deviceId}/details` | `topology.ts:227-250` |
| `deleteDevice` | DELETE | `/topologies/{topologyId}/devices/{deviceId}` | `topology.ts:253-255` |
| `updateConnection` | PUT | `/topologies/{topologyId}/connections/{connectionId}` | `topology.ts:258-275` |
| `createConnection` | POST | `/topologies/{topologyId}/connections` | `topology.ts:278-281` |
| `addNeighborDevice` | POST | `/topologies/{topologyId}/devices` | `topology.ts:295-302` |
| `deleteConnection` | DELETE | `/topologies/{topologyId}/connections/{connectionId}` | `topology.ts:305-307` |
| `shareTopology` | PUT | `/topologies/{topologyId}/share` | `topology.ts:410-412` |
| `listTopologyFolders` | GET | `/topologies/folders` | `topology.ts:728-731` |
| `createTopologyFolder` | POST | `/topologies/folders` | `topology.ts:733-739` |
| `updateTopologyFolder` | PUT | `/topologies/folders/{id}` | `topology.ts:741-744` |
| `deleteTopologyFolder` | DELETE | `/topologies/folders/{id}` | `topology.ts:746-748` |
| `moveTopologyFolder` | PUT | `/topologies/folders/{id}/move` | `topology.ts:750-753` |
| `moveTopology` | PUT | `/topologies/{id}/move` | `topology.ts:755-757` |
| `bulkDeleteTopologies` | POST | `/topologies/bulk-delete` | `topology.ts:759-762` |

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ℹ️ Info | Large file with SVG generation logic | `topology.ts:443-618` | Consider moving SVG generation to separate utility |

---

## 15. errors.ts — Error Handling Utilities

**File:** `frontend/src/api/errors.ts:1-47`

### Helper Functions

| Function | Purpose | Location |
|----------|---------|----------|
| `parseApiError` | Extract status, code, error from axios error | `errors.ts:13-23` |
| `isApiErrorCode` | Check if error has specific code | `errors.ts:25-27` |
| `getApiErrorMessage` | Get error message with fallback | `errors.ts:29-31` |
| `getErrorMessage` | Generic error message extraction | `errors.ts:44-47` |

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean utility implementation | — | — |

---

## 16. requestHelpers.ts — Request Helpers

**File:** `frontend/src/api/requestHelpers.ts:1-17`

### Org ID Injection
```typescript
// requestHelpers.ts:10-16
export function injectOrgIdForPlugins(
  config: InternalAxiosRequestConfig,
  orgId: string | undefined
): void {
  if (config.url?.startsWith('/plugins/') && orgId) {
    config.params = { ...config.params, org_id: orgId };
  }
}
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean helper function | — | — |

---

## 17. wsHelpers.ts — WebSocket Helpers

**File:** `frontend/src/api/wsHelpers.ts:1-8`

### Token URL Injection
```typescript
// wsHelpers.ts:5-7
export function appendTokenToWsUrl(baseUrl: string, token: string): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
}
```

### Security Note
WebSocket API does not support custom headers, so tokens must be passed as query parameters. This is a known limitation and the token is URL-encoded for safety.

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ⚠️ Low | Tokens in URL query params may appear in logs | `wsHelpers.ts:5-7` | Document; ensure server-side logs don't record full URLs |

---

## 18. crudFactory.ts — CRUD Factory Pattern

**File:** `frontend/src/api/crudFactory.ts:1-34`

### Generated Endpoints
For a given `basePath`, generates:

| Operation | Method | Path |
|-----------|--------|------|
| `list` | GET | `{basePath}` |
| `create` | POST | `{basePath}` |
| `update` | PUT | `{basePath}/{id}` |
| `delete` | DELETE | `{basePath}/{id}` |

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean generic factory | — | — |

---

## 19. cert.ts — Certificate Handling

**File:** `frontend/src/api/cert.ts:1-44`

### API Endpoints

| Function | Method | Path | Mode | Location |
|----------|--------|------|------|----------|
| `getCertStatus` | GET | `/cert/status` | Standalone only | `cert.ts:17-23` |
| `getCertPublicKey` | GET | `/cert/public-key` | Standalone only | `cert.ts:30-34` |
| `storeCertificate` | POST | `/cert/store` | Standalone only | `cert.ts:40-44` |

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ✅ None | Clean implementation with mode gating | — | — |

---

## 20. tlsTrust.ts — TLS Trust Management

**File:** `frontend/src/api/tlsTrust.ts:1-80`

### API Endpoints

| Function | Method | Path | Notes | Location |
|----------|--------|------|-------|----------|
| `fetchCaCertificateInfo` | GET | `/api/tls/ca-certificate/info` | Uses plain axios, tries HTTP then HTTPS | `tlsTrust.ts:24-44` |

### TLS Bootstrap Flow
```typescript
// tlsTrust.ts:24-44
// 1. Try HTTP URL first (works when TLS not trusted yet)
// 2. Fall back to HTTPS
// 3. Return CA certificate info or null
```

### Tauri Integration
```typescript
// tlsTrust.ts:52-66
export async function installCaCertificate(pemContent: string): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('install_ca_certificate', {
    pemContent,
    filename: 'netstacks-controller-ca.pem',
  });
}
```

### Issues Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| ⚠️ Medium | HTTP fallback for CA cert fetch could be MITM'd | `tlsTrust.ts:30` | Document threat model; consider certificate pinning |

---

## Complete API Endpoint Summary

### By HTTP Method

| Method | Count | Endpoints |
|--------|-------|-----------|
| GET | 35 | Sessions, folders, vault, settings, topologies, etc. |
| POST | 42 | Auth, CRUD operations, actions (start/stop/run) |
| PUT | 22 | Updates, settings, configuration |
| DELETE | 15 | Deletion operations |

### By Authentication Requirement

| Auth Required | Count | Examples |
|---------------|-------|----------|
| Yes (Bearer token) | ~95% | All CRUD operations, settings, actions |
| No | ~5% | `/auth/login`, `/auth/refresh`, `/auth/providers`, `/tls/ca-certificate/info` |

### By Mode Availability

| Mode | Count | Examples |
|------|-------|----------|
| Both | ~40% | Auth, scripts, tunnels, SNMP |
| Standalone only | ~50% | Sessions, folders, vault, jump hosts, history |
| Enterprise only | ~10% | Admin endpoints, plugin routes |

---

## Security Assessment

### Strengths
1. **Token Security:** Auth tokens never persisted to disk; set via Tauri events
2. **JWT Refresh:** Proper queue-based refresh prevents race conditions
3. **TLS Detection:** Comprehensive error detection for certificate issues
4. **Mode Gating:** Consistent `getCurrentMode()` checks prevent cross-mode API calls
5. **URL Encoding:** Proper `encodeURIComponent()` for dynamic path segments

### Areas for Improvement
1. **Hardcoded URLs:** Ollama/LiteLLM defaults should be configurable
2. **WebSocket Tokens:** Document security implications of query param tokens
3. **HTTP Fallback:** CA certificate bootstrap has MITM risk (acceptable for initial setup)
4. **Error Consistency:** Mixed error handling patterns across files

### Recommendations
1. Add configuration option for Ollama/LiteLLM base URLs
2. Document WebSocket token security model
3. Consider certificate pinning for CA bootstrap (future enhancement)
4. Standardize error handling with custom error classes

---

## Appendix: File Statistics

| File | Lines | API Calls | Issues |
|------|-------|-----------|--------|
| client.ts | 127 | 1 | 2 |
| localClient.ts | 156 | 0 | 1 |
| controllerClient.ts | 229 | 0 | 1 |
| auth.ts | 82 | 5 | 0 |
| sessions.ts | 678 | 32 | 1 |
| vault.ts | 218 | 11 | 0 |
| ai.ts | 1380+ | 18+ | 3 |
| snmp.ts | 290 | 5 | 0 |
| tunnels.ts | 149 | 10 | 0 |
| tasks.ts | 278 | 11 | 1 |
| scripts.ts | 422 | 11 | 2 |
| sftp.ts | 223 | 9 | 0 |
| discovery.ts | 56 | 3 | 0 |
| topology.ts | 762 | 21 | 1 |
| errors.ts | 47 | 0 | 0 |
| requestHelpers.ts | 17 | 0 | 0 |
| wsHelpers.ts | 8 | 0 | 1 |
| crudFactory.ts | 34 | 4 | 0 |
| cert.ts | 44 | 3 | 0 |
| tlsTrust.ts | 80 | 1 | 1 |
| **Total** | **~5,280** | **~145** | **14** |

---

*End of Audit Report*
