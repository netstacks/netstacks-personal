// Enterprise session types matching Controller API

export interface EnterpriseSession {
  id: string;
  org_id: string;
  name: string;
  host: string;
  port: number;
  description: string | null;
  credential_override_id: string | null;
  cli_flavor: string;
  tags: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
  active_connections: number; // from JOIN count in Controller
}

export interface CreateEnterpriseSession {
  name: string;
  host: string;
  port?: number;
  description?: string | null;
  credential_override_id?: string | null;
  cli_flavor?: string;
  tags?: string[];
}

export interface UpdateEnterpriseSession {
  name?: string;
  host?: string;
  port?: number;
  description?: string | null;
  credential_override_id?: string | null;
  cli_flavor?: string;
  tags?: string[];
}

export interface UserSessionFolder {
  id: string;
  user_id: string;
  org_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateUserSessionFolder {
  name: string;
  parent_id?: string | null;
}

export interface UpdateUserSessionFolder {
  name?: string;
  parent_id?: string | null;
  sort_order?: number;
}

export interface SessionAssignment {
  id: string;
  user_id: string;
  session_definition_id: string;
  folder_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface AssignSessionToFolder {
  folder_id: string | null;
  sort_order?: number;
}
