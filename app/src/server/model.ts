// The model configuration and which model the app uses.

import type { Model } from '../core/types';
import { bedrockModel } from './bedrock';
import { fixtureModel } from './fixture';

// The Haiku 4.5 inference profile (DESIGN 4.5). Production sets MODEL_ID in
// infra/compose.prod.yml.
export const MODEL_ID = process.env.MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const MODEL_REGION = process.env.AWS_REGION ?? 'us-east-1';

export function getModel(): Model {
  return process.env.MODEL_MODE === 'fixture' ? fixtureModel : bedrockModel(MODEL_ID, MODEL_REGION);
}
