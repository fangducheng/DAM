<script setup lang="ts">
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  HardDrive,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ScanSearch,
} from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  createReconciliationRun,
  getReconciliationRun,
  isActiveReconciliationRun,
  listReconciliationIssues,
  listReconciliationRuns,
  mergeReconciliationRuns,
  upsertReconciliationRun,
  type ReconciliationIssue,
  type ReconciliationIssuePage,
  type ReconciliationIssueType,
  type ReconciliationRun,
  type ReconciliationRunPhase,
  type ReconciliationRunStatus,
} from '../lib/maintenance';
import { notify, notifyError } from '../stores/notifications';

defineProps<{ canManage: boolean }>();

interface IssueNavigation {
  cursor: string | null;
  history: Array<string | null>;
  issueType: ReconciliationIssueType | '';
}

const pollIntervalMs = 3_000;
const runs = ref<ReconciliationRun[]>([]);
const runsNextCursor = ref<string | null>(null);
const runsLoading = ref(true);
const runsLoadingMore = ref(false);
const historyError = ref('');
const historyRetryAppend = ref(false);
const selectedRunId = ref<string | null>(null);
const selectedRun = ref<ReconciliationRun | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const submitting = ref(false);
const issueReport = ref<ReconciliationIssuePage | null>(null);
const issueLoading = ref(false);
const issueError = ref('');
const issueCursor = ref<string | null>(null);
const issueCursorHistory = ref<Array<string | null>>([]);
const selectedIssueType = ref<ReconciliationIssueType | ''>('');
const appliedIssueType = ref<ReconciliationIssueType | ''>('');
const issueRetryTarget = ref<IssueNavigation | null>(null);

let detailRequestVersion = 0;
let issueRequestVersion = 0;
let pollTimer: ReturnType<typeof window.setTimeout> | undefined;

const activeRun = computed(
  () =>
    runs.value.find((run) => isActiveReconciliationRun(run.status)) ??
    (selectedRun.value !== null && isActiveReconciliationRun(selectedRun.value.status)
      ? selectedRun.value
      : null),
);

const selectedIssueCount = computed(
  () => (selectedRun.value?.missingObjects ?? 0) + (selectedRun.value?.unknownObjects ?? 0),
);

async function loadRuns(append = false): Promise<void> {
  if (append && runsNextCursor.value === null) return;
  if (append) runsLoadingMore.value = true;
  else runsLoading.value = true;
  historyError.value = '';
  historyRetryAppend.value = false;
  try {
    const page = await listReconciliationRuns({
      ...(append && runsNextCursor.value !== null ? { cursor: runsNextCursor.value } : {}),
      limit: 20,
    });
    runs.value = mergeReconciliationRuns(append ? runs.value : [], page.items);
    runsNextCursor.value = page.nextCursor;

    if (selectedRunId.value === null && runs.value[0] !== undefined) {
      await selectRun(runs.value[0]);
    }
  } catch (error) {
    historyError.value = '对账运行历史暂时无法加载，请检查网络后重试';
    historyRetryAppend.value = append;
    notifyError(error, '对账运行历史加载失败');
  } finally {
    runsLoading.value = false;
    runsLoadingMore.value = false;
  }
}

async function refresh(): Promise<void> {
  await loadRuns(false);
  if (selectedRunId.value !== null) {
    await loadSelectedRun(false);
  }
}

async function retryHistory(): Promise<void> {
  await loadRuns(historyRetryAppend.value);
}

async function selectRun(run: ReconciliationRun): Promise<void> {
  stopPolling();
  selectedRunId.value = run.id;
  selectedRun.value = run;
  detailError.value = '';
  resetIssues();
  await loadSelectedRun(false);
}

