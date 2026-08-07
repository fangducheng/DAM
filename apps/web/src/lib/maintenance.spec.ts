import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAccessToken } from './api';
import {
  createReconciliationRun,
  getReconciliationRun,
  isActiveReconciliationRun,
  listReconciliationIssues,
  listReconciliationRuns,
  mergeReconciliationRuns,
  type ReconciliationRun,
  upsertReconciliationRun,
} from './maintenance';

const responseHeaders = { 'Content-Type': 'application/json' };

function reconciliationRun(id: string, status: ReconciliationRun['status'] = 'SUCCEEDED') {
  const now = '2026-08-07T08:00:00.000Z';
  return {
    id,
    sourceRunId: null,
    requestedBy: null,
    status,
    phase: status === 'SUCCEEDED' ? ('COMPLETE' as const) : ('DATABASE_SCAN' as const),
    databaseObjects: 1,
    storageObjects: 1,
    missingObjects: 0,
    unknownObjects: 0,
    cutoffAt: now,
    lastCheckpointAt: now,
    startedAt: now,
    completedAt: status === 'SUCCEEDED' ? now : null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  } satisfies ReconciliationRun;
}

describe('maintenance API client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearAccessToken();
    fetchMock.mockReset();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: responseHeaders,
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds safe run-history and issue pagination queries', async () => {
    const runId = '10000000-0000-7000-8000-000000000001';
    const runCursor = '10000000-0000-7000-8000-000000000002';
    const issueCursor = 'a'.repeat(64);

    await listReconciliationRuns({ cursor: runCursor, limit: 25, status: 'FAILED' });
    await listReconciliationIssues(runId, {
      cursor: issueCursor,
      limit: 10,
      issueType: 'STORAGE_OBJECT_UNKNOWN',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/maintenance/storage-reconciliation/runs?limit=25&cursor=${runCursor}&status=FAILED`,
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/maintenance/storage-reconciliation/runs/${runId}/issues?limit=10&cursor=${issueCursor}&issueType=STORAGE_OBJECT_UNKNOWN`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('creates initial and lineage runs with explicit JSON bodies', async () => {
    const sourceRunId = '10000000-0000-7000-8000-000000000003';

    await createReconciliationRun();
    await createReconciliationRun(sourceRunId);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/maintenance/storage-reconciliation/runs',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/maintenance/storage-reconciliation/runs',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ sourceRunId }) }),
    );
  });

  it('loads one run and classifies only non-terminal statuses as active', async () => {
    const runId = '10000000-0000-7000-8000-000000000004';
    await getReconciliationRun(runId);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/maintenance/storage-reconciliation/runs/${runId}`,
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(
      (['QUEUED', 'RUNNING', 'RETRYING'] satisfies ReconciliationRun['status'][]).every(
        isActiveReconciliationRun,
      ),
    ).toBe(true);
    expect(
      (['SUCCEEDED', 'FAILED'] satisfies ReconciliationRun['status'][]).some(
        isActiveReconciliationRun,
      ),
    ).toBe(false);
  });

  it('keeps merged and upserted runs in descending id order', () => {
    const newest = reconciliationRun('30000000-0000-7000-8000-000000000003');
    const middle = reconciliationRun('20000000-0000-7000-8000-000000000002');
    const oldest = reconciliationRun('10000000-0000-7000-8000-000000000001');
    const updatedMiddle = reconciliationRun(middle.id, 'FAILED');

    const merged = mergeReconciliationRuns([oldest, newest], [updatedMiddle]);
    expect(merged.map((run) => run.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(merged[1]?.status).toBe('FAILED');

    const refreshedOldSelection = upsertReconciliationRun([newest, middle], oldest);
    expect(refreshedOldSelection.map((run) => run.id)).toEqual([newest.id, middle.id, oldest.id]);
  });
});
