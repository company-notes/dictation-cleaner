import assert from 'node:assert/strict';
import test from 'node:test';
import gateway from './worker.js';

const accountID = '0'.repeat(32);
const cloudflareKey = 'cloudflare-test-token-not-real';
const env = {
  CF_ACCOUNT_ID: accountID,
  GROQ_API_KEY: 'groq-test-token-not-real',
};
const model = '@cf/google/gemma-4-26b-a4b-it';
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
  assert.equal((await health.json()).version, '3.2.0');

  const listing = await gateway.fetch(new Request(`${base}/v1/models`), env);
  assert.deepEqual((await listing.json()).data.map(item => item.id), [model]);
});

test('all model and endpoint settings override the defaults', async () => {
  const custom = {
    ...env,
    CHAT_MODEL: '@cf/test/cleaner',
    GROQ_CHAT_MODEL: 'qwen/custom-fallback',
    GROQ_CHAT_URL: 'https://alternate.groq.example/openai/v1/chat/completions',
    ASR_MODEL: '@cf/test/asr',
    ASR_ALIASES: 'custom-whisper,custom-asr',
    MAX_CHAT_BYTES: '2048',
    MAX_AUDIO_BYTES: '128',
    MAX_MULTIPART_BYTES: '2048',
    DEFAULT_ASR_LANGUAGE: 'en',
    ASR_VOCAB_HINT: 'AcmeModel, special tokenizer',
  };

  const health = await gateway.fetch(new Request(`${base}/health`), custom);
  const healthData = await health.json();
  assert.equal(healthData.chat_model, custom.CHAT_MODEL);
  assert.equal(healthData.transcription_model, custom.ASR_MODEL);

  const listing = await gateway.fetch(new Request(`${base}/v1/models`), custom);
  assert.equal((await listing.json()).data[0].id, custom.CHAT_MODEL);

  const requests = [];
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    requests.push({ url: String(url), payload });

    if (String(url).includes('alternate.groq.example')) {
      assert.equal(payload.model, custom.GROQ_CHAT_MODEL);
      return cloudflareReply('備援成功');
    }

    if (String(url).includes('/ai/run/')) {
      assert.match(String(url), /\/run\/@cf\/test\/asr$/);
      assert.equal(payload.language, 'en');
      assert.match(payload.initial_prompt, /AcmeModel/);
      return Response.json({ success: true, result: { text: 'transcribed' } });
    }

    assert.equal(payload.model, custom.CHAT_MODEL);
    return quotaReply(3036);
  };

  const chat = await gateway.fetch(makeRequest('/v1/chat/completions', {
    ...chatBody(), model: custom.CHAT_MODEL,
  }), custom);
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).choices[0].message.content, '備援成功');
  assert.ok(requests.some(call => call.url.includes('alternate.groq.example')));

  const form = new FormData();
  form.set('model', 'custom-whisper');
  form.set('file', new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }), 'test.wav');
  const transcript = await gateway.fetch(new Request(`${base}/v1/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${cloudflareKey}` }, body: form,
  }), custom);
  assert.equal((await transcript.json()).text, 'transcribed');

  form.set('model', 'whisper-1');
  const invalidAlias = await gateway.fetch(new Request(`${base}/v1/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${cloudflareKey}` }, body: form,
  }), custom);
  assert.equal(invalidAlias.status, 400);
});

test('custom limits reject oversized chat and audio requests', async () => {
  const custom = {
    ...env,
    MAX_CHAT_BYTES: '50',
    MAX_AUDIO_BYTES: '3',
    MAX_MULTIPART_BYTES: '500',
  };

  globalThis.fetch = () => {
    throw new Error('Rejected requests must not reach the upstream API');
  };

  const chat = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), custom);
  assert.equal(chat.status, 413);

  const form = new FormData();
  form.set('model', 'whisper-1');
  form.set('file', new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }), 'test.wav');
  const audio = await gateway.fetch(new Request(`${base}/v1/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${cloudflareKey}` }, body: form,
  }), custom);
  assert.equal(audio.status, 413);
});