async function loadSelectedRun(silent: boolean): Promise<void> {
  const runId = selectedRunId.value;
  if (runId === null) return;
  const requestVersion = ++detailRequestVersion;
  detailLoading.value = true;
  detailError.value = '';
  try {
    const run = await getReconciliationRun(runId);
    if (requestVersion !== detailRequestVersion || selectedRunId.value !== runId) return;
    selectedRun.value = run;
    upsertRun(run);
    if (run.status === 'SUCCEEDED' && issueReport.value === null && !issueLoading.value) {
      await loadIssues({ cursor: null, history: [], issueType: appliedIssueType.value });
    }
  } catch (error) {
    if (requestVersion !== detailRequestVersion || selectedRunId.value !== runId) return;
    detailError.value = '当前对账运行暂时无法刷新，已保留已有状态';
    if (!silent) notifyError(error, '对账运行加载失败');
  } finally {
    if (requestVersion === detailRequestVersion && selectedRunId.value === runId) {
      detailLoading.value = false;
      schedulePolling();
    }
  }
}

async function startRun(sourceRunId?: string): Promise<void> {
  if (submitting.value || activeRun.value !== null) return;
  submitting.value = true;
  try {
    const run = await createReconciliationRun(sourceRunId);
    upsertRun(run);
    notify('success', sourceRunId === undefined ? '存储对账已开始' : '重新核对已开始');
    await selectRun(run);
  } catch (error) {
    notifyError(error, sourceRunId === undefined ? '存储对账启动失败' : '重新核对启动失败');
    await loadRuns(false);
  } finally {
    submitting.value = false;
  }
}

async function loadIssues(target?: IssueNavigation): Promise<void> {
  const runId = selectedRunId.value;
  if (runId === null || selectedRun.value?.status !== 'SUCCEEDED') return;
  const navigation = target ?? {
    cursor: issueCursor.value,
    history: [...issueCursorHistory.value],
    issueType: appliedIssueType.value,
  };
  const requestVersion = ++issueRequestVersion;
  issueLoading.value = true;
  issueError.value = '';
  issueRetryTarget.value = null;
  try {
    const page = await listReconciliationIssues(runId, {
      ...(navigation.cursor === null ? {} : { cursor: navigation.cursor }),
      ...(navigation.issueType === '' ? {} : { issueType: navigation.issueType }),
      limit: 50,
    });
    if (requestVersion !== issueRequestVersion || selectedRunId.value !== runId) return;
    issueReport.value = page;
    issueCursor.value = navigation.cursor;
    issueCursorHistory.value = [...navigation.history];
    appliedIssueType.value = navigation.issueType;
    selectedIssueType.value = navigation.issueType;
  } catch (error) {
    if (requestVersion !== issueRequestVersion || selectedRunId.value !== runId) return;
    selectedIssueType.value = appliedIssueType.value;
    issueError.value = '对账结果暂时无法加载，已保留当前页';
    issueRetryTarget.value = navigation;
    notifyError(error, '对账结果加载失败');
  } finally {
    if (requestVersion === issueRequestVersion && selectedRunId.value === runId) {
      issueLoading.value = false;
    }
  }
}

async function changeIssueType(): Promise<void> {
  await loadIssues({ cursor: null, history: [], issueType: selectedIssueType.value });
}

async function retryIssues(): Promise<void> {
  if (issueRetryTarget.value === null || issueLoading.value) return;
  await loadIssues(issueRetryTarget.value);
}

async function nextIssuePage(): Promise<void> {
  const nextCursor = issueReport.value?.nextCursor;
  if (nextCursor === null || nextCursor === undefined || issueLoading.value) return;
  await loadIssues({
    cursor: nextCursor,
    history: [...issueCursorHistory.value, issueCursor.value],
    issueType: appliedIssueType.value,
  });
}

async function previousIssuePage(): Promise<void> {
  if (issueCursorHistory.value.length === 0 || issueLoading.value) return;
  await loadIssues({
    cursor: issueCursorHistory.value[issueCursorHistory.value.length - 1] ?? null,
    history: issueCursorHistory.value.slice(0, -1),
    issueType: appliedIssueType.value,
  });
}

