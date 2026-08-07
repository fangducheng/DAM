import { apiRequest } from './api';

export type ReconciliationRunStatus = 'QUEUED' | 'RUNNING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED';

export type ReconciliationRunPhase = 'DATABASE_SCAN' | 'STORAGE_SCAN' | 'FINALIZING' | 'COMPLETE';

export type ReconciliationIssueType = 'DATABASE_OBJECT_MISSING' | 'STORAGE_OBJECT_UNKNOWN';

export interface ReconciliationSummary {
  databaseObjects: number;
  storageObjects: number;
  missingObjects: number;
  unknownObjects: number;
}

export interface ReconciliationRun extends ReconciliationSummary {
  id: string;
  sourceRunId: string | null;
  requestedBy: { id: string; displayName: string } | null;
  status: ReconciliationRunStatus;
  phase: ReconciliationRunPhase;
  cutoffAt: string;
  lastCheckpointAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReconciliationIssue =
  | {
      id: string;
      issueType: 'DATABASE_OBJECT_MISSING';
      storageObjectId: string;
      expectedSizeBytes: string;
      databaseCreatedAt: string;
    }
  | {
      id: string;
      issueType: 'STORAGE_OBJECT_UNKNOWN';
      objectFingerprint: string;
      observedSizeBytes: string;
      lastModifiedAt: string;
    };

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ReconciliationIssuePage extends CursorPage<ReconciliationIssue> {
  runId: string;
  generatedAt: string;
  summary: ReconciliationSummary;
}

export function isActiveReconciliationRun(status: ReconciliationRunStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'RETRYING';
}

export function mergeReconciliationRuns(
  current: ReconciliationRun[],
  incoming: ReconciliationRun[],
): ReconciliationRun[] {
  const merged = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) merged.set(run.id, run);
  return [...merged.values()].sort((left, right) => {
    if (left.id === right.id) return 0;
    return left.id > right.id ? -1 : 1;
  });
}

export function upsertReconciliationRun(
  current: ReconciliationRun[],
  run: ReconciliationRun,
): ReconciliationRun[] {
  return mergeReconciliationRuns(current, [run]);
}

export function listReconciliationRuns(
  input: {
    cursor?: string;
    limit?: number;
    status?: ReconciliationRunStatus;
  } = {},
): Promise<CursorPage<ReconciliationRun>> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  if (input.status !== undefined) query.set('status', input.status);
  return apiRequest(`/api/v1/maintenance/storage-reconciliation/runs?${query.toString()}`);
}

export function getReconciliationRun(runId: string): Promise<ReconciliationRun> {
  return apiRequest(`/api/v1/maintenance/storage-reconciliation/runs/${encodeURIComponent(runId)}`);
}

export function createReconciliationRun(sourceRunId?: string): Promise<ReconciliationRun> {
  return apiRequest('/api/v1/maintenance/storage-reconciliation/runs', {
    method: 'POST',
    body: JSON.stringify(sourceRunId === undefined ? {} : { sourceRunId }),
  });
}

export function listReconciliationIssues(
  runId: string,
  input: { cursor?: string; limit?: number; issueType?: ReconciliationIssueType } = {},
): Promise<ReconciliationIssuePage> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  if (input.issueType !== undefined) query.set('issueType', input.issueType);
  return apiRequest(
    `/api/v1/maintenance/storage-reconciliation/runs/${encodeURIComponent(runId)}/issues?${query.toString()}`,
  );
}
