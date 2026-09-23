<script setup lang="ts">
import { computed, watch } from 'vue';

const props = defineProps<{
  schema: Record<string, unknown> | null;
  modelValue: Record<string, unknown>;
}>();

const emit = defineEmits<{ 'update:modelValue': [Record<string, unknown>] }>();

const properties = computed(() => {
  const s = props.schema;
  if (!s || s.type !== 'object') return {} as Record<string, Record<string, unknown>>;
  return (s.properties ?? {}) as Record<string, Record<string, unknown>>;
});

const required = computed(() => {
  const s = props.schema;
  return new Set((s?.required as string[]) ?? []);
});

function fieldType(prop: Record<string, unknown>): string {
  if (prop.enum) return 'enum';
  const t = prop.type;
  if (Array.isArray(t)) return String(t[0]);
  return String(t ?? 'string');
}

function update(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

watch(
  () => props.schema,
  () => {
    const next = { ...props.modelValue };
    for (const [key, prop] of Object.entries(properties.value)) {
      if (next[key] === undefined && prop.default !== undefined) {
        next[key] = prop.default;
      }
    }
    emit('update:modelValue', next);
  },
  { immediate: true },
);
</script>

<template>
  <div class="schema-form">
    <div v-for="(prop, key) in properties" :key="key" class="field">
      <label>
        <span class="label">{{ key }}</span>
        <span v-if="required.has(String(key))" class="req">*</span>
        <span v-if="prop.description" class="hint">{{ prop.description }}</span>
      </label>
      <select
        v-if="fieldType(prop) === 'enum'"
        :value="modelValue[key] ?? ''"
        @change="update(String(key), ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="opt in (prop.enum as unknown[])" :key="String(opt)" :value="opt">
          {{ opt }}
        </option>
      </select>
      <input
        v-else-if="fieldType(prop) === 'boolean'"
        type="checkbox"
        :checked="Boolean(modelValue[key])"
        @change="update(String(key), ($event.target as HTMLInputElement).checked)"
      />
      <input
        v-else-if="fieldType(prop) === 'integer' || fieldType(prop) === 'number'"
        type="number"
        :step="fieldType(prop) === 'integer' ? 1 : 'any'"
        :min="prop.minimum as number | undefined"
        :max="prop.maximum as number | undefined"
        :value="modelValue[key] ?? ''"
        @input="update(String(key), fieldType(prop) === 'integer'
          ? parseInt(($event.target as HTMLInputElement).value, 10)
          : parseFloat(($event.target as HTMLInputElement).value))"
      />
      <input
        v-else
        type="text"
        :value="(modelValue[key] as string) ?? ''"
        @input="update(String(key), ($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>

<style scoped>
.schema-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 32rem; }
.field label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.9rem; }
.label { font-weight: 600; }
.req { color: #f88; margin-left: 0.2rem; }
.hint { color: #999; font-weight: normal; font-size: 0.8rem; }
input[type="text"], input[type="number"], select {
  padding: 0.35rem 0.5rem;
  background: #1a1a1a;
  border: 1px solid #444;
  color: #eee;
  border-radius: 4px;
}
</style>