test('ASR language and vocabulary can be intentionally empty', async () => {
  const custom = { ...env, DEFAULT_ASR_LANGUAGE: '', ASR_VOCAB_HINT: '' };
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(Object.hasOwn(payload, 'language'), false);
    assert.equal(Object.hasOwn(payload, 'initial_prompt'), false);
    return Response.json({ success: true, result: { text: 'ok' } });
  };

  const form = new FormData();
  form.set('model', 'whisper-1');
  form.set('file', new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }), 'test.wav');
  const response = await gateway.fetch(new Request(`${base}/v1/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${cloudflareKey}` }, body: form,
  }), custom);
  assert.equal(response.status, 200);
});

test('invalid optional settings give a configuration error', async () => {
  const invalidSettings = [
    { MAX_CHAT_BYTES: '0' },
    { MAX_AUDIO_BYTES: 'ABC' },
    { MAX_AUDIO_BYTES: '10000', MAX_MULTIPART_BYTES: '9999' },
    { GROQ_CHAT_URL: 'http://insecure.example/v1' },
    { CHAT_MODEL: '' },
    { ASR_ALIASES: ',,,' },
  ];

  for (const change of invalidSettings) {
    const response = await gateway.fetch(new Request(`${base}/health`), { ...env, ...change });
    assert.equal(response.status, 503, JSON.stringify(change));
    assert.equal((await response.json()).error.type, 'configuration_error');
  }
});

test('Qwen3.8 routing respects non-thinking, low temperature, and explicit Gemma choice', async () => {
  const newer = '@cf/qwen/qwen3.8-27b';
  const settings = { ...env, CHAT_MODEL: newer };
  const listing = await gateway.fetch(new Request(base + '/v1/models'), settings);
  assert.deepEqual((await listing.json()).data.map(item => item.id), [newer]);
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(JSON.parse(options.body));
    return cloudflareReply();
  };
  const result = await gateway.fetch(makeRequest('/v1/chat/completions', {
    ...chatBody(), model: newer, temperature: 0.2,
    reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: true },
  }), settings);
  assert.equal(result.status, 200);
  assert.equal(seen[0].temperature, 0.2);
  assert.equal(seen[0].model, newer);
  assert.deepEqual(seen[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal(Object.hasOwn(seen[0], 'reasoning_effort'), false);
  assert.equal(seen[0].messages[0].content, '嗯，我想測試一下 API。');

  const gemma = await gateway.fetch(makeRequest('/v1/chat/completions', {
    ...chatBody(), temperature: 0.1, max_tokens: 128, reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: true, custom: 1 },
  }), settings);
  assert.equal(gemma.status, 200);
  assert.equal(seen[1].model, model);
  assert.equal(seen[1].messages[0].content, '嗯，我想測試一下 API。');
  assert.deepEqual(seen[1].chat_template_kwargs, { enable_thinking: false, custom: 1 });
  assert.equal(seen[1].max_tokens, 128);
  assert.equal(seen[1].temperature, 0.1);
  assert.equal(Object.hasOwn(seen[1], 'reasoning_effort'), false);

  const anotherModel = await gateway.fetch(makeRequest('/v1/chat/completions', {
    ...chatBody(), model: '@cf/not-supported/model',
  }), settings);
  assert.equal(anotherModel.status, 200);
  assert.equal(seen[2].model, '@cf/not-supported/model');
  assert.equal(seen.length, 3);
});

test('Qwen3.8 retry retains non-thinking flag and original messages', async () => {
  const newer = '@cf/qwen/qwen3.8-27b';
  const settings = { ...env, CHAT_MODEL: newer };
  let count = 0;
  globalThis.fetch = async (_url, options) => {
    count++;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.messages[0].content, '嗯，我想測試一下 API。');
    return count === 1 ? cloudflareReply('') : cloudflareReply('重試成功');
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', {
    ...chatBody(), model: newer,
  }), settings);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, '重試成功');
  assert.equal(count, 2);
});

