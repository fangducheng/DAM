<script setup lang="ts">
import { CheckCircle2, ClipboardCopy, KeyRound, LoaderCircle, ShieldCheck } from '@lucide/vue';
import { computed, reactive, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { ApiClientError, apiRequest } from '../lib/api';
import type { ConfirmedInvitationResponse, InvitationAcceptanceResponse } from '../lib/types';
import { notify, notifyError } from '../stores/notifications';

type Stage = 'password' | 'mfa' | 'recovery' | 'complete';

const route = useRoute();
const form = reactive({
  token: typeof route.query.token === 'string' ? route.query.token : '',
  password: '',
  confirmPassword: '',
  code: '',
});
const fieldErrors = reactive<Record<string, string>>({});
const stage = ref<Stage>('password');
const provisioningUri = ref<string | null>(null);
const recoveryCodes = ref<string[]>([]);
const submitting = ref(false);
const passwordMismatch = computed(
  () => form.confirmPassword.length > 0 && form.password !== form.confirmPassword,
);

async function accept(): Promise<void> {
  if (passwordMismatch.value) return;
  submitting.value = true;
  clearFieldErrors();
  try {
    const result = await apiRequest<InvitationAcceptanceResponse>(
      '/api/v1/identity/invitations/accept',
      {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ token: form.token, password: form.password }),
      },
    );
    if (result.mfaVerificationRequired) {
      provisioningUri.value = result.provisioningUri ?? null;
      stage.value = 'mfa';
    } else {
      stage.value = 'complete';
    }
  } catch (error) {
    captureFields(error);
    notifyError(error, '邀请接受失败');
  } finally {
    submitting.value = false;
  }
}

async function confirmMfa(): Promise<void> {
  submitting.value = true;
  clearFieldErrors();
  try {
    const result = await apiRequest<ConfirmedInvitationResponse>(
      '/api/v1/identity/invitations/confirm-mfa',
      {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ token: form.token, code: form.code }),
      },
    );
    recoveryCodes.value = result.recoveryCodes;
    stage.value = result.recoveryCodes.length > 0 ? 'recovery' : 'complete';
  } catch (error) {
    captureFields(error);
    notifyError(error, 'MFA 设置失败');
  } finally {
    submitting.value = false;
  }
}

async function copy(value: string, successMessage: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  notify('success', successMessage);
}

function captureFields(error: unknown): void {
  if (!(error instanceof ApiClientError)) return;
  for (const fieldError of error.fieldErrors) fieldErrors[fieldError.field] = fieldError.message;
}

function clearFieldErrors(): void {
  for (const field of Object.keys(fieldErrors)) delete fieldErrors[field];
}
</script>

<template>
  <main class="auth-layout">
    <section class="auth-panel invitation-panel" aria-labelledby="invite-title">
      <div v-if="stage === 'password'">
        <div class="auth-heading">
          <h1 id="invite-title">接受邀请</h1>
          <p>设置企业账号密码</p>
        </div>
        <form class="form-stack" @submit.prevent="accept">
          <label class="field">
            <span>邀请令牌</span>
            <textarea v-model="form.token" rows="3" required></textarea>
            <small v-if="fieldErrors.token" class="field-error">{{ fieldErrors.token }}</small>
          </label>
          <div class="form-grid two-columns">
            <label class="field">
              <span>新密码</span>
              <input v-model="form.password" type="password" autocomplete="new-password" required />
              <small v-if="fieldErrors.password" class="field-error">{{
                fieldErrors.password
              }}</small>
            </label>
            <label class="field">
              <span>确认密码</span>
              <input
                v-model="form.confirmPassword"
                type="password"
                autocomplete="new-password"
                required
              />
              <small v-if="passwordMismatch" class="field-error">两次输入的密码不一致</small>
            </label>
          </div>
          <button
            class="primary-button full-width"
            type="submit"
            :disabled="submitting || passwordMismatch"
          >
            <LoaderCircle v-if="submitting" class="spinning" :size="17" />
            <span>{{ submitting ? '提交中' : '继续' }}</span>
          </button>
        </form>
      </div>

      <div v-else-if="stage === 'mfa'">
        <div class="auth-symbol"><ShieldCheck :size="25" /></div>
        <div class="auth-heading centered">
          <h1 id="invite-title">设置多因素认证</h1>
          <p>绑定验证器后输入 6 位代码</p>
        </div>
        <div v-if="provisioningUri" class="provisioning-row">
          <code>{{ provisioningUri }}</code>
          <button
            class="icon-button"
            type="button"
            title="复制验证器地址"
            @click="copy(provisioningUri, '验证器地址已复制')"
          >
            <ClipboardCopy :size="17" />
          </button>
        </div>
        <form class="form-stack" @submit.prevent="confirmMfa">
          <label class="field">
            <span>验证码</span>
            <span class="input-shell code-input">
              <KeyRound :size="17" />
              <input
                v-model="form.code"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                required
                autofocus
              />
            </span>
            <small v-if="fieldErrors.code" class="field-error">{{ fieldErrors.code }}</small>
          </label>
          <button class="primary-button full-width" type="submit" :disabled="submitting">
            <LoaderCircle v-if="submitting" class="spinning" :size="17" />
            <span>{{ submitting ? '验证中' : '完成绑定' }}</span>
          </button>
        </form>
      </div>

      <div v-else-if="stage === 'recovery'">
        <div class="auth-heading">
          <h1 id="invite-title">恢复码</h1>
          <p>每个恢复码只能使用一次</p>
        </div>
        <div class="recovery-grid">
          <code v-for="recoveryCode in recoveryCodes" :key="recoveryCode">{{ recoveryCode }}</code>
        </div>
        <button
          class="secondary-button full-width"
          type="button"
          @click="copy(recoveryCodes.join('\n'), '恢复码已复制')"
        >
          <ClipboardCopy :size="17" />
          复制全部
        </button>
        <button class="primary-button full-width" type="button" @click="stage = 'complete'">
          已保存
        </button>
      </div>

      <div v-else class="completion-state">
        <CheckCircle2 :size="34" />
        <h1 id="invite-title">账号已启用</h1>
        <RouterLink class="primary-button" to="/login">前往登录</RouterLink>
      </div>

      <footer v-if="stage === 'password'" class="auth-footer">
        <RouterLink to="/login">返回登录</RouterLink>
      </footer>
    </section>
  </main>
</template>
