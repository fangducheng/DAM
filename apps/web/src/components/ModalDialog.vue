<script setup lang="ts">
import { X } from '@lucide/vue';

defineProps<{ title: string; wide?: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="$emit('close')">
    <section
      class="modal-dialog"
      :class="{ wide }"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <header>
        <h2>{{ title }}</h2>
        <button class="icon-button small" type="button" title="关闭" @click="$emit('close')">
          <X :size="17" />
        </button>
      </header>
      <div class="modal-body"><slot /></div>
    </section>
  </div>
</template>
