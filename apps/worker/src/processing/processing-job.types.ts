export const processingJobTypes = ['MALWARE_SCAN', 'CONTENT_EXTRACT', 'PREVIEW_RENDITION'] as const;

export type ProcessingJobType = (typeof processingJobTypes)[number];

export interface ClaimedProcessingJob {
  id: string;
  assetVersionId: string;
  jobType: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
}

export function retryDelaySeconds(attempt: number, baseSeconds: number): number {
  return Math.min(baseSeconds * 2 ** Math.max(0, attempt - 1), 300);
}
