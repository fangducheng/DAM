<script setup lang="ts">
import { KeyRound, LoaderCircle, ShieldCheck } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { authStore } from '../stores/auth';
import { notifyError } from '../stores/notifications';

const router = useRouter();
const code = ref('');
const submitting = ref(false);
const secondsRemaining = computed(() => {
  if (authStore.state.challengeExpiresAt === null) return 0;
  return Math.max(0, Math.ceil((authStore.state.challengeExpiresAt - Date.now()) / 1000));
});

async function submit(): Promise<void> {
  submitting.value = true;
  try {
    await authStore.completeMfa(code.value.replace(/ /g, ''));
    await router.replace('/status');
  } catch (error) {
    notifyError(error, '验证失败');
  } finally {
    submitting.value = false;
  }
}

async function cancel(): Promise<void> {
  authStore.setAnonymous();
  await router.replace('/login');
}
</script>

<template>
  <main class="auth-layout">
    <section class="auth-panel compact" aria-labelledby="mfa-title">
      <div class="auth-symbol"><ShieldCheck :size="25" /></div>
      <div class="auth-heading centered">
        <h1 id="mfa-title">多因素认证</h1>
        <p>输入验证器代码或恢复码</p>
      </div>
      <form class="form-stack" @submit.prevent="submit">
        <label class="field">
          <span>验证码</span>
          <span class="input-shell code-input">
            <KeyRound :size="17" />
            <input
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              minlength="6"
              maxlength="32"
              autofocus
              required
            />
          </span>
        </label>
        <button class="primary-button full-width" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="17" />
          <span>{{ submitting ? '验证中' : '确认' }}</span>
        </button>
        <button class="text-button" type="button" @click="cancel">返回登录</button>
      </form>
      <div class="auth-expiry">挑战剩余 {{ secondsRemaining }} 秒</div>
    </section>
  </main>
</template>
