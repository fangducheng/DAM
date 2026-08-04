export const dependencyNames = ['database', 'redis', 'objectStorage'] as const;

export type DependencyName = (typeof dependencyNames)[number];
export type HealthState = 'up' | 'down';

export interface DependencyHealth {
  name: DependencyName;
  status: HealthState;
  latencyMs: number;
  detail?: string;
}

export interface LivenessResponse {
  status: 'ok';
  service: 'dam-api';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessResponse {
  status: 'ready' | 'degraded';
  service: 'dam-api';
  version: string;
  timestamp: string;
  dependencies: DependencyHealth[];
}

export const permissionCodes = [
  'VIEW_METADATA',
  'PREVIEW',
  'DOWNLOAD',
  'UPLOAD',
  'CREATE_FOLDER',
  'EDIT_METADATA',
  'CREATE_VERSION',
  'DELETE',
  'RESTORE',
  'MANAGE_PERMISSION',
  'MANAGE_SPACE',
] as const;

export type PermissionCode = (typeof permissionCodes)[number];
