<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchScheduler } from '../api';

const snap = ref<Record<string, unknown>>({});
onMounted(async () => { snap.value = await fetchScheduler(); });
</script>

<template>
  <h1>Resources</h1>
  <pre>{{ JSON.stringify({ capacity: snap.capacity, gpu: snap.gpu, residents: snap.residents }, null, 2) }}</pre>
</template>
