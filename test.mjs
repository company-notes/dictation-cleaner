import assert from 'node:assert/strict';
import test from 'node:test';
import gateway from './worker.js';

const accountID = '0'.repeat(32);
const cloudflareKey = 'cloudflare-test-token-not-real';
const env = {
  CF_ACCOUNT_ID: accountID,
  GROQ_API_KEY: 'groq-test-token-not-real',
};
const model = '@cf/qwen/qwen3-30b-a3b-fp8';
const base = 'https://example.workers.dev';

function makeRequest(path, body, token = cloudflareKey) {
  return new Request(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function chatBody(stream = false) {
  return {
    model,
    stream,
    messages: [{ role: 'user', content: '嗯，我想測試一下 API。' }],
  };
}

function cloudflareReply(content = '清理後文字') {
  return Response.json({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

function quotaReply(code) {
  return Response.json({ success: false, errors: [{ code }] }, { status: 429 });
}

test('configuration is required, fail fast with no upstream access', async () => {
  globalThis.fetch = () => {
    throw new Error('Should not connect to upstream');
  };

  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /CF_ACCOUNT_ID/);

  const invalid = await gateway.fetch(new Request(`${base}/health`), {
    ...env,
    CF_ACCOUNT_ID: 'not-an-account-id',
  });
  assert.equal(invalid.status, 503);
});

test('client supplies Cloudflare token and missing or malformed Bearer is rejected', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.headers.authorization, 'Bearer another-client-token');
    return cloudflareReply();
  };

  const missing = await gateway.fetch(new Request(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody()),
  }), env);
  assert.equal(missing.status, 401);

  const invalid = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody(), ''), env);
  assert.equal(invalid.status, 401);

  const supplied = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody(), 'another-client-token'), env);
  assert.equal(supplied.status, 200);
  assert.equal(calls, 1);
});

test('Cloudflare chat uses configured Account ID and client Bearer token', async () => {
  let count = 0;
  globalThis.fetch = async (url, options) => {
    count++;
    assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${accountID}/ai/v1/chat/completions`);
    assert.equal(options.headers.authorization, `Bearer ${cloudflareKey}`);
    assert.equal(JSON.parse(options.body).model, model);
    return cloudflareReply();
  };

  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, '清理後文字');
  assert.equal(count, 1);
});

test('only Cloudflare daily quota code 3036 uses Groq fallback', async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    if (String(url).includes('api.groq.com')) {
      assert.equal(options.headers.authorization, `Bearer ${env.GROQ_API_KEY}`);
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'qwen/qwen3.8-27b');
      assert.equal(body.reasoning_effort, 'none');
      return cloudflareReply('Groq 備援成功');
    }
    return quotaReply(3036);
  };

  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-llm-provider'), 'groq-fallback');
  assert.equal((await response.json()).choices[0].message.content, 'Groq 備援成功');
  assert.equal(calls, 2);
});

test('capacity 3040 does not call Groq', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return quotaReply(3040);
  };

  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), env);
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});

test('no Groq secret returns a clear quota error', async () => {
  globalThis.fetch = async () => quotaReply(3036);
  const { GROQ_API_KEY: ignored, ...withoutGroq } = env;
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), withoutGroq);
  assert.equal(response.status, 429);
  assert.match((await response.json()).error.message, /GROQ_API_KEY/);
});

test('SSE continues to work', async () => {
  const eventStream = 'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.accept, 'text/event-stream');
    return new Response(eventStream, { headers: { 'content-type': 'text/event-stream' } });
  };

  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody(true)), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(await response.text(), /好/);
});

test('Cloudflare ASR receives the same configured upstream account and token', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${accountID}/ai/run/@cf/openai/whisper-large-v3-turbo`);
    assert.equal(options.headers.authorization, `Bearer ${cloudflareKey}`);
    return Response.json({ success: true, result: { text: '語音辨識成功' } });
  };

  const form = new FormData();
  form.set('model', 'whisper-1');
  form.set('file', new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }), 'test.wav');

  const response = await gateway.fetch(new Request(`${base}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cloudflareKey}` },
    body: form,
  }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, '語音辨識成功');
});

test('debug endpoint is absent, model listing and health are intact', async () => {
  const removed = await gateway.fetch(makeRequest('/debug/qwen', {}), env);
  assert.equal(removed.status, 404);

  const health = await gateway.fetch(new Request(`${base}/health`), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, '2.7.0');

  const listing = await gateway.fetch(new Request(`${base}/v1/models`), env);
  assert.equal((await listing.json()).data[0].id, model);
});
