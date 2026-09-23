<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { cancelJob, streamScheduler } from '../api';

const snap = ref<Record<string, unknown>>({});

let stop: (() => void) | null = null;
onMounted(() => {
  stop = streamScheduler((d) => { snap.value = d; });
});
onUnmounted(() => stop?.());

async function doCancel(key: string) {
  await cancelJob(key);
}

function jobOutputs(job: Record<string, unknown>) {
  return (job.outputs as Array<{ url: string; kind?: string }>) ?? [];
}
</script>

<template>
  <h1>Queue</h1>
  <h2>Running</h2>
  <table>
    <tr><th>Key</th><th>Holds</th><th>ETA</th><th></th></tr>
    <tr v-for="r in (snap.running as any[]) || []" :key="r.key">
      <td>{{ r.key }}</td>
      <td>{{ (r.holds || []).join(', ') }}</td>
      <td>{{ r.etaAt ? new Date(r.etaAt).toLocaleTimeString() : '' }}</td>
      <td><button type="button" @click="doCancel(r.key)">Cancel</button></td>
    </tr>
  </table>
  <h2>Queued</h2>
  <table>
    <tr><th>Preview</th><th>Score</th><th>Wait</th><th></th></tr>
    <tr v-for="q in (snap.queued as any[]) || []" :key="q.key">
      <td>{{ q.preview }}</td>
      <td>{{ q.score }}</td>
      <td>{{ q.wait_reason }}</td>
      <td><button type="button" @click="doCancel(q.key)">Cancel</button></td>
    </tr>
  </table>
  <h2>Recent jobs</h2>
  <table>
    <tr><th>ID</th><th>Service</th><th>Status</th><th>Preview</th></tr>
    <tr v-for="j in (snap.recent as any[]) || []" :key="j.id">
      <td><router-link :to="`/services/${j.service_id}`">{{ j.id }}</router-link></td>
      <td>{{ j.service_id }}</td>
      <td>{{ j.status }}</td>
      <td>
        <template v-for="o in jobOutputs(j)" :key="o.url">
          <img v-if="o.kind?.startsWith('image/')" :src="o.url" alt="" class="thumb" />
        </template>
        <span v-if="j.message">{{ j.message }}</span>
      </td>
    </tr>
  </table>
</template>

<style scoped>
.thumb { max-height: 40px; vertical-align: middle; }
button { font-size: 0.85rem; }
</style>
