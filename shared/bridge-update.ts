import type { BridgePlatform, BridgeReleaseSnapshot } from './bridge-release.js';

export interface BridgeUpdatePlan {
  snapshot: BridgeReleaseSnapshot;
  manifestSha256: string;
  platform: BridgePlatform;
  fromVersion: string;
  fromInstanceId: string;
}

export interface BridgeUpdateConfirmation {
  operationId: string;
  instanceId: string;
  manifestSha256: string;
  outcome: 'succeeded' | 'rolled-back' | 'failed' | 'uncertain';
}
