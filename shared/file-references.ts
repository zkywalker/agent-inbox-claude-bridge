/** Shared recognition only; the host is authoritative for filesystem containment. */
export const fileGroups = {
  text: { label: 'Markdown 与文本', extensions: ['md', 'markdown', 'txt', 'csv', 'tsv', 'log'] },
  document: { label: '文档', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'] },
  image: { label: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'] },
  audio: { label: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
  video: { label: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv'] },
} as const;
export type FileGroup = keyof typeof fileGroups;
export interface FilePolicy { enabled: boolean; directories: string[]; groups: FileGroup[]; maxBytes: number }
export const defaultFilePolicy: FilePolicy = { enabled: true, directories: ['.'], groups: ['text', 'document', 'image', 'audio', 'video'], maxBytes: 100 * 1024 ** 2 };
export interface FileReferenceRequest { id: string; conversationId: string; projectId: string; path: string; policy: FilePolicy }
export function fileExtension(path: string): string { return /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? ''; }
export function fileGroup(path: string): FileGroup | undefined {
  const extension = fileExtension(path);
  return (Object.keys(fileGroups) as FileGroup[]).find(group => (fileGroups[group].extensions as readonly string[]).includes(extension));
}
export function fileAllowed(policy: FilePolicy, name: string, size = 0): boolean {
  const group = fileGroup(name);
  return policy.enabled && !!group && policy.groups.includes(group) && size <= policy.maxBytes;
}
export function validFileDirectory(value: string): boolean {
  return value === '.' || !!value && value.length <= 500 && !/[\\:\x00-\x1f\x7f?#]/.test(value) && !value.startsWith('/') && value.split('/').every(part => !!part && part !== '..' && !part.startsWith('.'));
}
/** Do not turn external websites, API URLs or source-code references into file reads. */
export function localFilePath(href: string, origin: string): string | undefined {
  if (!href || href.length > 4096 || /[\x00-\x1f\x7f]/.test(href) || href.startsWith('//') || href.startsWith('\\\\')) return;
  let path = href;
  if (/^https?:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.origin !== origin || url.username || url.password || url.search || !/^\/(?:Users|home|tmp|var|private\/var|opt|srv|workspace|workspaces|mnt|Volumes|[a-z]:)(?:\/|$)/i.test(url.pathname)) return;
      path = url.pathname;
    } catch { return; }
  } else if (/^file:/i.test(path)) {
    try { const url = new URL(path); if (url.hostname && url.hostname !== 'localhost' || url.search) return; path = url.pathname; } catch { return; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return;
  path = path.split('#')[0];
  if (path.includes('?')) return;
  try { path = decodeURIComponent(path); } catch { return; }
  path = path.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1').replace(/:(\d+)(?::\d+)?$/, '');
  if (/[\x00-\x1f\x7f?#]/.test(path) || path.startsWith('//') || /^\/api(?:\/|$)/i.test(path) || !fileGroup(path)) return;
  return path;
}
export function filePreview(name: string): 'markdown' | 'text' | 'image' | 'audio' | 'video' | undefined {
  const ext = fileExtension(name), group = fileGroup(name);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (group === 'text') return 'text';
  if (group === 'image' && ext !== 'svg' && ext !== 'ico') return 'image';
  if (group === 'audio' || group === 'video') return group;
}
export function fileMimeType(name: string): string {
  const ext = fileExtension(name);
  return ({ md: 'text/plain', markdown: 'text/plain', txt: 'text/plain', csv: 'text/plain', tsv: 'text/plain', log: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
