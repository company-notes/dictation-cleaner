/**
 * Cloudflare Workers AI compatibility gateway for Handy, OpenLess and OpenWhispr.
 *
 * Paste entire source into an existing Cloudflare Worker and click Deploy.
 * The client supplies its own Cloudflare Workers AI token as a Bearer header.
 * Cloudflare Workers AI is primary; Groq is used only when Cloudflare reports quota exhaustion.
 */

const DEFAULTS = Object.freeze({
  chatModel: "@cf/qwen/qwen3-30b-a3b-fp8",
  groqChatModel: "qwen/qwen3.8-27b",
  groqChatUrl: "https://api.groq.com/openai/v1/chat/completions",
  asrModel: "@cf/openai/whisper-large-v3-turbo",
  asrAliases: ["whisper-1", "whisper-large-v3-turbo"],
  maxChatBytes: 64 * 1024,
  maxAudioBytes: 5 * 1024 * 1024,
  multipartOverheadBytes: 64 * 1024,
  defaultAsrLanguage: "zh",
  asrVocabHint: "model, Qwen3, Qwen3-30B-A3B, Cloudflare, Workers AI, Handy, API, LLM, ASR, reasoning_effort, prompt, token, OpenRouter, Ollama",
});

function optionalText(env, key, defaultValue) {
  const value = env[key];
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a text variable`);
  }

  return value;
}

function nonEmptyText(env, key, defaultValue) {
  const value = optionalText(env, key, defaultValue).trim();
  if (!value) {
    throw new Error(`${key} must not be empty`);
  }

  return value;
}

function positiveInteger(env, key, defaultValue) {
  const text = optionalText(env, key, String(defaultValue)).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${key} must be a positive integer (bytes)`);
  }

  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${key} must be a safe integer (bytes)`);
  }

  return number;
}

function getSettings(env) {
  const chatModel = nonEmptyText(env, "CHAT_MODEL", DEFAULTS.chatModel);
  const groqChatModel = nonEmptyText(env, "GROQ_CHAT_MODEL", DEFAULTS.groqChatModel);
  const groqChatUrl = nonEmptyText(env, "GROQ_CHAT_URL", DEFAULTS.groqChatUrl);
  const asrModel = nonEmptyText(env, "ASR_MODEL", DEFAULTS.asrModel);

  const maxChatBytes = positiveInteger(env, "MAX_CHAT_BYTES", DEFAULTS.maxChatBytes);
  const maxAudioBytes = positiveInteger(env, "MAX_AUDIO_BYTES", DEFAULTS.maxAudioBytes);
  const maxMultipartBytes = positiveInteger(
    env,
    "MAX_MULTIPART_BYTES",
    maxAudioBytes + DEFAULTS.multipartOverheadBytes,
  );

  // Unset values use the defaults. Explicitly empty language/hint disables them.
  const defaultAsrLanguage = optionalText(env, "DEFAULT_ASR_LANGUAGE", DEFAULTS.defaultAsrLanguage).trim();
  const asrVocabHint = optionalText(env, "ASR_VOCAB_HINT", DEFAULTS.asrVocabHint);
  const defaultAliases = [...DEFAULTS.asrAliases, asrModel].join(",");
  const aliasList = nonEmptyText(env, "ASR_ALIASES", defaultAliases);
  const asrAliases = new Set(aliasList.split(",").map(alias => alias.trim()).filter(Boolean));

  if (maxMultipartBytes < maxAudioBytes) {
    throw new Error("MAX_MULTIPART_BYTES must be at least MAX_AUDIO_BYTES");
  }

  if (!/^https:\/\/[^\s]+$/i.test(groqChatUrl)) {
    throw new Error("GROQ_CHAT_URL must be an HTTPS URL");
  }

  if (!asrAliases.size) {
    throw new Error("ASR_ALIASES must contain at least one model name");
  }

  return {
    chatModel,
    groqChatModel,
    groqChatUrl,
    asrModel,
    asrAliases,
    maxChatBytes,
    maxAudioBytes,
    maxMultipartBytes,
    defaultAsrLanguage,
    asrVocabHint,
  };
}

function getCloudflareAIRoot(accountID) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountID}/ai`;
}

function validateConfiguration(env) {
  if (typeof env?.CF_ACCOUNT_ID !== "string" || !/^[0-9a-f]{32}$/i.test(env.CF_ACCOUNT_ID)) {
    return "Set CF_ACCOUNT_ID to your 32-character Cloudflare Account ID in Worker Variables";
  }

  return null;
}

