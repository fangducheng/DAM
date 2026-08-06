<script setup lang="ts">
import {
  ArchiveRestore,
  AlertTriangle,
  Clock3,
  Download,
  Eye,
  File as FileIcon,
  FileText,
  Folder,
  FolderPlus,
  History,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Tags,
  Trash2,
  Upload,
  X,
} from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import ModalDialog from '../components/ModalDialog.vue';
import { apiRequest } from '../lib/api';
import { notify, notifyError } from '../stores/notifications';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface Space {
  id: string;
  code: string;
  name: string;
  quotaBytes: string;
  usedBytes: string;
  status: 'ACTIVE' | 'DISABLED';
}

interface VersionSummary {
  id: string;
  versionNumber: number;
  status: string;
  scanStatus: string;
  sizeBytes: string;
  mimeType?: string;
  checksumSha256?: string;
  createdAt: string;
  createdBy?: { id: string; displayName: string };
  extraction?: { parserVersion: string; extractedAt: string } | null;
  renditions?: Array<{ id: string; type: string; variant: string; status: string }>;
  processingJobs?: Array<{
    id: string;
    jobType: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    errorMessage: string | null;
  }>;
}

interface TagSummary {
  id: string;
  name: string;
  color: string | null;
}

interface AssetSummary {
  id: string;
  originalFileName: string;
  mimeType: string;
  category: string | null;
  currentVersion: VersionSummary | null;
  _count: { versions: number };
  tags?: TagSummary[];
}

interface ResourceNode {
  id: string;
  spaceId: string;
  parentId: string | null;
  nodeType: 'FOLDER' | 'ASSET';
  name: string;
  status: 'ACTIVE' | 'QUARANTINED' | 'DELETED' | 'PURGING';
  deletedAt: string | null;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; displayName: string };
  asset: AssetSummary | null;
  deletionBatch: {
    id: string;
    rootNodeId: string;
    status: 'RETAINED' | 'PURGE_REQUESTED' | 'PURGING' | 'FAILED';
    deletedAt: string;
    purgeAt: string;
    purgeRequestedAt: string | null;
    itemCount: number;
    sourceBytes: string;
    releasedBytes: string;
    errorMessage: string | null;
  } | null;
  _count: { children: number };
}

interface NodePage {
  parent: { id: string; name: string } | null;
  rootNodeId: string;
  breadcrumb: Array<{ id: string; name: string }>;
  items: ResourceNode[];
  nextCursor: string | null;
}

interface UploadSession {
  id: string;
  partSize: number;
  partCount: number;
  parts: Array<{ partNumber: number; sizeBytes: string }>;
}

interface UploadTask {
  id: number;
  fileName: string;
  progress: number;
  state: 'uploading' | 'processing' | 'complete' | 'error';
  message: string;
}

const router = useRouter();
const spaces = ref<Space[]>([]);
const selectedSpaceId = ref('');
const folderId = ref<string | null>(null);
const rootNodeId = ref('');
const breadcrumb = ref<Array<{ id: string; name: string }>>([]);
const nodes = ref<ResourceNode[]>([]);
const recycleItems = ref<ResourceNode[]>([]);
const mode = ref<'files' | 'recycle'>('files');
const loading = ref(true);
const showFolder = ref(false);
const showRename = ref(false);
const showDelete = ref(false);
const showPurge = ref(false);
const showVersions = ref(false);
const showTags = ref(false);
const submitting = ref(false);
const selectedNode = ref<ResourceNode | null>(null);
const versions = ref<VersionSummary[]>([]);
const currentVersionId = ref<string | null>(null);
const loadingVersions = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const versionTarget = ref<AssetSummary | null>(null);
const uploadTasks = reactive<UploadTask[]>([]);
const folderName = ref('');
const renameValue = ref('');
const purgeConfirmation = ref('');
const searchQuery = ref('');
const selectedSearchTagId = ref('');
const searchActive = ref(false);
const spaceTags = ref<TagSummary[]>([]);
const assetTagIds = ref<string[]>([]);
const newTagName = ref('');
const newTagColor = ref('#2f6f8f');
let nextTaskId = 1;

const selectedSpace = computed(
  () => spaces.value.find((space) => space.id === selectedSpaceId.value) ?? null,
);
const sortedNodes = computed(() =>
  [...nodes.value].sort((left, right) => {
    if (left.nodeType !== right.nodeType) return left.nodeType === 'FOLDER' ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-CN');
  }),
);
const activeTasks = computed(() =>
  uploadTasks.filter((task) => task.state === 'uploading' || task.state === 'processing'),
);

