import type { AxiosInstance } from 'axios'
import { getClient } from '../api/client'
import { sftpLs, sftpDownload, sftpUpload, sftpMkdir, sftpRm, sftpRename } from '../api/sftp'
import type { FileOps, WorkspaceFileEntry } from '../types/workspace'

export class LocalFileOps implements FileOps {
  private http: AxiosInstance
  constructor(httpClient?: AxiosInstance) {
    this.http = httpClient || getClient().http
  }

  async readDir(path: string): Promise<WorkspaceFileEntry[]> {
    const { data } = await this.http.post('/local/list-dir', { path })
    return (data.entries || []).map((e: any) => ({
      name: e.name,
      path: e.path,
      isDir: e.is_dir,
      size: e.size || 0,
      modified: e.modified || null,
    }))
  }

  async readFile(path: string): Promise<string> {
    const { data } = await this.http.post('/local/read-file', { path })
    return data.content
  }

  async readFileBinary(path: string): Promise<Uint8Array> {
    const { data } = await this.http.post('/local/read-file-binary', { path })
    const binary = atob(data.content_base64 as string)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.http.post('/local/write-file', { path, content })
  }

  async writeFileBinary(path: string, data: Uint8Array): Promise<void> {
    let binary = ''
    const chunkSize = 8192
    for (let i = 0; i < data.length; i += chunkSize) {
      binary += String.fromCharCode(...data.subarray(i, i + chunkSize))
    }
    const base64 = btoa(binary)
    await this.http.post('/local/write-file-binary', { path, content_base64: base64 })
  }

  async exists(path: string): Promise<boolean> {
    const { data } = await this.http.post('/local/exists', { path })
    return data.exists
  }

  async delete(path: string, isDir: boolean): Promise<void> {
    await this.http.post('/local/delete', { path, is_dir: isDir })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.http.post('/local/rename', { from: oldPath, to: newPath })
  }

  async mkdir(path: string): Promise<void> {
    await this.http.post('/local/mkdir', { path })
  }
}

/** Placeholder FileOps used while a remote SFTP connection is being established. */
export class PendingFileOps implements FileOps {
  async readDir(): Promise<WorkspaceFileEntry[]> { return [] }
  async readFile(): Promise<string> { throw new Error('SFTP connecting…') }
  async readFileBinary(): Promise<Uint8Array> { throw new Error('SFTP connecting…') }
  async writeFile(): Promise<void> { throw new Error('SFTP connecting…') }
  async exists(): Promise<boolean> { return false }
  async mkdir(): Promise<void> { throw new Error('SFTP connecting…') }
  async delete(): Promise<void> { throw new Error('SFTP connecting…') }
  async rename(): Promise<void> { throw new Error('SFTP connecting…') }
}

export class RemoteFileOps implements FileOps {
  private sftpId: string
  constructor(sftpId: string) {
    this.sftpId = sftpId
  }

  async readDir(path: string): Promise<WorkspaceFileEntry[]> {
    const response = await sftpLs(this.sftpId, path)
    const results: WorkspaceFileEntry[] = response.entries
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(e => ({
        name: e.name,
        path: e.path,
        isDir: e.is_dir,
        size: e.size,
        modified: e.modified,
      }))
    return results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  async readFile(path: string): Promise<string> {
    const blob = await sftpDownload(this.sftpId, path)
    return await blob.text()
  }

  async readFileBinary(path: string): Promise<Uint8Array> {
    const blob = await sftpDownload(this.sftpId, path)
    const buffer = await blob.arrayBuffer()
    return new Uint8Array(buffer)
  }

  async writeFile(path: string, content: string): Promise<void> {
    const blob = new Blob([content], { type: 'text/plain' })
    await sftpUpload(this.sftpId, path, blob)
  }

  async exists(path: string): Promise<boolean> {
    try {
      await sftpLs(this.sftpId, path)
      return true
    } catch {
      return false
    }
  }

  async delete(path: string, isDir: boolean): Promise<void> {
    await sftpRm(this.sftpId, path, isDir)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await sftpRename(this.sftpId, oldPath, newPath)
  }

  async mkdir(path: string): Promise<void> {
    await sftpMkdir(this.sftpId, path)
  }
}