function bearerFrom(request) {
  const authorization = request.headers.get("authorization") || "";
  return /^Bearer\s+\S+$/i.test(authorization) ? authorization : null;
}

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function apiError(message, status, type = "invalid_request_error") {
  return responseJson({ error: { message, type } }, status);
}

function limitByHeader(request, limit) {
  const header = request.headers.get("content-length");
  return header !== null && Number.isFinite(Number(header)) && Number(header) > limit;
}

function toBase64(bytes) {
  // 12 KiB is divisible by 3, so btoa() output chunks concatenate correctly.
  let encoded = "";
  const chunkSize = 12 * 1024;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let binary = "";
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }

    encoded += btoa(binary);
  }

  return encoded;
}

function contextPrompt(clientPrompt, settings) {
  const local = typeof clientPrompt === "string" ? clientPrompt.trim() : "";

  // Prioritize a supplied dictionary hint within the Whisper prompt budget.
  return [local, settings.asrVocabHint].filter(Boolean).join(", ").slice(0, 240);
}

// Never log request prompts, transcripts, responses, tokens, or request headers.
// Only response shape and field lengths are recorded.
function recordChatDiagnostics(source, status, data, content, finishReason) {
  const payload = data && typeof data === "object" ? data : {};
  const core = payload.result && typeof payload.result === "object" ? payload.result : payload;
  const firstChoice = Array.isArray(core.choices) ? core.choices[0] : null;
  const message = firstChoice?.message || {};
  const reasoning = message.reasoning_content ?? message.reasoning ?? "";

  console.info("[cf-chat]", JSON.stringify({
    source,
    upstream_status: status,
    wrapper_success: payload.success ?? null,
    result_type: Array.isArray(payload.result) ? "array" : typeof payload.result,
    has_choices: Array.isArray(core.choices),
    choices_count: Array.isArray(core.choices) ? core.choices.length : 0,
    content_chars: typeof content === "string" ? content.length : 0,
    reasoning_chars: typeof reasoning === "string" ? reasoning.length : 0,
    finish_reason: String(finishReason ?? firstChoice?.finish_reason ?? "none").slice(0, 35),
    has_errors: Boolean(payload.error || (Array.isArray(payload.errors) && payload.errors.length)),
    has_usage: Boolean(core.usage),
  }));
}

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(part => typeof part?.text === "string" ? part.text : "").join("");
  }

  return "";
}

function stripLeadingThinking(content) {
  if (typeof content !== "string") {
    return "";
  }

  let text = content.trim();
  if (/^<think>/i.test(text)) {
    const end = text.search(/<\/think>/i);
    if (end < 0) {
      return ""; // Only internal thinking, not a final answer.
    }
    text = text.slice(end).replace(/^<\/think>/i, "").trim();
  }

  return text;
}

function unpackChatResponse(data, model) {
  if (!data || typeof data !== "object" || data.success === false || data.error ||
      (Array.isArray(data.errors) && data.errors.length)) {
    return null;
  }

  const core = data.result && typeof data.result === "object" ? data.result : data;
  let content = "";
  let finishReason = "stop";

  if (Array.isArray(core.choices) && core.choices.length) {
    const choice = core.choices[0];
    content = textOf(choice?.message?.content || choice?.delta?.content);
    finishReason = choice?.finish_reason ?? "stop";
  } else {
    // Workers AI's /ai/run response uses {result:{response:"..."}}.
    // Some intermediary gateways wrap standard Chat Completions in {result:{choices:...}}.
    content = textOf(core.response || core.output_text || core.text);
  }

  content = stripLeadingThinking(content);

  return {
    content, finishReason,
    response: {
      id: typeof core.id === "string" ? core.id : "chatcmpl-cloudflare-worker",
      object: "chat.completion",
      created: typeof core.created === "number" ? core.created : Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      }],
      ...(core.usage ? { usage: core.usage } : {}),
    },
  };
}

async function readChatJson(response, source, model) {
  let data;
  try {
    data = await response.json();
  } catch {
    console.warn("[cf-chat] upstream_non_json", JSON.stringify({
      source, upstream_status: response.status,
      content_type: response.headers.get("content-type")?.slice(0, 60) || "unknown",
    }));
    return null;
  }

  const unpacked = unpackChatResponse(data, model);
  recordChatDiagnostics(source, response.status, data, unpacked?.content || "", unpacked?.finishReason);
  return unpacked;
}

/** Cloudflare Workers AI documented: internal 3036 / HTTP 429 = exhausted
 *  daily free Neurons. The separate 3040 / HTTP 429 is capacity, NOT quota.
 *  Never fail over on 400, 401, 403, 429/3040, or a plain 5xx.
 */
