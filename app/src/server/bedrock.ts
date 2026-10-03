// The Bedrock adapter: one Converse call with the reply tool forced. Core
// owns retries and the deadline, so the client makes one attempt and SDK
// errors propagate with their names (ThrottlingException).

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { ALLOWED_PAIRS, type Model, type ModelRequest } from '../core/types';

// Mirrors core's ModelOutput.
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['answer', 'handoff', 'urgent'] },
    reason: { type: 'string', enum: Object.keys(ALLOWED_PAIRS) },
    text: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
    language: { type: 'string' },
    topic: { type: 'string' },
    gapLabel: { type: ['string', 'null'] },
  },
  required: ['outcome', 'reason', 'text', 'citations', 'language', 'topic', 'gapLabel'],
};

function userText(request: ModelRequest): string {
  const history = request.history.map((t) => `${t.role === 'parent' ? 'Parent' : 'Front desk'}: ${t.text}`).join('\n');
  return [
    `<current_date>${request.currentDate}</current_date>`,
    `<open_gap_labels>\n${request.openGapLabels.join('\n')}\n</open_gap_labels>`,
    `<history>\n${history}\n</history>`,
    `<message>\n${request.message}\n</message>`,
  ].join('\n');
}

let client: BedrockRuntimeClient | null = null;

export function bedrockModel(modelId: string, region: string): Model {
  return async (request) => {
    client ??= new BedrockRuntimeClient({ region, maxAttempts: 1 });
    const response = await client.send(
      new ConverseCommand({
        modelId,
        // The rules, then the snapshot, then a cache point: both are stable
        // per snapshot version and day (DESIGN 4.4).
        system: [{ text: request.instructions }, { text: request.snapshotText }, { cachePoint: { type: 'default' } }],
        messages: [{ role: 'user', content: [{ text: userText(request) }] }],
        toolConfig: {
          tools: [{ toolSpec: { name: 'reply', description: 'Reply to the parent.', inputSchema: { json: REPLY_SCHEMA } } }],
          toolChoice: { tool: { name: 'reply' } },
        },
        inferenceConfig: { temperature: 0, maxTokens: request.maxOutputTokens },
      }),
      { abortSignal: request.signal },
    );
    const toolUse = response.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
    return {
      output: toolUse?.input ?? null,
      usage: {
        input: response.usage?.inputTokens ?? 0,
        cachedInput: response.usage?.cacheReadInputTokens ?? 0,
        output: response.usage?.outputTokens ?? 0,
      },
    };
  };
}
