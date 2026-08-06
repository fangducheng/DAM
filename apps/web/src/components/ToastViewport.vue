<script setup lang="ts">
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from '@lucide/vue';

import { dismiss, notificationStore, type NoticeTone } from '../stores/notifications';

const icons: Record<NoticeTone, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: TriangleAlert,
  info: Info,
};
</script>

<template>
  <div class="toast-viewport" aria-live="polite" aria-atomic="false">
    <div
      v-for="notice in notificationStore.notices"
      :key="notice.id"
      class="toast"
      :class="notice.tone"
      role="status"
    >
      <component :is="icons[notice.tone]" :size="18" aria-hidden="true" />
      <div>
        <strong>{{ notice.title }}</strong>
        <span v-if="notice.message">{{ notice.message }}</span>
      </div>
      <button type="button" title="关闭消息" aria-label="关闭消息" @click="dismiss(notice.id)">
        <X :size="16" />
      </button>
    </div>
  </div>
</template>