async function isCloudflareQuotaExhausted(response) {
  if (response.status !== 429) {
    return false;
  }

  let payload;
  try {
    payload = await response.clone().json();
  } catch (error) {
    // A non-JSON 429 is not evidence of the specific Cloudflare daily quota.
    console.warn("[cf-chat] quota_response_not_json", error?.name || "Error");
    return false;
  }

  const codes = [
    payload?.code, payload?.error?.code,
    ...(Array.isArray(payload?.errors) ? payload.errors.map(e => e?.code) : []),
    payload?.result?.error?.code,
  ];
  if (codes.some(code => Number(code) === 3036)) {
    return true;
  }

  const messages = [
    payload?.message, payload?.error?.message,
    ...(Array.isArray(payload?.errors) ? payload.errors.map(e => e?.message) : []),
  ].filter(message => typeof message === "string");

  return messages.some(message => /(?:daily free allocation|used up your daily|free allocation of .{0,30}neurons|daily quota exceeded)/i.test(message));
}

function groqRequestBody(originalMessages, cloudflareBody, wantsStream, settings) {
  // Do not reuse Cloudflare-specific model name or /no_think message modification.
  // Groq's current Qwen 3.8 supports disabling reasoning with reasoning_effort:none.
  return {
    model: settings.groqChatModel,
    messages: originalMessages,
    stream: wantsStream,
    temperature: 0.7,
    top_p: 0.8,
    max_tokens: Math.min(Math.max(cloudflareBody.max_tokens || 1024, 1024), 4096),
    reasoning_effort: "none",
  };
}

