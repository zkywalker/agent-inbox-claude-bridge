export const BRIDGE_RELEASE_REPOSITORY = 'zkywalker/agent-inbox-claude-bridge';
export const BRIDGE_PLATFORMS = ['linux-x64', 'darwin-x64', 'darwin-arm64'] as const;
export type BridgePlatform = typeof BRIDGE_PLATFORMS[number];

export const BRIDGE_MANIFEST_SIGNATURE_DOMAIN = 'agent-inbox-claude-bridge-manifest:v1\n';
export interface BridgeManifestSignature {
  schemaVersion: 1;
  algorithm: 'ed25519';
  keyId: string;
  signature: string;
}

export interface BridgeReleaseAsset {
  platform: BridgePlatform;
  name: string;
  size: number;
  sha256: string;
}

export interface BridgeReleaseManifest {
  schemaVersion: 1;
  repository: typeof BRIDGE_RELEASE_REPOSITORY;
  version: string;
  publishedAt: string;
  expiresAt: string;
  assets: BridgeReleaseAsset[];
}

export interface BridgeReleaseSnapshot {
  manifest: string;
  signature: string;
}