async function loadSpaces(): Promise<void> {
  try {
    spaces.value = (await apiRequest<Page<Space>>('/api/v1/spaces?limit=100')).items.filter(
      (space) => space.status === 'ACTIVE',
    );
    if (!spaces.value.some((space) => space.id === selectedSpaceId.value)) {
      selectedSpaceId.value = spaces.value[0]?.id ?? '';
    }
  } catch (error) {
    notifyError(error, '空间加载失败');
  }
}

async function load(): Promise<void> {
  if (!selectedSpaceId.value) {
    nodes.value = [];
    recycleItems.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    if (mode.value === 'recycle') {
      recycleItems.value = (
        await apiRequest<Page<ResourceNode>>(
          `/api/v1/spaces/${selectedSpaceId.value}/recycle-bin?limit=100`,
        )
      ).items;
      return;
    }
    if (searchActive.value) {
      await searchAssets();
      return;
    }
    const parameters = new URLSearchParams({ limit: '100' });
    if (folderId.value !== null) parameters.set('parentId', folderId.value);
    const page = await apiRequest<NodePage>(
      `/api/v1/spaces/${selectedSpaceId.value}/nodes?${parameters.toString()}`,
    );
    rootNodeId.value = page.rootNodeId;
    breadcrumb.value = page.breadcrumb;
    nodes.value = page.items;
  } catch (error) {
    nodes.value = [];
    recycleItems.value = [];
    notifyError(error, '资产加载失败');
  } finally {
    loading.value = false;
  }
}

async function changeSpace(): Promise<void> {
  folderId.value = null;
  breadcrumb.value = [];
  searchActive.value = false;
  searchQuery.value = '';
  selectedSearchTagId.value = '';
  await loadSpaceTags();
  await load();
}

async function switchMode(nextMode: 'files' | 'recycle'): Promise<void> {
  mode.value = nextMode;
  if (nextMode === 'recycle') searchActive.value = false;
  await load();
}

async function openFolder(id: string | null): Promise<void> {
  searchActive.value = false;
  searchQuery.value = '';
  selectedSearchTagId.value = '';
  folderId.value = id;
  await load();
}

async function loadSpaceTags(): Promise<void> {
  if (!selectedSpaceId.value) {
    spaceTags.value = [];
    return;
  }
  try {
    spaceTags.value = await apiRequest<TagSummary[]>(
      `/api/v1/spaces/${selectedSpaceId.value}/tags`,
    );
  } catch (error) {
    spaceTags.value = [];
    notifyError(error, '标签加载失败');
  }
}

async function runSearch(): Promise<void> {
  searchActive.value = searchQuery.value.trim().length > 0 || selectedSearchTagId.value.length > 0;
  if (!searchActive.value) {
    await load();
    return;
  }
  await searchAssets();
}

async function searchAssets(): Promise<void> {
  if (!selectedSpaceId.value) return;
  loading.value = true;
  try {
    const parameters = new URLSearchParams({ limit: '100' });
    if (searchQuery.value.trim()) parameters.set('q', searchQuery.value.trim());
    if (selectedSearchTagId.value) parameters.set('tagIds', selectedSearchTagId.value);
    nodes.value = (
      await apiRequest<Page<ResourceNode>>(
        `/api/v1/spaces/${selectedSpaceId.value}/search?${parameters.toString()}`,
      )
    ).items;
  } catch (error) {
    nodes.value = [];
    notifyError(error, '资产搜索失败');
  } finally {
    loading.value = false;
  }
}

async function clearSearch(): Promise<void> {
  searchQuery.value = '';
  selectedSearchTagId.value = '';
  searchActive.value = false;
  await load();
}

async function createFolder(): Promise<void> {
  if (!selectedSpaceId.value) return;
  submitting.value = true;
  try {
    await apiRequest(`/api/v1/spaces/${selectedSpaceId.value}/folders`, {
      method: 'POST',
      body: JSON.stringify({
        name: folderName.value,
        ...(folderId.value === null ? {} : { parentId: folderId.value }),
      }),
    });
    showFolder.value = false;
    folderName.value = '';
    notify('success', '文件夹已创建');
    await load();
  } catch (error) {
    notifyError(error, '文件夹创建失败');
  } finally {
    submitting.value = false;
  }
}

function chooseFiles(asset: AssetSummary | null = null): void {
  versionTarget.value = asset;
  fileInput.value?.click();
}

async function onFilesSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  const target = versionTarget.value;
  versionTarget.value = null;
  if (!selectedSpaceId.value || files.length === 0) return;
  if (target !== null && files.length > 1) {
    notify('warning', '添加新版本时一次只能选择一个文件');
    return;
  }
  for (const file of files) {
    void uploadFile(file, target?.id ?? null);
  }
}

