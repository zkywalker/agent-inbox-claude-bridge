import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { ClaudeConfig } from './config.js';

export function resolveClaudeBinary(config: ClaudeConfig): string {
  if (config.claudeBinary) return config.claudeBinary;
  let platform = `${process.platform}-${process.arch}`;
  if (process.platform === 'linux') {
    const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
    if (!header.glibcVersionRuntime) platform += '-musl';
  }
  return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${platform}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`);
}

export async function verifyClaudeBinary(binary: string): Promise<string> {
  const { stdout } = await promisify(execFile)(binary, ['--version'], { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true });
  const match = /^(\d+\.\d+\.\d+)(?:[^\r\n]*)\(Claude Code\)/.exec(stdout.trim());
  if (!match) throw new Error('Configured executable did not identify as Claude Code');
  return match[1];
}
