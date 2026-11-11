import type { AxiosInstance } from 'axios';
import type { AppMode } from './config';

/**
 * Standard API response wrapper.
 * Matches Controller backend response format.
 */
export interface ApiResponse<T> {
  data: T;
  status: number;
}

/**
 * Error response from API.
 */
export interface ApiError {
  error: string;
  message?: string;
  status: number;
}

/**
 * Unified API client interface.
 * Both LocalAgentClient and ControllerClient implement this interface.
 */
export interface NetStacksClient {
  // The underlying HTTP client (axios instance)
  http: AxiosInstance;

  // Current app mode
  mode: AppMode;

  // Whether Enterprise-only features are available
  hasEnterpriseFeatures: boolean;

  // Base URL for the API
  baseUrl: string;

  /**
   * Get WebSocket URL for a given path.
   * In Enterprise mode, includes JWT token as query parameter.
   */
  wsUrl(path: string): string;

  /**
   * Get WebSocket URL with authentication.
   * Must be called after auth store is available.
   */
  wsUrlWithAuth(path: string): string;
}

/**
 * Client initialization result.
 */
export interface ClientInitResult {
  client: NetStacksClient;
  mode: AppMode;
  requiresAuth: boolean; // True for Enterprise mode
}