async function uploadFile(file: File, assetId: string | null): Promise<void> {
  const task = reactive<UploadTask>({
    id: nextTaskId++,
    fileName: file.name,
    progress: 0,
    state: 'uploading',
    message: assetId === null ? '准备上传' : '准备新版本',
  });
  uploadTasks.push(task);
  try {
    const session = await apiRequest<UploadSession>(
      `/api/v1/spaces/${selectedSpaceId.value}/upload-sessions`,
      {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          sizeBytes: String(file.size),
          mimeType: file.type || 'application/octet-stream',
          ...(assetId === null
            ? folderId.value === null
              ? {}
              : { targetFolderId: folderId.value }
            : { assetId }),
        }),
      },
    );
    task.message = `上传 0 / ${session.partCount} 个分片`;
    let nextPart = 1;
    let uploadedBytes = 0;
    let uploadedParts = 0;
    const worker = async (): Promise<void> => {
      while (nextPart <= session.partCount) {
        const partNumber = nextPart++;
        const start = (partNumber - 1) * session.partSize;
        const chunk = file.slice(start, Math.min(file.size, start + session.partSize));
        const signed = await apiRequest<{ url: string }>(
          `/api/v1/upload-sessions/${session.id}/parts/${partNumber}/url`,
        );
        const response = await fetch(signed.url, { method: 'PUT', body: chunk });
        if (!response.ok) throw new Error(`对象存储返回 HTTP ${response.status}`);
        const etag = response.headers.get('ETag');
        if (etag === null) throw new Error('对象存储未返回可读取的 ETag，请检查 MinIO CORS');
        await apiRequest(`/api/v1/upload-sessions/${session.id}/parts/${partNumber}`, {
          method: 'PUT',
          body: JSON.stringify({ etag, sizeBytes: String(chunk.size) }),
        });
        uploadedBytes += chunk.size;
        uploadedParts += 1;
        task.progress = Math.min(95, Math.round((uploadedBytes / file.size) * 95));
        task.message = `上传 ${uploadedParts} / ${session.partCount} 个分片`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, session.partCount) }, async () => worker()));
    task.state = 'processing';
    task.progress = 97;
    task.message = '校验文件并写入版本';
    const completed = await apiRequest<{ status: string; scanStatus: string }>(
      `/api/v1/upload-sessions/${session.id}/complete`,
      { method: 'POST' },
    );
    task.state = 'complete';
    task.progress = 100;
    task.message =
      completed.status === 'AVAILABLE'
        ? assetId === null
          ? '上传完成'
          : '新版本已创建'
        : '已上传，等待安全处理';
    notify(completed.status === 'AVAILABLE' ? 'success' : 'info', task.message, file.name);
    window.setTimeout(() => removeTask(task.id), 3500);
    await load();
    if (assetId !== null && showVersions.value) await loadVersions(assetId);
  } catch (error) {
    task.state = 'error';
    task.message = error instanceof Error ? error.message : '上传失败';
    notifyError(error, '文件上传失败');
  }
}

function removeTask(id: number): void {
  const index = uploadTasks.findIndex((task) => task.id === id);
  if (index >= 0) uploadTasks.splice(index, 1);
}

async function preview(node: ResourceNode): Promise<void> {
  const popup = window.open('about:blank', '_blank');
  if (popup !== null) popup.opener = null;
  try {
    const result = await apiRequest<{ url: string }>(`/api/v1/resource-nodes/${node.id}/preview`);
    if (popup !== null) popup.location.href = result.url;
    else window.location.href = result.url;
  } catch (error) {
    popup?.close();
    notifyError(error, '预览失败');
  }
}

async function download(node: ResourceNode): Promise<void> {
  try {
    const result = await apiRequest<{ url: string }>(`/api/v1/resource-nodes/${node.id}/download`);
    triggerDownload(result.url);
  } catch (error) {
    notifyError(error, '下载失败');
  }
}

async function downloadVersion(version: VersionSummary): Promise<void> {
  try {
    const result = await apiRequest<{ url: string }>(
      `/api/v1/asset-versions/${version.id}/download`,
    );
    triggerDownload(result.url);
  } catch (error) {
    notifyError(error, '版本下载失败');
  }
}

function triggerDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.click();
}

async function openVersions(node: ResourceNode): Promise<void> {
  if (node.asset === null) return;
  selectedNode.value = node;
  showVersions.value = true;
  await loadVersions(node.asset.id);
}

