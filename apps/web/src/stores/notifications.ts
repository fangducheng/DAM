import { reactive } from 'vue';

import { ApiClientError } from '../lib/api';

export type NoticeTone = 'success' | 'error' | 'warning' | 'info';

export interface Notice {
  id: number;
  tone: NoticeTone;
  title: string;
  message?: string;
}

const notices = reactive<Notice[]>([]);
let nextId = 1;

export function notify(tone: NoticeTone, title: string, message?: string): void {
  const notice: Notice = {
    id: nextId++,
    tone,
    title,
    ...(message === undefined ? {} : { message }),
  };
  notices.push(notice);
  window.setTimeout(() => dismiss(notice.id), tone === 'error' ? 8000 : 4500);
}

export function notifyError(error: unknown, fallback = '操作失败'): void {
  if (error instanceof ApiClientError) {
    const detail =
      error.code === 'TOO_MANY_ATTEMPTS' && error.retryAfterSeconds !== null
        ? `请在 ${error.retryAfterSeconds} 秒后重试`
        : error.status >= 500 && error.requestId.length > 0
          ? `请求编号：${error.requestId}`
          : undefined;
    notify('error', error.message, detail);
    return;
  }
  notify('error', fallback);
}

export function dismiss(id: number): void {
  const index = notices.findIndex((notice) => notice.id === id);
  if (index >= 0) notices.splice(index, 1);
}

export const notificationStore = { notices };
