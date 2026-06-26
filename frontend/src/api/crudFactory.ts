// Generic CRUD API factory for dual-mode (standalone/enterprise) operations.
// Creates a standard set of list/create/update/delete functions for a given base path.
// The underlying getClient() transparently routes to the local agent or controller.

import { getClient } from './client';

export interface CrudApi<T, TCreate, TUpdate> {
  list: () => Promise<T[]>;
  create: (data: TCreate) => Promise<T>;
  update: (id: string, data: TUpdate) => Promise<T>;
  delete: (id: string) => Promise<void>;
}

export function createCrudApi<T, TCreate = Partial<T>, TUpdate = Partial<T>>(
  basePath: string,
): CrudApi<T, TCreate, TUpdate> {
  return {
    list: async () => {
      const { data } = await getClient().http.get(basePath);
      return Array.isArray(data) ? data : [];
    },
    create: async (body: TCreate) => {
      const { data } = await getClient().http.post(basePath, body);
      return data;
    },
    update: async (id: string, body: TUpdate) => {
      const { data } = await getClient().http.put(`${basePath}/${id}`, body);
      return data;
    },
    delete: async (id: string) => {
      await getClient().http.delete(`${basePath}/${id}`);
    },
  };
}