function resetIssues(): void {
  issueRequestVersion += 1;
  issueReport.value = null;
  issueLoading.value = false;
  issueError.value = '';
  issueCursor.value = null;
  issueCursorHistory.value = [];
  selectedIssueType.value = '';
  appliedIssueType.value = '';
  issueRetryTarget.value = null;
}

function upsertRun(run: ReconciliationRun): void {
  runs.value = upsertReconciliationRun(runs.value, run);
}

function schedulePolling(): void {
  stopPolling();
  if (
    selectedRun.value === null ||
    !isActiveReconciliationRun(selectedRun.value.status) ||
    (typeof document !== 'undefined' && document.hidden)
  ) {
    return;
  }
  pollTimer = window.setTimeout(() => void loadSelectedRun(true), pollIntervalMs);
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    stopPolling();
  } else if (selectedRun.value !== null && isActiveReconciliationRun(selectedRun.value.status)) {
    void loadSelectedRun(true);
  }
}

function statusLabel(status: ReconciliationRunStatus): string {
  return (
    {
      QUEUED: '等待执行',
      RUNNING: '正在核对',
      RETRYING: '等待重试',
      SUCCEEDED: '已完成',
      FAILED: '失败',
    }[status] ?? status
  );
}

function phaseLabel(phase: ReconciliationRunPhase): string {
  return (
    {
      DATABASE_SCAN: '核对数据库对象',
      STORAGE_SCAN: '核对对象存储',
      FINALIZING: '生成结果快照',
      COMPLETE: '快照已完成',
    }[phase] ?? phase
  );
}

function statusDescription(run: ReconciliationRun): string {
  if (run.status === 'QUEUED') return '运行已排队，等待维护 Worker 领取';
  if (run.status === 'RETRYING') return '上一个检查点失败，系统将从安全检查点继续';
  if (run.status === 'RUNNING') return phaseLabel(run.phase);
  if (run.status === 'FAILED') return run.errorMessage ?? '运行未能完成，可启动一次新的核对';
  return run.missingObjects + run.unknownObjects === 0
    ? '核对完成，未发现存储差异'
    : `核对完成，共发现 ${run.missingObjects + run.unknownObjects} 项差异`;
}

function statusTone(run: ReconciliationRun): string {
  if (run.status === 'FAILED') return 'degraded';
  if (run.status === 'SUCCEEDED') {
    return run.missingObjects + run.unknownObjects === 0 ? 'healthy' : 'warning';
  }
  return 'running';
}

function formatTime(value: string | null): string {
  if (value === null) return '--';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(
    new Date(value),
  );
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return `${value} B`;
  if (bytes < 1024) return `${bytes.toLocaleString('zh-CN')} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 'B';
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024) break;
  }
  return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${unit}`;
}

function issueIdentifier(issue: ReconciliationIssue): string {
  return issue.issueType === 'DATABASE_OBJECT_MISSING'
    ? issue.storageObjectId
    : issue.objectFingerprint;
}

function issueSize(issue: ReconciliationIssue): string {
  return formatBytes(
    issue.issueType === 'DATABASE_OBJECT_MISSING'
      ? issue.expectedSizeBytes
      : issue.observedSizeBytes,
  );
}

function issueTime(issue: ReconciliationIssue): string {
  return formatTime(
    issue.issueType === 'DATABASE_OBJECT_MISSING' ? issue.databaseCreatedAt : issue.lastModifiedAt,
  );
}

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void loadRuns(false);
});

