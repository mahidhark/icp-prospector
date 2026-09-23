/**
 * Claude, for structured extraction. Trimmed from job-applier-agent's model
 * boundary to the one operation this tool needs so far: output constrained by a
 * JSON Schema through `output_config.format`, never JSON.parse over free prose.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface ParseResult<T> {
  value: T;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface StructuredModel {
  readonly id: string;
  parse<T>(system: string, user: string, schema: Record<string, unknown>, maxTokens?: number): Promise<ParseResult<T>>;
}

export function anthropicModel(model: string, client = new Anthropic()): StructuredModel {
  return {
    id: `anthropic:${model}`,
    async parse<T>(system: string, user: string, schema: Record<string, unknown>, maxTokens = 8000) {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        // Identical across every call of a kind, so it caches.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: { format: { type: 'json_schema', schema }, effort: 'low' },
        messages: [{ role: 'user', content: user }],
      });
      const raw = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text).join('');
      let value: T;
      try {
        value = JSON.parse(raw) as T;
      } catch (err) {
        throw new Error(`structured output was not valid JSON: ${raw.slice(0, 200)}`, { cause: err });
      }
      return {
        value,
        inputTokens: res.usage?.input_tokens ?? null,
        outputTokens: res.usage?.output_tokens ?? null,
      };
    },
  };
}