test('authenticated model list discovers Cloudflare text-generation models and preserves preferred order', async () => {
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    assert.equal(options.headers.authorization, `Bearer ${cloudflareKey}`);
    assert.match(String(url), /models\/search\?task=text-generation/);
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 1) return Response.json({
      success: true, result_info: { total_pages: 2 },
      result: [
        { name: '@cf/meta/llama-3.1-8b-instruct' },
        { name: model },
        { name: '@cf/baai/bge-base-en-v1.5' }, // Catalog task filter normally excludes embeddings.
      ],
    });
    return Response.json({
      success: true, result_info: { total_pages: 2 },
      result: [{ name: '@cf/qwen/qwen3.8-27b' }],
    });
  };
  const request = new Request(base + '/v1/models', {
    headers: { authorization: `Bearer ${cloudflareKey}` },
  });
  const response = await gateway.fetch(request, env);
  assert.equal(response.status, 200);
  const names = (await response.json()).data.map(item => item.id);
  assert.equal(names[0], model);
  assert.ok(names.includes('@cf/meta/llama-3.1-8b-instruct'));
  assert.ok(names.includes('@cf/qwen/qwen3.8-27b'));
  assert.equal(urls.length, 2);
});

test('catalog failure leaves configured models selectable and permits arbitrary Cloudflare models', async () => {
  const custom = { ...env, CHAT_MODELS: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/models/search')) return Response.json({ error: 'no permission' }, { status: 403 });
    assert.equal(JSON.parse(options.body).model, '@cf/mistral/mistral-7b-instruct-v0.2');
    return cloudflareReply('ok');
  };
  const listing = await gateway.fetch(new Request(base + '/models', {
    headers: { authorization: `Bearer ${cloudflareKey}` },
  }), custom);
  assert.deepEqual((await listing.json()).data.map(x => x.id), [
    model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ]);
  const chat = await gateway.fetch(makeRequest('/v1/chat/completions', {
    ...chatBody(), model: '@cf/mistral/mistral-7b-instruct-v0.2',
  }), custom);
  assert.equal(chat.status, 200);
});

test('other models retain their own decoding and reasoning parameters and are logged', async () => {
  const inputModel = '@cf/meta/llama-3.1-8b-instruct';
  const logs = [];
  const originalInfo = console.info;
  console.info = (...parts) => { logs.push(parts.join(' ')); };
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, inputModel);
      assert.equal(body.temperature, 0.15);
      assert.equal(body.top_p, 0.93);
      assert.equal(body.max_tokens, 128);
      assert.equal(body.reasoning_effort, 'low');
      assert.deepEqual(body.chat_template_kwargs, { custom: true });
      assert.equal(body.messages[0].content, '嗯，我想測試一下 API。');
      return Response.json({
        model: inputModel, choices: [{ message: { role: 'assistant', content: 'fine' }, finish_reason: 'stop' }],
      });
    };
    const reply = await gateway.fetch(makeRequest('/v1/chat/completions', {
      ...chatBody(), model: inputModel, temperature: 0.15, top_p: 0.93,
      max_tokens: 128, reasoning_effort: 'low', chat_template_kwargs: { custom: true },
    }), env);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('x-llm-model'), inputModel);
    assert.equal(reply.headers.get('x-llm-provider'), 'cloudflare');
    assert.ok(logs.some(line => line.includes('[llm-route] selected_model') && line.includes(inputModel)));
    assert.ok(logs.some(line => line.includes('[cf-chat]') && line.includes('"upstream_model":"'+inputModel+'"')));
  } finally { console.info = originalInfo; }
});

test('model id validation refuses non-Cloudflare providers', async () => {
  globalThis.fetch = () => { throw new Error('should not fetch'); };
  const reply = await gateway.fetch(makeRequest('/v1/chat/completions', {
    ...chatBody(), model: 'gpt-4o',
  }), env);
  assert.equal(reply.status, 400);
});

test('retired model returns a clear error without retry or Groq fallback', async () => {
  const retired = '@cf/qwen/qwen3-30b-a3b-fp8';
  const cases = [
    [410, { success: false, errors: [{ code: 5028 }] }, 410, 'model_decommissioned'],
    [404, { error: { code: 'model_not_found' } }, 404, 'model_not_found'],
    [400, { errors: [{ code: 5028 }] }, 410, 'model_decommissioned'],
  ];
  for (const [status, payload, expected, type] of cases) {
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, retired);
      assert.equal(body.messages[0].content, '嗯，我想測試一下 API。');
      return Response.json(payload, { status });
    };
    const response = await gateway.fetch(makeRequest('/v1/chat/completions', {
      ...chatBody(), model: retired,
    }), env);
    assert.equal(response.status, expected);
    assert.equal((await response.json()).error.type, type);
    assert.equal(calls, 1);
  }
});

