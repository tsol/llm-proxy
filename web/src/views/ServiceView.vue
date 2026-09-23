<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, type Component } from 'vue';
import { useRoute } from 'vue-router';
import SchemaForm from '../components/SchemaForm.vue';
import {
  cancelJob,
  fetchJobHistory,
  fetchService,
  fetchServiceSettings,
  putServiceSettings,
  submitServiceJob,
  type ServiceInfo,
} from '../api';

const route = useRoute();
const serviceId = computed(() => String(route.params.id));

const svc = ref<ServiceInfo | null>(null);
const tab = ref<'settings' | 'run' | 'history'>('run');
const settingsSchema = ref<Record<string, unknown> | null>(null);
const settingsValues = ref<Record<string, unknown>>({});
const runInput = ref<Record<string, unknown>>({});
const history = ref<Record<string, unknown>[]>([]);
const runStatus = ref('');
const settingsStatus = ref('');

const customModules = import.meta.glob('../../../services/*/ui/Settings.vue');
const customComponent = shallowRef<Component | null>(null);

async function load() {
  const id = serviceId.value;
  svc.value = await fetchService(id);
  runInput.value = {};
  if (svc.value?.has_settings) {
    const s = await fetchServiceSettings(id);
    settingsSchema.value = s.schema;
    settingsValues.value = { ...s.values };
  }
  const match = Object.keys(customModules).find((p) => p.includes(`/services/${id}/ui/`));
  if (match) {
    const mod = await customModules[match]() as { default: Component };
    customComponent.value = mod.default;
  } else {
    customComponent.value = null;
  }
  history.value = await fetchJobHistory(id);
}

onMounted(() => { void load(); });

async function saveSettings() {
  settingsStatus.value = 'Saving…';
  try {
    const v = await putServiceSettings(serviceId.value, settingsValues.value);
    settingsValues.value = v;
    settingsStatus.value = 'Saved';
  } catch (e) {
    settingsStatus.value = e instanceof Error ? e.message : 'Save failed';
  }
}

async function runJob() {
  runStatus.value = 'Submitting…';
  try {
    const job = await submitServiceJob(serviceId.value, runInput.value, 300);
    runStatus.value = `Job ${job.id}: ${job.status}`;
    history.value = await fetchJobHistory(serviceId.value);
    if (tab.value !== 'history') tab.value = 'history';
  } catch (e) {
    runStatus.value = e instanceof Error ? e.message : 'Failed';
  }
}

async function onCancel(jobId: string) {
  await cancelJob(jobId);
  history.value = await fetchJobHistory(serviceId.value);
}
</script>

<template>
  <div v-if="svc">
    <p><router-link to="/services">← Services</router-link></p>
    <h1>{{ svc.title }}</h1>
    <p class="desc">{{ svc.description }}</p>
    <nav class="tabs">
      <button :class="{ active: tab === 'settings' }" :disabled="!svc.has_settings" @click="tab = 'settings'">
        Settings
      </button>
      <button :class="{ active: tab === 'run' }" @click="tab = 'run'">Run</button>
      <button :class="{ active: tab === 'history' }" @click="tab = 'history'">History</button>
    </nav>

    <section v-show="tab === 'settings' && svc.has_settings">
      <component
        :is="customComponent ?? SchemaForm"
        v-if="settingsSchema"
        :schema="settingsSchema"
        :model-value="settingsValues"
        @update:model-value="settingsValues = $event"
        @save="saveSettings"
      />
      <button v-if="!customComponent" type="button" @click="saveSettings">Save settings</button>
      <p v-if="settingsStatus" class="status">{{ settingsStatus }}</p>
    </section>

    <section v-show="tab === 'run'">
      <SchemaForm
        :schema="svc.input_schema as Record<string, unknown>"
        v-model="runInput"
      />
      <button type="button" @click="runJob">Submit job</button>
      <p v-if="runStatus" class="status">{{ runStatus }}</p>
    </section>

    <section v-show="tab === 'history'">
      <table>
        <tr><th>ID</th><th>Status</th><th>Outputs</th><th></th></tr>
        <tr v-for="j in history" :key="String(j.id)">
          <td><code>{{ j.id }}</code></td>
          <td>{{ j.status }}</td>
          <td>
            <template v-for="o in (j.outputs as any[]) || []" :key="o.url">
              <a v-if="o.kind?.startsWith('image/')" :href="o.url" target="_blank">
                <img :src="o.url" alt="" class="thumb" />
              </a>
              <a v-else :href="o.url" target="_blank">{{ o.path }}</a>
            </template>
          </td>
          <td>
            <button
              v-if="j.status === 'queued' || j.status === 'running' || j.status === 'preparing'"
              type="button"
              @click="onCancel(String(j.id))"
            >
              Cancel
            </button>
          </td>
        </tr>
      </table>
    </section>
  </div>
  <p v-else>Loading…</p>
</template>

<style scoped>
.desc { color: #aaa; }
.tabs { display: flex; gap: 0.5rem; margin: 1rem 0; }
.tabs button {
  background: #222;
  border: 1px solid #444;
  color: #eee;
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  border-radius: 4px;
}
.tabs button.active { border-color: #8cf; }
.tabs button:disabled { opacity: 0.4; cursor: not-allowed; }
.status { color: #8cf; }
.thumb { max-height: 48px; vertical-align: middle; margin-right: 0.25rem; }
code { font-size: 0.75rem; }
</style>