onBeforeUnmount(() => {
  detailRequestVersion += 1;
  issueRequestVersion += 1;
  stopPolling();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <section class="reconciliation-console">
    <div class="section-heading reconciliation-console-heading">
      <div>
        <h2>存储对账运行</h2>
        <p>运行结果来自持久化快照，刷新页面不会重新扫描对象存储。</p>
      </div>
      <div class="header-actions">
        <button
          class="icon-button"
          type="button"
          title="刷新对账运行"
          :disabled="runsLoading || detailLoading"
          @click="refresh"
        >
          <RefreshCw :size="18" />
        </button>
        <button
          v-if="canManage"
          class="primary-button"
          type="button"
          :disabled="submitting || activeRun !== null"
          @click="startRun()"
        >
          <LoaderCircle v-if="submitting" class="spinning" :size="16" />
          <ScanSearch v-else :size="16" />开始核对
        </button>
      </div>
    </div>

    <div v-if="runsLoading && runs.length === 0" class="loading-state">
      <LoaderCircle class="spinning" :size="21" />加载对账运行历史
    </div>
    <div v-else-if="historyError && runs.length === 0" class="empty-state error-state" role="alert">
      <AlertTriangle :size="27" /><strong>{{ historyError }}</strong>
      <button class="secondary-button compact" type="button" @click="retryHistory">
        <RefreshCw :size="15" />重新加载
      </button>
    </div>
    <div v-else-if="runs.length === 0" class="empty-state reconciliation-empty-history">
      <History :size="28" />
      <strong>尚无存储对账记录</strong>
      <span>{{
        canManage ? '开始首次核对后，运行进度和结果会保存在这里。' : '管理员尚未开始存储对账。'
      }}</span>
    </div>
    <template v-else>
      <div
        v-if="historyError"
        class="status-strip degraded reconciliation-history-error"
        role="alert"
      >
        <AlertTriangle :size="20" />
        <div>
          <strong>{{ historyError }}</strong
          ><span>现有运行历史已保留。</span>
        </div>
        <button class="secondary-button compact" type="button" @click="retryHistory">
          <RefreshCw :size="15" />重试
        </button>
      </div>

      <div class="master-detail reconciliation-master-detail">
        <aside class="master-pane reconciliation-run-history" aria-label="存储对账运行历史">
          <button
            v-for="run in runs"
            :key="run.id"
            class="master-row reconciliation-run-row"
            :class="{ selected: selectedRunId === run.id }"
            type="button"
            :aria-pressed="selectedRunId === run.id"
            @click="selectRun(run)"
          >
            <span class="reconciliation-run-icon" :class="run.status.toLowerCase()">
              <LoaderCircle
                v-if="isActiveReconciliationRun(run.status)"
                :class="{ spinning: run.status === 'RUNNING' }"
                :size="16"
              />
              <CheckCircle2 v-else-if="run.status === 'SUCCEEDED'" :size="16" />
              <CircleAlert v-else :size="16" />
            </span>
            <span>
              <strong>运行 {{ run.id.slice(0, 8) }}</strong>
              <small
                >{{ formatTime(run.createdAt) }} ·
                {{ run.missingObjects + run.unknownObjects }} 项差异</small
              >
            </span>
            <span
              class="status-badge"
              :class="{
                active: run.status === 'SUCCEEDED',
                disabled: run.status === 'FAILED',
                unknown: run.status === 'RETRYING',
              }"
              >{{ statusLabel(run.status) }}</span
            >
          </button>
          <div v-if="runsNextCursor !== null" class="reconciliation-history-pagination">
            <button
              class="secondary-button compact"
              type="button"
              :disabled="runsLoadingMore"
              @click="loadRuns(true)"
            >
              <LoaderCircle v-if="runsLoadingMore" class="spinning" :size="15" />加载更早运行
            </button>
          </div>
        </aside>

        <section v-if="selectedRun !== null" class="detail-pane reconciliation-run-detail">
          <header class="detail-header">
            <div>
              <p class="eyebrow">运行 {{ selectedRun.id.slice(0, 8) }}</p>
              <h2>{{ statusLabel(selectedRun.status) }}</h2>
              <p>
                {{ selectedRun.requestedBy?.displayName ?? '系统' }} ·
                {{ formatTime(selectedRun.createdAt) }}
                <template v-if="selectedRun.sourceRunId">
                  · 重新核对 {{ selectedRun.sourceRunId.slice(0, 8) }}</template
                >
              </p>
            </div>
            <div class="header-actions">
              <button
                v-if="canManage && !isActiveReconciliationRun(selectedRun.status)"
                class="secondary-button compact"
                type="button"
                :disabled="submitting || activeRun !== null"
                @click="startRun(selectedRun.id)"
              >
                <LoaderCircle v-if="submitting" class="spinning" :size="15" />
                <RotateCcw v-else :size="15" />重新核对
              </button>
            </div>
          </header>

          <div v-if="detailLoading" class="reconciliation-progress" aria-live="polite">
            <LoaderCircle class="spinning" :size="16" />刷新运行状态
          </div>
          <div
            v-if="detailError"
            class="status-strip degraded reconciliation-inline-error"
            role="alert"
          >
            <AlertTriangle :size="20" />
            <div>
              <strong>{{ detailError }}</strong
              ><span>可以重试，当前结果不会被清空。</span>
            </div>
            <button class="secondary-button compact" type="button" @click="loadSelectedRun(false)">
              <RefreshCw :size="15" />重试
            </button>
          </div>

          <div class="status-strip reconciliation-run-status" :class="statusTone(selectedRun)">
            <CheckCircle2 v-if="selectedRun.status === 'SUCCEEDED'" :size="21" />
            <AlertTriangle v-else-if="selectedRun.status === 'FAILED'" :size="21" />
            <LoaderCircle v-else class="spinning" :size="21" />
            <div>
              <strong>{{ statusDescription(selectedRun) }}</strong>
              <span
                >{{ phaseLabel(selectedRun.phase) }} · 更新于
                {{ formatTime(selectedRun.updatedAt) }}</span
              >
            </div>
          </div>

          <section class="reconciliation-run-summary" aria-label="选中存储对账运行摘要">
            <div>
              <small>数据库对象数</small><strong>{{ selectedRun.databaseObjects }}</strong>
            </div>
            <div>
              <small>存储对象数</small><strong>{{ selectedRun.storageObjects }}</strong>
            </div>
            <div :class="{ warning: selectedRun.missingObjects > 0 }">
              <small>数据库记录缺失对象</small><strong>{{ selectedRun.missingObjects }}</strong>
            </div>
            <div :class="{ warning: selectedRun.unknownObjects > 0 }">
              <small>存储中未知对象</small><strong>{{ selectedRun.unknownObjects }}</strong>
            </div>
          </section>

          <dl class="reconciliation-run-meta">
            <div>
              <dt>观测截止</dt>
              <dd>{{ formatTime(selectedRun.cutoffAt) }}</dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{{ formatTime(selectedRun.startedAt) }}</dd>
            </div>
            <div>
              <dt>最后检查点</dt>
              <dd>{{ formatTime(selectedRun.lastCheckpointAt) }}</dd>
            </div>
            <div>
              <dt>完成时间</dt>
              <dd>{{ formatTime(selectedRun.completedAt) }}</dd>
            </div>
          </dl>

          <div v-if="selectedRun.status === 'FAILED'" class="reconciliation-failure-detail">
            <AlertTriangle :size="18" />
            <div>
              <strong>{{ selectedRun.errorMessage ?? '存储对账运行失败' }}</strong>
              <span>错误代码：{{ selectedRun.errorCode ?? 'RECONCILIATION_FAILED' }}</span>
            </div>
          </div>

          <section v-if="selectedRun.status === 'SUCCEEDED'" class="reconciliation-results">
            <div class="section-heading reconciliation-result-heading">
              <div>
                <h3>结果快照</h3>
                <p>{{ selectedIssueCount }} 项差异 · 未知对象仅报告，不会自动删除</p>
              </div>
              <label class="field reconciliation-result-filter">
                <span>差异类型</span>
                <select
                  v-model="selectedIssueType"
                  :disabled="issueLoading"
                  @change="changeIssueType"
                >
                  <option value="">全部</option>
                  <option value="DATABASE_OBJECT_MISSING">数据库对象缺失</option>
                  <option value="STORAGE_OBJECT_UNKNOWN">未知存储对象</option>
                </select>
              </label>
            </div>

            <div v-if="issueLoading && issueReport === null" class="loading-state">
              <LoaderCircle class="spinning" :size="20" />加载结果快照
            </div>
            <div
              v-else-if="issueError && issueReport === null"
              class="empty-state error-state"
              role="alert"
            >
              <AlertTriangle :size="25" /><strong>{{ issueError }}</strong>
              <button class="secondary-button compact" type="button" @click="retryIssues">
                <RefreshCw :size="15" />重新加载
              </button>
            </div>
            <template v-else-if="issueReport !== null">
              <div
                v-if="issueError"
                class="status-strip degraded reconciliation-inline-error"
                role="alert"
              >
                <AlertTriangle :size="20" />
                <div>
                  <strong>{{ issueError }}</strong
                  ><span>当前筛选和页码已保留。</span>
                </div>
                <button class="secondary-button compact" type="button" @click="retryIssues">
                  <RefreshCw :size="15" />重试
                </button>
              </div>
              <div v-if="issueLoading" class="reconciliation-progress" aria-live="polite">
                <LoaderCircle class="spinning" :size="16" />加载目标结果页
              </div>
              <div class="data-table reconciliation-table">
                <div v-if="issueReport.items.length === 0" class="empty-state">
                  <HardDrive :size="26" />
                  <strong>{{
                    appliedIssueType === '' ? '未发现存储差异' : '当前筛选没有匹配的差异'
                  }}</strong>
                </div>
                <template v-else>
                  <div class="table-row table-header">
                    <span>差异类型</span><span>安全标识</span><span>对象大小</span
                    ><span>记录时间</span>
                  </div>
                  <div v-for="issue in issueReport.items" :key="issue.id" class="table-row">
                    <span>
                      <span
                        class="status-badge disabled"
                        :class="{ unknown: issue.issueType === 'STORAGE_OBJECT_UNKNOWN' }"
                        >{{
                          issue.issueType === 'DATABASE_OBJECT_MISSING'
                            ? '数据库对象缺失'
                            : '未知存储对象'
                        }}</span
                      >
                    </span>
                    <span class="reconciliation-identifier" data-label="安全标识">
                      <small>{{
                        issue.issueType === 'DATABASE_OBJECT_MISSING'
                          ? '数据库对象 UUID'
                          : '未知对象指纹'
                      }}</small>
                      <code>{{ issueIdentifier(issue) }}</code>
                    </span>
                    <span data-label="对象大小">{{ issueSize(issue) }}</span>
                    <span data-label="记录时间">{{ issueTime(issue) }}</span>
                  </div>
                </template>
                <footer class="reconciliation-pagination" aria-label="存储对账结果分页">
                  <span>第 {{ issueCursorHistory.length + 1 }} 页</span>
                  <div>
                    <button
                      class="secondary-button compact"
                      type="button"
                      :disabled="issueCursorHistory.length === 0 || issueLoading"
                      @click="previousIssuePage"
                    >
                      <ChevronLeft :size="15" />上一页
                    </button>
                    <button
                      class="secondary-button compact"
                      type="button"
                      :disabled="issueReport.nextCursor === null || issueLoading"
                      @click="nextIssuePage"
                    >
                      下一页<ChevronRight :size="15" />
                    </button>
                  </div>
                </footer>
              </div>
            </template>
          </section>

          <div
            v-else-if="isActiveReconciliationRun(selectedRun.status)"
            class="reconciliation-active-placeholder"
          >
            <Clock3 :size="25" />
            <div>
              <strong>结果快照将在运行完成后显示</strong>
              <span>当前计数来自已提交的安全检查点，页面会自动刷新。</span>
            </div>
          </div>
        </section>
        <div v-else class="empty-state"><Database :size="26" />请选择一个对账运行</div>
      </div>
    </template>
  </section>
</template>