test('retirement during an empty-response retry stays a model error', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? cloudflareReply('') : Response.json({ errors: [{ code: 5028 }] }, { status: 410 });
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), env);
  assert.equal(response.status, 410);
  assert.equal((await response.json()).error.type, 'model_decommissioned');
  assert.equal(calls, 2);
});

test('usage logs report actual counters for every JSON attempt including retries', async () => {
  const logs = [];
  const original = console.info;
  console.info = (...parts) => { logs.push(parts.join(' ')); };
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        model,
        choices: [{ message: { content: calls === 1 ? '' : '整理完成' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: calls === 1 ? 0 : 50,
          total_tokens: calls === 1 ? 3000 : 3050, prompt_tokens_details: { cached_tokens: 1000 },
          neurons: calls === 1 ? 20.5 : 21.86 },
      });
    };
    const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).usage.neurons, 21.86);
    const rows = logs.filter(x => x.startsWith('[cf-chat] {')).map(x => JSON.parse(x.slice(10)));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source, 'initial');
    assert.equal(rows[0].completion_tokens, 0);
    assert.equal(rows[0].neurons, 20.5);
    assert.equal(rows[1].source, 'baseline_retry');
    assert.equal(rows[1].prompt_tokens, 3000);
    assert.equal(rows[1].completion_tokens, 50);
    assert.equal(rows[1].total_tokens, 3050);
    assert.equal(rows[1].cached_tokens, 1000);
    assert.equal(rows[1].neurons, 21.86);
    assert.ok(!logs.join(' ').includes('整理完成'));
  } finally { console.info = original; }
});

test('usage missing from provider is logged as null, not zero', async () => {
  const logs = [];
  const original = console.info;
  console.info = (...parts) => logs.push(parts.join(' '));
  try {
    globalThis.fetch = async () => cloudflareReply();
    const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), env);
    assert.equal(response.status, 200);
    const data = JSON.parse(logs.find(x => x.startsWith('[cf-chat] {')).slice(10));
    assert.equal(data.has_usage, false);
    assert.equal(data.neurons, null);
    assert.equal(data.cached_tokens, null);
    assert.equal(data.prompt_tokens, null);
  } finally { console.info = original; }
});

test('streaming preserves byte-for-byte output while logging final usage when present', async () => {
  const logs = [];
  const original = console.info;
  console.info = (...parts) => logs.push(parts.join(' '));
  try {
    const stream = 'data: '+JSON.stringify({ model, choices: [{ delta: {content: '好'} }] })+'\n\n'
      +'data: '+JSON.stringify({ model, choices: [], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, neurons: 2.5 } })+'\n\n'
      +'data: [DONE]\n\n';
    globalThis.fetch = async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody(true)), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), stream);
    const row = JSON.parse(logs.find(x => x.startsWith('[cf-chat] {')).slice(10));
    assert.equal(row.source, 'cloudflare_stream');
    assert.equal(row.neurons, 2.5);
    assert.equal(row.prompt_tokens, 200);
    assert.equal(row.upstream_model, model);
  } finally { console.info = original; }
});

test('delayed hedge is opt-in, with user-configurable guardrails', async () => {
  for (const change of [
    { HEDGE_ON_SLOW: 'sometimes' },
    { HEDGE_DELAY_MS: '0' },
    { HEDGE_DELAY_MS: '27000' },
    { HEDGE_OVERALL_TIMEOUT_MS: '29000' },
    { GROQ_TIMEOUT_MS: 'abc' },
  ]) {
    const response = await gateway.fetch(new Request(base + '/health'), { ...env, ...change });
    assert.equal(response.status, 503, JSON.stringify(change));
  }
  const response = await gateway.fetch(new Request(base + '/health'), {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '15',
  });
  const health = await response.json();
  assert.equal(health.version, '3.2.0');
  assert.equal(health.hedge_enabled, true);
  assert.equal(health.hedge_delay_ms, 15);
});

test('hedge does not call Groq when Cloudflare succeeds before delay', async () => {
  let cfCalls = 0;
  let groqCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.groq.com')) { groqCalls++; return cloudflareReply('groq'); }
    cfCalls++;
    return cloudflareReply('Cloudflare先完成');
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '30', HEDGE_OVERALL_TIMEOUT_MS: '200',
    GROQ_TIMEOUT_MS: '100',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Cloudflare先完成');
  assert.equal(response.headers.get('x-llm-provider'), 'cloudflare');
  assert.equal(cfCalls, 1);
  assert.equal(groqCalls, 0);
});