async function loadVersions(assetId: string): Promise<void> {
  loadingVersions.value = true;
  try {
    const result = await apiRequest<{ currentVersionId: string | null; items: VersionSummary[] }>(
      `/api/v1/assets/${assetId}/versions`,
    );
    versions.value = result.items;
    currentVersionId.value = result.currentVersionId;
  } catch (error) {
    notifyError(error, '版本历史加载失败');
  } finally {
    loadingVersions.value = false;
  }
}

async function setCurrentVersion(version: VersionSummary): Promise<void> {
  const assetId = selectedNode.value?.asset?.id;
  if (assetId === undefined) return;
  try {
    await apiRequest(`/api/v1/assets/${assetId}/current-version`, {
      method: 'PUT',
      body: JSON.stringify({ versionId: version.id }),
    });
    currentVersionId.value = version.id;
    notify('success', `已切换到版本 ${version.versionNumber}`);
    await load();
  } catch (error) {
    notifyError(error, '版本切换失败');
  }
}

function openRename(node: ResourceNode): void {
  selectedNode.value = node;
  renameValue.value = node.name;
  showRename.value = true;
}

async function renameNode(): Promise<void> {
  if (selectedNode.value === null) return;
  submitting.value = true;
  try {
    await apiRequest(`/api/v1/resource-nodes/${selectedNode.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: renameValue.value,
        lockVersion: selectedNode.value.lockVersion,
      }),
    });
    showRename.value = false;
    notify('success', '名称已更新');
    await load();
  } catch (error) {
    notifyError(error, '重命名失败');
  } finally {
    submitting.value = false;
  }
}

function confirmDelete(node: ResourceNode): void {
  selectedNode.value = node;
  showDelete.value = true;
}

async function trashNode(): Promise<void> {
  if (selectedNode.value === null) return;
  submitting.value = true;
  try {
    await apiRequest<void>(`/api/v1/resource-nodes/${selectedNode.value.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ lockVersion: selectedNode.value.lockVersion }),
    });
    showDelete.value = false;
    notify('success', '资源已移入回收站');
    await load();
  } catch (error) {
    notifyError(error, '删除失败');
  } finally {
    submitting.value = false;
  }
}

async function restoreNode(node: ResourceNode): Promise<void> {
  try {
    await apiRequest(`/api/v1/resource-nodes/${node.id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ lockVersion: node.lockVersion }),
    });
    notify('success', '资源已恢复');
    await load();
  } catch (error) {
    notifyError(error, '恢复失败');
  }
}

function confirmPurge(node: ResourceNode): void {
  selectedNode.value = node;
  purgeConfirmation.value = '';
  showPurge.value = true;
}

async function purgeNode(): Promise<void> {
  if (selectedNode.value === null) return;
  submitting.value = true;
  try {
    await apiRequest(`/api/v1/resource-nodes/${selectedNode.value.id}/purge`, {
      method: 'POST',
      body: JSON.stringify({
        lockVersion: selectedNode.value.lockVersion,
        confirmationName: purgeConfirmation.value,
      }),
    });
    showPurge.value = false;
    notify('success', '永久删除请求已提交');
    await load();
  } catch (error) {
    notifyError(error, '永久删除请求失败');
  } finally {
    submitting.value = false;
  }
}

function openPermissions(node: ResourceNode): void {
  void router.push({ path: '/permissions', query: { nodeId: node.id } });
}

async function openTagEditor(node: ResourceNode): Promise<void> {
  if (node.asset === null) return;
  selectedNode.value = node;
  showTags.value = true;
  try {
    const [allTags, assigned] = await Promise.all([
      apiRequest<TagSummary[]>(`/api/v1/spaces/${selectedSpaceId.value}/tags`),
      apiRequest<TagSummary[]>(`/api/v1/assets/${node.asset.id}/tags`),
    ]);
    spaceTags.value = allTags;
    assetTagIds.value = assigned.map((tag) => tag.id);
  } catch (error) {
    notifyError(error, '资产标签加载失败');
  }
}

async function createTag(): Promise<void> {
  if (!newTagName.value.trim()) return;
  submitting.value = true;
  try {
    const created = await apiRequest<TagSummary>(`/api/v1/spaces/${selectedSpaceId.value}/tags`, {
      method: 'POST',
      body: JSON.stringify({ name: newTagName.value, color: newTagColor.value }),
    });
    newTagName.value = '';
    await loadSpaceTags();
    assetTagIds.value = [...new Set([...assetTagIds.value, created.id])];
  } catch (error) {
    notifyError(error, '标签创建失败');
  } finally {
    submitting.value = false;
  }
}

async function removeTag(tag: TagSummary): Promise<void> {
  try {
    await apiRequest<void>(`/api/v1/spaces/${selectedSpaceId.value}/tags/${tag.id}`, {
      method: 'DELETE',
    });
    assetTagIds.value = assetTagIds.value.filter((id) => id !== tag.id);
    await loadSpaceTags();
  } catch (error) {
    notifyError(error, '标签删除失败');
  }
}

async function saveAssetTags(): Promise<void> {
  const assetId = selectedNode.value?.asset?.id;
  if (assetId === undefined) return;
  submitting.value = true;
  try {
    await apiRequest(`/api/v1/assets/${assetId}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tagIds: assetTagIds.value }),
    });
    showTags.value = false;
    notify('success', '资产标签已更新');
    await load();
  } catch (error) {
    notifyError(error, '资产标签保存失败');
  } finally {
    submitting.value = false;
  }
}

