import type { ProviderId } from './types';
import { getDefaultModelId, setDefaultModelId } from './catalog';

export interface DefaultModelSnapshot {
  model: string;
  provider: ProviderId | null;
}

export function getDefaultSnapshot(): DefaultModelSnapshot {
  return { model: getDefaultModelId(), provider: null };
}

export function setDefault(model: string): DefaultModelSnapshot {
  setDefaultModelId(model);
  return getDefaultSnapshot();
}