test('after delay Groq can win without cancelling Cloudflare early', async () => {
  let cfAborted = false, groqCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.groq.com')) {
      groqCalls++;
      assert.equal(JSON.parse(options.body).model, 'qwen/qwen3.8-27b');
      return cloudflareReply('Groq獲勝');
    }
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        cfAborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '10', HEDGE_OVERALL_TIMEOUT_MS: '250',
    GROQ_TIMEOUT_MS: '100',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Groq獲勝');
  assert.equal(response.headers.get('x-llm-provider'), 'groq-fallback');
  assert.equal(groqCalls, 1);
  assert.equal(cfAborted, true);
});

test('Cloudflare can win after Groq hedge has already started', async () => {
  let groqStarted = false, groqAborted = false;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.groq.com')) {
      groqStarted = true;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          groqAborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
    return new Promise(resolve => {
      setTimeout(() => resolve(cloudflareReply('Cloudflare後來反超')), 35);
    });
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '10', HEDGE_OVERALL_TIMEOUT_MS: '250',
    GROQ_TIMEOUT_MS: '100',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Cloudflare後來反超');
  assert.equal(response.headers.get('x-llm-provider'), 'cloudflare');
  assert.equal(groqStarted, true);
  assert.equal(groqAborted, true);
});

test('an invalid Groq result does not defeat a later valid Cloudflare result', async () => {
  let groqCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.groq.com')) {
      groqCalls++;
      return cloudflareReply('');
    }
    return new Promise(resolve => setTimeout(() => resolve(cloudflareReply('Cloudflare可用文字')), 35));
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '10', HEDGE_OVERALL_TIMEOUT_MS: '250',
    GROQ_TIMEOUT_MS: '100',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Cloudflare可用文字');
  assert.equal(groqCalls, 1);
});

test('a Groq timeout leaves Cloudflare racing until it finishes', async () => {
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.groq.com')) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
          name: 'AbortError',
        })), { once: true });
      });
    }
    return new Promise(resolve => setTimeout(() => resolve(cloudflareReply('Cloudflare仍然可用')), 55));
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '5', HEDGE_OVERALL_TIMEOUT_MS: '200',
    GROQ_TIMEOUT_MS: '15',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Cloudflare仍然可用');
});

test('the overall deadline returns before the OpenWhispr timeout when neither responds', async () => {
  let aborts = 0;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      aborts++;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '5', HEDGE_OVERALL_TIMEOUT_MS: '40',
    GROQ_TIMEOUT_MS: '30',
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.type, 'upstream_timeout');
  assert.equal(aborts, 2);
});

test('quota failure still calls Groq immediately and model retirement is not automatically hedged', async () => {
  let groqCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.groq.com')) {
      groqCalls++;
      return cloudflareReply('Groq額度備援');
    }
    return quotaReply(3036);
  };
  const settings = {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '20', HEDGE_OVERALL_TIMEOUT_MS: '200',
    GROQ_TIMEOUT_MS: '100',
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), settings);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Groq額度備援');
  assert.equal(groqCalls, 1);
  globalThis.fetch = async url => {
    if (String(url).includes('api.groq.com')) { groqCalls++; return cloudflareReply(); }
    return Response.json({ errors: [{ code: 5028 }] }, { status: 410 });
  };
  const retired = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), settings);
  assert.equal(retired.status, 410);
  assert.equal(groqCalls, 1);
});

test('missing Groq secret skips hedge rather than exposing an empty Bearer token', async () => {
  const { GROQ_API_KEY, ...withoutSecret } = env;
  globalThis.fetch = async url => {
    assert.equal(String(url).includes('api.groq.com'), false);
    return cloudflareReply('只用Cloudflare');
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody()), {
    ...withoutSecret, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '10',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, '只用Cloudflare');
});

test('streaming requests do not use delayed hedging', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url).includes('api.groq.com'), false);
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const response = await gateway.fetch(makeRequest('/v1/chat/completions', chatBody(true)), {
    ...env, HEDGE_ON_SLOW: 'true', HEDGE_DELAY_MS: '10',
  });
  assert.equal(response.status, 200);
});
