import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileAllowed, fileGroup, validFileDirectory, type FilePolicy } from '../../shared/file-references.js';
import { safeProjectFile } from './gateway.js';

const within = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
/** The web policy may only narrow the already registered project, never expand it. */
export async function safeReferenceFile(root: string, input: string, policy: FilePolicy, maximum: number): Promise<string> {
  if (!policy || !Array.isArray(policy.directories) || !policy.directories.length || policy.directories.length > 32 || !policy.directories.every(value => typeof value === 'string' && validFileDirectory(value)) || !Array.isArray(policy.groups) || !Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1 || !fileAllowed(policy, input)) throw new Error('File reference not allowed');
  const requested = resolve(root, input), rel = relative(root, requested);
  if (!within(root, requested) || rel.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('File reference outside allowed directories');
  const file = await safeProjectFile(root, requested, Math.min(maximum, policy.maxBytes));
  if (!fileAllowed(policy, file) || fileGroup(file) !== fileGroup(input)) throw new Error('File reference type changed');
  for (const directory of policy.directories) {
    // Both requested and canonical paths must stay inside the same allowed directory.
    const allowed = resolve(root, directory);
    if (!within(allowed, requested)) continue;
    const canonical = await realpath(allowed);
    if (within(root, canonical) && within(canonical, file)) return file;
  }
  throw new Error('File reference outside allowed directories');
}
