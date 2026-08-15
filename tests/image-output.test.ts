#!/usr/bin/env node
/**
 * Unit tests for image-output helpers (no .env / live Google needed).
 * Run: npx tsx tests/image-output.test.ts
 */
const assert = require('node:assert/strict');
const {
  isImageOutputModel,
  stripThinkingParams,
  withImageModalities,
  openaiMessagesToGemini,
  openaiChatToGeminiGenerateContent,
  geminiResponseToOpenAI,
  flattenAssistantImages,
  assistantContentText,
  assistantContentHasImage,
  googleGenerateContentUrl,
} = require('../src/image-output.ts');

assert.equal(isImageOutputModel('gemini-3-pro-image'), true);
assert.equal(isImageOutputModel('gemini-2.5-flash-image'), true);
assert.equal(isImageOutputModel('google/gemini-3-pro-image-preview'), true);
assert.equal(isImageOutputModel('gemini-3.1-flash-lite-image'), true);
assert.equal(isImageOutputModel('gemini-flash-latest'), false);
assert.equal(isImageOutputModel('imagen-3.0-generate-002'), false);
assert.equal(isImageOutputModel('gemini-3.1-pro-preview'), false);

{
  const out = stripThinkingParams({
    model: 'gemini-3-pro-image',
    reasoning_effort: 'medium',
    thinking_level: 'LOW',
    tools: [{ type: 'function' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.reasoning_effort, undefined);
  assert.equal(out.thinking_level, undefined);
  assert.equal(out.tools, undefined);
  assert.equal(out.messages.length, 1);
}

{
  const out = withImageModalities({ model: 'x', messages: [] });
  assert.deepEqual(out.modalities, ['image', 'text']);
  const kept = withImageModalities({ model: 'x', messages: [], modalities: ['image'] });
  assert.deepEqual(kept.modalities, ['image']);
}

{
  const mapped = openaiMessagesToGemini([
    { role: 'system', content: 'be a designer' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'make it blue' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } },
      ],
    },
    { role: 'user', content: 'and crop' },
  ]);
  assert.equal(mapped.systemInstruction.parts[0].text, 'be a designer');
  assert.equal(mapped.contents.length, 1);
  assert.equal(mapped.contents[0].role, 'user');
  assert.equal(mapped.contents[0].parts.length, 3);
  assert.deepEqual(mapped.contents[0].parts[1], {
    inlineData: { mimeType: 'image/jpeg', data: 'abc123' },
  });
}

{
  const body = openaiChatToGeminiGenerateContent(
    {
      model: 'gemini-3-pro-image',
      reasoning_effort: 'low',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'draw a cat' }],
    },
    'gemini-3-pro-image',
  );
  assert.deepEqual(body.generationConfig, {
    responseModalities: ['TEXT', 'IMAGE'],
    maxOutputTokens: 2048,
  });
  assert.equal(body.reasoning_effort, undefined);
}

{
  const openai = geminiResponseToOpenAI(
    {
      modelVersion: 'gemini-3-pro-image',
      candidates: [
        {
          content: {
            parts: [
              { text: 'here' },
              { inlineData: { mimeType: 'image/jpeg', data: 'Zm9v' } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    },
    'gemini-3-pro-image',
  );
  const content = openai.choices[0].message.content;
  assert.equal(content[0].text, 'here');
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,Zm9v');
  assert.equal(openai.usage.total_tokens, 30);
  assert.equal(assistantContentHasImage(content), true);
  assert.equal(assistantContentText(content), 'here');
}

{
  const flat = flattenAssistantImages({
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'ok',
          images: [{ image_url: { url: 'data:image/png;base64,xx' } }],
        },
      },
    ],
  });
  const content = flat.choices[0].message.content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].image_url.url, 'data:image/png;base64,xx');
  assert.equal(flat.choices[0].message.images, undefined);
}

{
  const url = googleGenerateContentUrl(
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'gemini-3-pro-image',
  );
  assert.equal(
    url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
  );
}

console.log('✓ image-output: all assertions passed');