function processingLabel(version: VersionSummary): string {
  if (version.scanStatus === 'INFECTED') return '已拒绝';
  if (version.status === 'FAILED') return '处理失败';
  if (version.status === 'AVAILABLE') return version.scanStatus === 'SKIPPED' ? '本地可用' : '可用';
  const running = version.processingJobs?.find((job) => job.status === 'RUNNING');
  if (running?.jobType === 'MALWARE_SCAN') return '安全扫描';
  return '处理中';
}

function formatBytes(value: string | number): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const level = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** level;
  return `${amount.toFixed(level === 0 || amount >= 10 ? 0 : 1)} ${units[level]}`;
}

function formatTime(value: string | null): string {
  if (value === null) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function remainingDays(node: ResourceNode): number {
  if (node.deletionBatch === null) return 0;
  return Math.max(
    0,
    Math.ceil((new Date(node.deletionBatch.purgeAt).getTime() - Date.now()) / 86_400_000),
  );
}

function deletionStatus(node: ResourceNode): string {
  switch (node.deletionBatch?.status) {
    case 'RETAINED':
      return '可恢复';
    case 'PURGE_REQUESTED':
    case 'PURGING':
      return '等待永久删除';
    case 'FAILED':
      return '清理失败';
    default:
      return '状态未知';
  }
}

onMounted(async () => {
  await loadSpaces();
  await loadSpaceTags();
  await load();
});
</script>

<template>
  <header class="page-header asset-page-header">
    <div>
      <p class="eyebrow">文件与资料</p>
      <h1>资产库</h1>
    </div>
    <div class="header-actions">
      <label class="space-selector">
        <span class="sr-only">当前空间</span>
        <select v-model="selectedSpaceId" @change="changeSpace">
          <option v-if="spaces.length === 0" value="">暂无可用空间</option>
          <option v-for="space in spaces" :key="space.id" :value="space.id">
            {{ space.name }}
          </option>
        </select>
      </label>
      <button class="icon-button" type="button" title="刷新" @click="load">
        <RefreshCw :size="18" />
      </button>
      <button
        v-if="mode === 'files'"
        class="secondary-button"
        type="button"
        :disabled="!selectedSpaceId"
        @click="showFolder = true"
      >
        <FolderPlus :size="17" />新建文件夹
      </button>
      <button
        v-if="mode === 'files'"
        class="primary-button"
        type="button"
        :disabled="!selectedSpaceId"
        @click="chooseFiles()"
      >
        <Upload :size="17" />上传文件
      </button>
      <input ref="fileInput" class="sr-only" type="file" multiple @change="onFilesSelected" />
    </div>
  </header>

  <section v-if="selectedSpace" class="asset-capacity" aria-label="空间容量">
    <span>{{ selectedSpace.name }}</span>
    <div class="capacity-track">
      <span
        :style="{
          width:
            selectedSpace.quotaBytes === '0'
              ? '0%'
              : `${Math.min(100, (Number(selectedSpace.usedBytes) / Number(selectedSpace.quotaBytes)) * 100)}%`,
        }"
      ></span>
    </div>
    <strong>
      {{ formatBytes(selectedSpace.usedBytes) }} /
      {{ selectedSpace.quotaBytes === '0' ? '不限' : formatBytes(selectedSpace.quotaBytes) }}
    </strong>
  </section>

  <section v-if="uploadTasks.length > 0" class="upload-queue" aria-label="上传任务">
    <div v-for="task in uploadTasks" :key="task.id" class="upload-task">
      <span class="row-icon"><FileText :size="17" /></span>
      <div>
        <strong>{{ task.fileName }}</strong>
        <small>{{ task.message }}</small>
        <div class="upload-progress"><span :style="{ width: `${task.progress}%` }"></span></div>
      </div>
      <span class="upload-percent">{{ task.progress }}%</span>
      <button
        v-if="task.state === 'complete' || task.state === 'error'"
        class="icon-button small"
        type="button"
        title="移除任务"
        @click="removeTask(task.id)"
      >
        <X :size="15" />
      </button>
      <LoaderCircle v-else class="spinning upload-spinner" :size="17" />
    </div>
  </section>

  <div class="asset-mode-tabs" role="tablist" aria-label="资产视图">
    <button
      type="button"
      role="tab"
      :aria-selected="mode === 'files'"
      :class="{ active: mode === 'files' }"
      @click="switchMode('files')"
    >
      <Folder :size="16" />文件
    </button>
    <button
      type="button"
      role="tab"
      :aria-selected="mode === 'recycle'"
      :class="{ active: mode === 'recycle' }"
      @click="switchMode('recycle')"
    >
      <Trash2 :size="16" />回收站
    </button>
  </div>

  <form v-if="mode === 'files'" class="asset-search-toolbar" @submit.prevent="runSearch">
    <label class="search-field">
      <Search :size="16" aria-hidden="true" />
      <input v-model="searchQuery" maxlength="200" placeholder="搜索文件名或文档内容" />
    </label>
    <label class="tag-filter">
      <span class="sr-only">按标签筛选</span>
      <select v-model="selectedSearchTagId">
        <option value="">全部标签</option>
        <option v-for="tag in spaceTags" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
      </select>
    </label>
    <button class="primary-button compact" type="submit"><Search :size="15" />搜索</button>
    <button
      v-if="searchActive"
      class="icon-button"
      type="button"
      title="清除搜索"
      @click="clearSearch"
    >
      <X :size="16" />
    </button>
  </form>

  <section v-if="mode === 'files'" class="asset-browser">
    <nav class="breadcrumb" aria-label="当前目录">
      <template v-if="searchActive">
        <Search :size="14" /><strong>搜索结果</strong><span>{{ nodes.length }} 项</span>
      </template>
      <template v-else>
        <button type="button" :class="{ current: folderId === null }" @click="openFolder(null)">
          资产库
        </button>
        <template v-for="item in breadcrumb" :key="item.id">
          <span>/</span>
          <button
            type="button"
            :class="{ current: item.id === folderId }"
            @click="openFolder(item.id)"
          >
            {{ item.name }}
          </button>
        </template>
      </template>
    </nav>

    <div v-if="loading" class="loading-state">
      <LoaderCircle class="spinning" :size="20" />加载资产
    </div>
    <div v-else-if="sortedNodes.length > 0" class="asset-table">
      <div class="asset-row asset-row-header">
        <span>名称</span><span>大小</span><span>修改时间</span><span>创建者</span><span></span>
      </div>
      <div v-for="node in sortedNodes" :key="node.id" class="asset-row">
        <button
          class="asset-name"
          type="button"
          @click="node.nodeType === 'FOLDER' ? openFolder(node.id) : openVersions(node)"
        >
          <span class="asset-icon" :class="node.nodeType.toLowerCase()">
            <Folder v-if="node.nodeType === 'FOLDER'" :size="19" />
            <FileIcon v-else :size="19" />
          </span>
          <span>
            <strong>{{ node.name }}</strong>
            <small v-if="node.nodeType === 'FOLDER'">{{ node._count.children }} 个项目</small>
            <small v-else>
              {{ node.asset?.mimeType }} · {{ node.asset?._count.versions ?? 0 }} 个版本
            </small>
          </span>
        </button>
        <span data-label="大小">{{ formatBytes(node.asset?.currentVersion?.sizeBytes ?? 0) }}</span>
        <span data-label="修改时间">{{ formatTime(node.updatedAt) }}</span>
        <span data-label="创建者">{{ node.createdBy.displayName }}</span>
        <span class="row-actions asset-actions">
          <button
            v-if="node.nodeType === 'ASSET'"
            class="icon-button small"
            type="button"
            title="预览"
            @click="preview(node)"
          >
            <Eye :size="15" />
          </button>
          <button
            v-if="node.nodeType === 'ASSET'"
            class="icon-button small"
            type="button"
            title="下载"
            @click="download(node)"
          >
            <Download :size="15" />
          </button>
          <button
            v-if="node.nodeType === 'ASSET'"
            class="icon-button small"
            type="button"
            title="版本历史"
            @click="openVersions(node)"
          >
            <History :size="15" />
          </button>
          <button
            v-if="node.nodeType === 'ASSET'"
            class="icon-button small"
            type="button"
            title="资产标签"
            @click="openTagEditor(node)"
          >
            <Tags :size="15" />
          </button>
          <button
            class="icon-button small"
            type="button"
            title="目录权限"
            @click="openPermissions(node)"
          >
            <KeyRound :size="15" />
          </button>
          <button class="icon-button small" type="button" title="重命名" @click="openRename(node)">
            <Pencil :size="15" />
          </button>
          <button
            class="icon-button small danger"
            type="button"
            title="移入回收站"
            @click="confirmDelete(node)"
          >
            <Trash2 :size="15" />
          </button>
        </span>
      </div>
    </div>
    <div v-else class="empty-state asset-empty">
      <Search v-if="searchActive" :size="28" />
      <Upload v-else :size="28" />
      <strong>{{ searchActive ? '没有匹配的资产' : '当前目录暂无文件' }}</strong>
      <button v-if="!searchActive" class="primary-button" type="button" @click="chooseFiles()">
        <Upload :size="16" />上传文件
      </button>
    </div>
  </section>

  <section v-else class="asset-browser">
    <div v-if="loading" class="loading-state">
      <LoaderCircle class="spinning" :size="20" />加载回收站
    </div>
    <div v-else-if="recycleItems.length > 0" class="asset-table recycle-table">
      <div class="asset-row asset-row-header">
        <span>名称</span><span>类型</span><span>自动清理</span><span>容量与状态</span><span></span>
      </div>
      <div v-for="node in recycleItems" :key="node.id" class="asset-row">
        <div class="asset-name">
          <span class="asset-icon muted">
            <Folder v-if="node.nodeType === 'FOLDER'" :size="19" />
            <FileIcon v-else :size="19" />
          </span>
          <span
            ><strong>{{ node.name }}</strong
            ><small
              >{{ node.deletionBatch?.itemCount ?? 1 }} 个项目 ·
              {{ formatTime(node.deletedAt) }}</small
            ></span
          >
        </div>
        <span data-label="类型">{{ node.nodeType === 'FOLDER' ? '文件夹' : '文件' }}</span>
        <span class="recycle-deadline" data-label="自动清理">
          <strong v-if="node.deletionBatch?.status === 'RETAINED'"
            ><Clock3 :size="14" />剩余 {{ remainingDays(node) }} 天</strong
          >
          <strong v-else>{{ deletionStatus(node) }}</strong>
          <small>{{ formatTime(node.deletionBatch?.purgeAt ?? null) }}</small>
        </span>
        <span class="recycle-state" data-label="容量与状态">
          <strong>{{ formatBytes(node.deletionBatch?.sourceBytes ?? 0) }}</strong>
          <small
            class="status-badge"
            :class="{
              active: node.deletionBatch?.status === 'RETAINED',
              disabled: node.deletionBatch?.status === 'FAILED',
            }"
            >{{ deletionStatus(node) }}</small
          >
        </span>
        <span class="row-actions">
          <button
            v-if="node.deletionBatch?.status === 'RETAINED'"
            class="secondary-button compact"
            type="button"
            @click="restoreNode(node)"
          >
            <RotateCcw :size="15" />恢复
          </button>
          <button
            v-if="node.deletionBatch?.status === 'RETAINED'"
            class="icon-button small danger"
            type="button"
            title="永久删除"
            @click="confirmPurge(node)"
          >
            <Trash2 :size="15" />
          </button>
        </span>
      </div>
    </div>
    <div v-else class="empty-state asset-empty">
      <ArchiveRestore :size="28" /><strong>回收站为空</strong>
    </div>
  </section>

  <ModalDialog v-if="showFolder" title="新建文件夹" @close="showFolder = false">
    <form class="form-stack" @submit.prevent="createFolder">
      <label class="field"
        ><span>文件夹名称</span><input v-model="folderName" required maxlength="255"
      /></label>
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="showFolder = false">取消</button>
        <button class="primary-button" type="submit" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spinning" :size="16" />创建
        </button>
      </div>
    </form>
  </ModalDialog>

  <ModalDialog v-if="showRename" title="重命名" @close="showRename = false">
    <form class="form-stack" @submit.prevent="renameNode">
      <label class="field"
        ><span>新名称</span><input v-model="renameValue" required maxlength="255"
      /></label>
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="showRename = false">取消</button>
        <button class="primary-button" type="submit" :disabled="submitting">保存</button>
      </div>
    </form>
  </ModalDialog>

  <ModalDialog v-if="showDelete" title="移入回收站" @close="showDelete = false">
    <div class="confirm-content">
      <Trash2 :size="24" />
      <div>
        <strong>{{ selectedNode?.name }}</strong>
        <p>文件夹内的可见子项会作为同一批次移入回收站。</p>
      </div>
    </div>
    <div class="modal-actions">
      <button class="secondary-button" type="button" @click="showDelete = false">取消</button>
      <button class="danger-button" type="button" :disabled="submitting" @click="trashNode">
        移入回收站
      </button>
    </div>
  </ModalDialog>

  <ModalDialog v-if="showPurge" title="永久删除" @close="showPurge = false">
    <div class="confirm-content destructive-confirmation">
      <AlertTriangle :size="24" />
      <div>
        <strong>此操作不可撤销</strong>
        <p>资源及全部历史版本将被永久删除，空间容量会在后台清理完成后释放。</p>
      </div>
    </div>
    <label class="field">
      <span>输入“{{ selectedNode?.name }}”确认</span>
      <input v-model="purgeConfirmation" maxlength="255" autocomplete="off" />
    </label>
    <div class="modal-actions">
      <button class="secondary-button" type="button" @click="showPurge = false">取消</button>
      <button
        class="danger-button"
        type="button"
        :disabled="submitting || purgeConfirmation !== selectedNode?.name"
        @click="purgeNode"
      >
        <LoaderCircle v-if="submitting" class="spinning" :size="16" />永久删除
      </button>
    </div>
  </ModalDialog>

  <ModalDialog
    v-if="showTags"
    :title="`${selectedNode?.name ?? ''} · 资产标签`"
    @close="showTags = false"
  >
    <div class="tag-editor">
      <div v-if="spaceTags.length > 0" class="tag-choice-list">
        <label v-for="tag in spaceTags" :key="tag.id" class="tag-choice">
          <input v-model="assetTagIds" type="checkbox" :value="tag.id" />
          <span class="tag-swatch" :style="{ backgroundColor: tag.color ?? '#77838a' }"></span>
          <strong>{{ tag.name }}</strong>
          <button
            class="icon-button small danger"
            type="button"
            title="删除标签"
            @click.prevent="removeTag(tag)"
          >
            <Trash2 :size="14" />
          </button>
        </label>
      </div>
      <div v-else class="empty-state compact"><Tags :size="22" /><strong>暂无标签</strong></div>
      <form class="tag-create-row" @submit.prevent="createTag">
        <input v-model="newTagColor" type="color" title="标签颜色" />
        <input v-model="newTagName" maxlength="100" placeholder="新标签名称" />
        <button class="secondary-button compact" type="submit" :disabled="submitting">
          <Plus :size="15" />新建
        </button>
      </form>
    </div>
    <div class="modal-actions">
      <button class="secondary-button" type="button" @click="showTags = false">取消</button>
      <button class="primary-button" type="button" :disabled="submitting" @click="saveAssetTags">
        保存标签
      </button>
    </div>
  </ModalDialog>

  <ModalDialog
    v-if="showVersions"
    :title="`${selectedNode?.name ?? ''} · 版本历史`"
    wide
    @close="showVersions = false"
  >
    <div class="version-toolbar">
      <span>版本内容不可变，切换当前版本不会删除历史文件。</span>
      <button
        v-if="selectedNode?.asset"
        class="secondary-button"
        type="button"
        @click="chooseFiles(selectedNode.asset)"
      >
        <Upload :size="16" />上传新版本
      </button>
    </div>
    <div v-if="loadingVersions" class="loading-state">
      <LoaderCircle class="spinning" :size="20" />加载版本
    </div>
    <div v-else class="version-list">
      <div v-for="version in versions" :key="version.id" class="version-row">
        <span class="version-number">V{{ version.versionNumber }}</span>
        <div>
          <strong>{{ formatBytes(version.sizeBytes) }} · {{ version.mimeType }}</strong>
          <small>{{ formatTime(version.createdAt) }} · {{ version.createdBy?.displayName }}</small>
          <small v-if="version.processingJobs?.some((job) => job.status === 'DEAD')">
            {{ version.processingJobs.find((job) => job.status === 'DEAD')?.errorMessage }}
          </small>
        </div>
        <span
          class="status-badge"
          :class="{
            active: version.status === 'AVAILABLE',
            disabled: version.status === 'FAILED' || version.status === 'REJECTED',
          }"
        >
          {{ processingLabel(version) }}
        </span>
        <span class="row-actions">
          <span v-if="version.id === currentVersionId" class="current-version">当前</span>
          <button
            v-else-if="version.status === 'AVAILABLE'"
            class="text-button"
            type="button"
            @click="setCurrentVersion(version)"
          >
            <RotateCcw :size="14" />设为当前
          </button>
          <button
            v-if="version.status === 'AVAILABLE'"
            class="icon-button small"
            type="button"
            title="下载此版本"
            @click="downloadVersion(version)"
          >
            <Download :size="15" />
          </button>
        </span>
      </div>
    </div>
  </ModalDialog>

  <span v-if="activeTasks.length > 0" class="sr-only" aria-live="polite">
    {{ activeTasks.length }} 个上传任务正在处理
  </span>
</template>