async function runGroqFallback(env, originalMessages, cfBody, wantsStream, settings) {
  if (!env?.GROQ_API_KEY || typeof env.GROQ_API_KEY !== "string") {
    console.warn("[llm-route] cloudflare_quota_exhausted groq_secret_missing");
    return apiError("Cloudflare daily quota reached; set GROQ_API_KEY Worker secret to enable Groq fallback", 429, "quota_exceeded");
  }

  console.info("[llm-route] cloudflare_daily_quota_exhausted falling_back_to_groq");
  try {
    const fallback = await fetch(settings.groqChatUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GROQ_API_KEY}`,
        "content-type": "application/json",
        accept: wantsStream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(groqRequestBody(originalMessages, cfBody, wantsStream, settings)),
      redirect: "manual",
    });

    if (!fallback.ok) {
      console.warn("[llm-route] groq_http_failure", JSON.stringify({ status: fallback.status }));
      return apiError(`Groq fallback returned HTTP ${fallback.status}`, fallback.status, "upstream_error");
    }

    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-llm-provider": "groq-fallback",
    };

    if (wantsStream) {
      const ct = fallback.headers.get("content-type") || "";
      if (!ct.toLowerCase().includes("text/event-stream")) {
        const parsed = await readChatJson(fallback, "groq_fallback_unexpected_json", settings.groqChatModel);
        if (!parsed?.content) {
          return apiError("Groq fallback returned no text", 502, "upstream_error");
        }

        const chunk = JSON.stringify({
          id: parsed.response.id, object: "chat.completion.chunk",
          created: parsed.response.created, model: settings.groqChatModel,
          choices: [{ index: 0, delta: { role: "assistant", content: parsed.content }, finish_reason: null }],
        });
        return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { ...headers, "content-type": "text/event-stream; charset=utf-8" },
        });
      }

      return new Response(fallback.body, {
        status: 200,
        headers: { ...headers, "content-type": "text/event-stream; charset=utf-8" },
      });
    }

    const parsed = await readChatJson(fallback, "groq_fallback", settings.groqChatModel);
    if (!parsed?.content) {
      return apiError("Groq fallback returned no text", 502, "upstream_error");
    }

    return new Response(JSON.stringify(parsed.response), {
      status: 200,
      headers: { ...headers, "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    console.warn("[llm-route] groq_fetch_failed", JSON.stringify({ name: error?.name || "Error" }));
    return apiError("Groq fallback network request failed", 502, "upstream_error");
  }
}

async function handleChat(request, cloudflareToken, env, cloudflareAIRoot, settings) {
  if (limitByHeader(request, settings.maxChatBytes)) {
    return apiError("Chat request too large", 413);
  }

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > settings.maxChatBytes) {
      return apiError("Chat request too large", 413);
    }

    body = JSON.parse(raw);
  } catch {
    return apiError("Invalid JSON", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages)) {
    return apiError("messages must be an array", 400);
  }

  if (body.model !== settings.chatModel) {
    return apiError(`Only ${settings.chatModel} is supported for chat`, 400);
  }

  // Keep Chat Completions inputs compatible with the Cloudflare model.
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.chat_template_kwargs;
  delete body.enable_thinking;
  delete body.reasoning_budget;

  // Qwen3 recommends non-greedy decoding; OpenWhispr sometimes sends zero.
  if (!Number.isFinite(body.temperature) || body.temperature < 0.5) {
    body.temperature = 0.7;
  }

  if (!Number.isFinite(body.top_p) || body.top_p <= 0) {
    body.top_p = 0.8;
  }

  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1024) {
    body.max_tokens = 1024;
  }
  body.max_tokens = Math.min(body.max_tokens, 4096);

  const originalMessages = structuredClone(body.messages);

  // Ask Qwen3 to return a final answer without exposing reasoning text.
  function buildMessages(softSwitch) {
    const messages = structuredClone(originalMessages);
    if (!softSwitch) {
      return messages;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "user" && typeof msg.content === "string") {
        if (!/\/no_think\s*$/i.test(msg.content)) {
          msg.content += "\n/no_think";
        }

        break;
      }
    }

    return messages;
  }

  body.messages = buildMessages(true);

  // Handy normally sends non-streaming requests, while OpenLess needs SSE.
  // Honor each client instead of forcing stream=false for every request.
  const wantsStream = body.stream === true;
  body.stream = wantsStream;

  try {
    const upstream = await fetch(`${cloudflareAIRoot}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: cloudflareToken,
        "content-type": "application/json",
        accept: wantsStream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      redirect: "manual",
    });

    if (await isCloudflareQuotaExhausted(upstream)) {
      return runGroqFallback(env, originalMessages, body, wantsStream, settings);
    }

    if (!upstream.ok) {
      console.warn("[cf-chat] upstream_http_failure", JSON.stringify({ status: upstream.status }));
      return apiError(`Cloudflare returned HTTP ${upstream.status}`, upstream.status, "upstream_error");
    }

    if (wantsStream) {
      // Preserve the actual stream for OpenLess. Detect unexpected JSON to avoid
      // delivering an HTTP-200 error object as though it were an SSE event stream.
      const mime = upstream.headers.get("content-type") || "";
      if (!mime.toLowerCase().includes("text/event-stream")) {
        const unpacked = await readChatJson(upstream, "stream_unexpected_json", body.model);
        if (unpacked?.content) {
          const chunk = JSON.stringify({
            id: unpacked.response.id, object: "chat.completion.chunk",
            created: unpacked.response.created, model: body.model,
            choices: [{ index: 0, delta: { role: "assistant", content: unpacked.content }, finish_reason: null }],
          });

          return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
          });
        }

        return apiError("Cloudflare stream returned no usable content; inspect [cf-chat] Worker log", 502, "upstream_error");
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const parsed = await readChatJson(upstream, "soft_only", body.model);
    if (parsed?.content) {
      return responseJson(parsed.response);

    }

    // Retry the same model with the original user message if cleanup returned no text.
    console.warn("[cf-chat] empty_final_retry_baseline_same_model");
    const baselineBody = { ...body, messages: buildMessages(false) };
    const fallback = await fetch(`${cloudflareAIRoot}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: cloudflareToken, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(baselineBody),
      redirect: "manual",
    });

    if (await isCloudflareQuotaExhausted(fallback)) {
      return runGroqFallback(env, originalMessages, body, false, settings);
    }

    if (!fallback.ok) {
      console.warn("[cf-chat] baseline_http_failure", JSON.stringify({ status: fallback.status }));
      return apiError(`Cloudflare baseline retry returned HTTP ${fallback.status}`, 502, "upstream_error");
    }

    const retryResult = await readChatJson(fallback, "baseline_retry", body.model);
    if (retryResult?.content) {
      return responseJson(retryResult.response);
    }

    return apiError("Cloudflare Qwen3 gave no final text on soft-only or baseline request; inspect [cf-chat] logs", 502, "upstream_error");
  } catch (error) {
    console.warn("[cf-chat] fetch_or_parse_failed", JSON.stringify({name: error?.name || "Error"}));
    return apiError("Cloudflare chat service unreachable or response invalid", 502, "upstream_error");
  }
}

async function handleTranscription(request, cloudflareToken, cloudflareAIRoot, settings) {
  if (limitByHeader(request, settings.maxMultipartBytes)) {
    return apiError(`Audio upload too large (max ${settings.maxAudioBytes} bytes of audio)`, 413);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    return apiError("Send multipart/form-data with file and model fields", 415);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return apiError("Malformed multipart/form-data", 400);
  }

  const file = form.get("file");
  if (!(file instanceof Blob) || file.size <= 0) {
    return apiError("Missing nonempty audio file field", 400);
  }
  if (file.size > settings.maxAudioBytes) {
    return apiError(`Audio file too large (max ${settings.maxAudioBytes} bytes)`, 413);
  }

  const model = form.get("model");
  if (typeof model !== "string" || !settings.asrAliases.has(model.trim())) {
    return apiError(`ASR model must be one of: ${[...settings.asrAliases].join(", ")}`, 400);
  }

  const responseFormat = form.get("response_format");
  if (responseFormat !== null && !["json", "verbose_json", "text"].includes(String(responseFormat))) {
    return apiError("Supported response_format: json, verbose_json, text", 400);
  }

  const languageField = form.get("language");
  if (languageField !== null && (typeof languageField !== "string" || !/^[A-Za-z-]{2,12}$/.test(languageField))) {
    return apiError("Invalid language code", 400);
  }

  const hint = form.get("prompt");
  if (hint !== null && typeof hint !== "string") {
    return apiError("Invalid prompt", 400);
  }

  // Audio encoding is passed to Cloudflare Whisper, which validates the format.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const input = {
    audio: toBase64(bytes),
    task: "transcribe",
  };
  const language = languageField || settings.defaultAsrLanguage;
  if (language) {
    input.language = language;
  }

  const initialPrompt = contextPrompt(hint, settings);
  if (initialPrompt) {
    input.initial_prompt = initialPrompt;
  }

  let upstream;
  try {
    upstream = await fetch(`${cloudflareAIRoot}/run/${settings.asrModel}`, {
      method: "POST",
      headers: { authorization: cloudflareToken, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
      redirect: "manual",
    });
  } catch {
    return apiError("Cloudflare transcription service unreachable", 502, "upstream_error");
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return apiError(`Cloudflare returned non-JSON transcription response (HTTP ${upstream.status})`, 502, "upstream_error");
  }

  if (!upstream.ok || data?.success === false) {
    // Expose status and a short error classification, but never log speech or tokens.
    const firstError = Array.isArray(data?.errors) ? data.errors[0] : null;
    const message = firstError?.message || data?.error?.message || data?.error || `Cloudflare returned HTTP ${upstream.status}`;
    return apiError(String(message).slice(0, 400), upstream.ok ? 502 : upstream.status, "upstream_error");
  }

  // Workers AI REST /ai/run returns { result:{ text }, success:true }.
  // Also handle direct {text} returned by some API versions.
  const result = data?.result && typeof data.result === "object" ? data.result : data;
  if (typeof result?.text !== "string") {
    return apiError("Cloudflare ASR response missing result.text", 502, "upstream_error");
  }

  const text = result.text;
  if (responseFormat === "text") {
    return new Response(text, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (responseFormat === "verbose_json") {
    // OpenLess accepts plain { text } even when segments aren't available.
    return responseJson({ text, task: "transcribe", language: result.language || language || "" });
  }

  return responseJson({ text });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    const configurationError = validateConfiguration(env);
    if (configurationError) {
      return apiError(configurationError, 503, "configuration_error");
    }

    let settings;
    try {
      settings = getSettings(env);
    } catch (error) {
      return apiError(error.message, 503, "configuration_error");
    }

    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return responseJson({
        ok: true,
        service: "handy-openless-cloudflare-gateway",
        chat_model: settings.chatModel,
        transcription_model: settings.asrModel,
        version: "2.8.0",
      });
    }

    // Preserve Handy's original model picker (only chat model).
    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
      return responseJson({ object: "list", data: [{ id: settings.chatModel, object: "model", created: 0, owned_by: "cloudflare" }] });
    }

    const chat = path === "/v1/chat/completions" || path === "/chat/completions";
    const asr = path === "/v1/audio/transcriptions" || path === "/audio/transcriptions";
    if (!chat && !asr) {
      return apiError("Not found", 404);
    }
    if (request.method !== "POST") {
      return apiError("Method not allowed", 405);
    }

    const cloudflareToken = bearerFrom(request);
    if (!cloudflareToken) {
      return apiError("Provide your Cloudflare Workers AI token in the client's API Key field", 401, "authentication_error");
    }

    const cloudflareAIRoot = getCloudflareAIRoot(env.CF_ACCOUNT_ID);
    return chat
      ? handleChat(request, cloudflareToken, env, cloudflareAIRoot, settings)
      : handleTranscription(request, cloudflareToken, cloudflareAIRoot, settings);
  },
};