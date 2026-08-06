<script setup lang="ts">
import { Archive, Bell, Check, CheckCheck, LoaderCircle, RefreshCw } from '@lucide/vue';
import { onMounted, ref } from 'vue';

import { apiRequest } from '../lib/api';
import { notify, notifyError } from '../stores/notifications';

interface NotificationRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: 'UNREAD' | 'READ' | 'ARCHIVED';
  readAt: string | null;
  createdAt: string;
}

interface NotificationPage {
  items: NotificationRecord[];
  unreadCount: number;
  nextCursor: string | null;
}

const records = ref<NotificationRecord[]>([]);
const unreadCount = ref(0);
const loading = ref(true);
const status = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const query = new URLSearchParams({ limit: '100' });
    if (status.value) query.set('status', status.value);
    const page = await apiRequest<NotificationPage>(`/api/v1/notifications?${query.toString()}`);
    records.value = page.items;
    unreadCount.value = page.unreadCount;
  } catch (error) {
    notifyError(error, '通知加载失败');
  } finally {
    loading.value = false;
  }
}

async function update(record: NotificationRecord, nextStatus: 'READ' | 'ARCHIVED'): Promise<void> {
  try {
    const updated = await apiRequest<NotificationRecord>(`/api/v1/notifications/${record.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    if (status.value && status.value !== updated.status) {
      records.value = records.value.filter((item) => item.id !== record.id);
    } else {
      records.value = records.value.map((item) => (item.id === updated.id ? updated : item));
    }
    if (record.status === 'UNREAD') unreadCount.value = Math.max(0, unreadCount.value - 1);
  } catch (error) {
    notifyError(error, '通知状态更新失败');
  }
}

async function readAll(): Promise<void> {
  try {
    const result = await apiRequest<{ updated: number }>('/api/v1/notifications/read-all', {
      method: 'POST',
    });
    unreadCount.value = 0;
    records.value = records.value.map((record) =>
      record.status === 'UNREAD'
        ? { ...record, status: 'READ', readAt: new Date().toISOString() }
        : record,
    );
    notify('success', `已读 ${result.updated} 条通知`);
  } catch (error) {
    notifyError(error, '全部标记已读失败');
  }
}

function title(record: NotificationRecord): string {
  if (record.type === 'asset.processing.available') return '文件安全处理完成';
  if (record.type === 'asset.processing.infected') return '文件未通过安全检查';
  if (record.type === 'asset.processing.failed') return '文件处理失败';
  if (record.type === 'asset.processing.partial-failure') return '部分内容处理未完成';
  return '系统通知';
}

function detail(record: NotificationRecord): string {
  const payload = record.payload;
  if (typeof payload.signature === 'string') return `检测结果：${payload.signature}`;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.versionNumber === 'number') return `资产版本 V${payload.versionNumber}`;
  return '资产处理状态已更新';
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

onMounted(() => void load());
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">个人消息</p>
      <h1>通知</h1>
    </div>
    <div class="header-actions">
      <span class="count-badge">{{ unreadCount }} 未读</span>
      <label class="compact-select">
        <span class="sr-only">通知状态</span>
        <select v-model="status" @change="load">
          <option value="">全部通知</option>
          <option value="UNREAD">未读</option>
          <option value="READ">已读</option>
          <option value="ARCHIVED">已归档</option>
        </select>
      </label>
      <button class="icon-button" type="button" title="刷新通知" @click="load">
        <RefreshCw :size="18" />
      </button>
      <button class="secondary-button" type="button" :disabled="unreadCount === 0" @click="readAll">
        <CheckCheck :size="16" />全部已读
      </button>
    </div>
  </header>

  <section class="page-section">
    <div v-if="loading" class="loading-state">
      <LoaderCircle class="spinning" :size="21" />加载通知
    </div>
    <div v-else-if="records.length === 0" class="empty-state">
      <Bell :size="27" /><strong>暂无通知</strong>
    </div>
    <div v-else class="data-table notification-table">
      <div class="table-row table-header">
        <span>通知</span><span>状态</span><span>时间</span><span></span>
      </div>
      <div v-for="record in records" :key="record.id" class="table-row">
        <span class="notification-copy">
          <strong>{{ title(record) }}</strong
          ><small>{{ detail(record) }}</small>
        </span>
        <span class="status-badge" :class="{ active: record.status === 'UNREAD' }">
          {{ record.status === 'UNREAD' ? '未读' : record.status === 'READ' ? '已读' : '已归档' }}
        </span>
        <span>{{ formatTime(record.createdAt) }}</span>
        <span class="row-actions">
          <button
            v-if="record.status === 'UNREAD'"
            class="icon-button small"
            type="button"
            title="标记已读"
            @click="update(record, 'READ')"
          >
            <Check :size="15" />
          </button>
          <button
            v-if="record.status !== 'ARCHIVED'"
            class="icon-button small"
            type="button"
            title="归档"
            @click="update(record, 'ARCHIVED')"
          >
            <Archive :size="15" />
          </button>
        </span>
      </div>
    </div>
  </section>
</template>
