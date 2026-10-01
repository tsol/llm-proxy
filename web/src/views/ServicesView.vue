<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchServices, type ServiceInfo } from '../api';

const list = ref<ServiceInfo[]>([]);
onMounted(async () => { list.value = await fetchServices(); });
</script>

<template>
  <h1>Services</h1>
  <table>
    <tr>
      <th>Service</th>
      <th>VRAM</th>
      <th>Est. sec</th>
      <th></th>
    </tr>
    <tr v-for="s in list" :key="s.id">
      <td>
        <strong>{{ s.title }}</strong>
        <div class="id">{{ s.id }}</div>
      </td>
      <td>{{ s.kind === 'external' ? 'external' : `${(s.resources as any)?.vram_mb} MB` }}</td>
      <td>{{ s.estimate_sec }}</td>
      <td><router-link :to="`/services/${s.id}`">Open</router-link></td>
    </tr>
  </table>
</template>

<style scoped>
.id { font-size: 0.8rem; color: #888; }
</style>
