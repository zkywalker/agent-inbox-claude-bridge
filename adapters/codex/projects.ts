import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { ProjectDirectory, ProjectListing } from '../../shared/runtime.js';
import type { BridgeConfig } from './gateway.js';
import type { BridgeState } from './state.js';

// Only directory IDs returned by this host can be browsed or registered.
// Recheck both the configured root and the directory on every use.
export class Projects {
  constructor(private config: Pick<BridgeConfig, 'projects' | 'projectRoots'>, private state: BridgeState) {}
  get enabled() { return !!this.config.projectRoots?.length; }
  private async checked(rootId: string, path: string) {
    const root = this.config.projectRoots?.find(root => root.id === rootId);
    if (!root) throw new Error('unavailable');
    const base = await realpath(root.path), target = await realpath(path);
    const rel = relative(base, target);
    if (base !== root.path || target !== path || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)
      || rel.split(sep).some(part => part.startsWith('.')) || !(await lstat(target)).isDirectory()) throw new Error('unavailable');
    return { root, path: target };
  }
  private directory(rootId: string, path: string, name = basename(path)): ProjectDirectory {
    let row = this.state.db.prepare('SELECT id FROM project_directories WHERE root_id=? AND path=?').get(rootId, path);
    if (!row) {
      const id = randomUUID();
      this.state.db.prepare('INSERT INTO project_directories VALUES(?,?,?)').run(id, rootId, path);
      row = { id };
    }
    return { id: row.id as string, name, path };
  }
  private async resolve(id: string) {
    const row = this.state.db.prepare('SELECT * FROM project_directories WHERE id=?').get(id);
    if (!row) throw new Error('unavailable');
    return this.checked(row.root_id as string, row.path as string);
  }
  async restore() {
    for (const row of this.state.db.prepare('SELECT * FROM registered_projects').all()) {
      if (this.config.projects.length >= 100) break;
      try {
        const { path } = await this.resolve(row.directory_id as string);
        if (!this.config.projects.some(project => project.id === row.id || project.path === path)) this.config.projects.push({ id: row.id as string, name: row.name as string, path });
      } catch { /* Removed roots never retain remote registration authority. */ }
    }
  }
  async validate(projectId: string) {
    const row = this.state.db.prepare('SELECT directory_id FROM registered_projects WHERE id=?').get(projectId);
    if (row) await this.resolve(row.directory_id as string);
  }
  async browse(id?: string): Promise<ProjectListing> {
    if (!this.enabled) throw new Error('unsupported');
    if (!id) {
      const directories: ProjectDirectory[] = [];
      for (const root of this.config.projectRoots ?? []) {
        try { await this.checked(root.id, root.path); directories.push(this.directory(root.id, root.path, root.name)); } catch { /* Unavailable roots are not offered. */ }
      }
      return { current: null, parentId: null, directories, truncated: false };
    }
    const { root, path } = await this.resolve(id);
    const entries = (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    const directories: ProjectDirectory[] = [];
    for (const entry of entries.slice(0, 200)) {
      const child = join(path, entry.name);
      try { await this.checked(root.id, child); directories.push(this.directory(root.id, child, entry.name)); } catch { /* Races or inaccessible directories are omitted. */ }
    }
    return { current: this.directory(root.id, path, path === root.path ? root.name : basename(path)), parentId: path === root.path ? null : this.directory(root.id, dirname(path)).id, directories, truncated: entries.length > 200 };
  }
  async register(id: string, name?: string) {
    const { path } = await this.resolve(id);
    const existing = this.config.projects.find(project => project.path === path);
    if (existing) return existing;
    if (this.config.projects.length >= 100) throw new Error('unavailable');
    const prior = this.state.db.prepare('SELECT id,name FROM registered_projects WHERE directory_id=?').get(id);
    const project = { id: prior?.id as string || `project-${randomUUID()}`, name: prior?.name as string || name?.trim().slice(0, 120) || basename(path).slice(0, 120), path };
    this.state.db.prepare('INSERT OR IGNORE INTO registered_projects VALUES(?,?,?)').run(project.id, project.name, id);
    this.config.projects.push(project);
    return project;
  }
}
