# Dictation Cleaner

An OpenAI-compatible Cloudflare Worker for AI dictation cleanup, designed for **OpenWhispr**, **Handy**, and **OpenLess**. It uses **Cloudflare Workers AI** for text cleanup and can optionally switch to a **Groq** text model when Cloudflare's daily free inference quota is exhausted.

This is a single-file Worker. You can deploy it from the Cloudflare dashboard without installing a command-line tool.

## How it works

The chat gateway supports **any Cloudflare Workers AI text-generation model that accepts OpenAI Chat Completions**, not just Qwen. The preferred `CHAT_MODEL` is not an allowlist. Authenticated `GET /v1/models` uses Cloudflare's current text-generation catalog; a caller can also submit another valid `@cf/author/model` ID directly. Cloudflare determines whether that model and request parameters are actually supported.


```text
OpenWhispr / Handy / OpenLess
  ├─ Speech recognition: Groq Whisper (configured directly in the app)
  └─ Text cleanup: OpenAI-compatible /v1/chat/completions
               │  Your Cloudflare Workers AI token
               ▼
          Your Cloudflare Worker
               │  CF_ACCOUNT_ID + the same Bearer token
               ▼
    Cloudflare Workers AI / selected @cf/... chat model
               └─ Optional: on daily free quota exhaustion only
                  → Groq Qwen3.8-27B (requires GROQ_API_KEY)
```

You can also use the Worker's `/v1/audio/transcriptions` endpoint as a Cloudflare Whisper ASR adapter. When OpenWhispr uses Groq Whisper directly, audio goes to Groq and the transcript goes to this Worker for cleanup.

## Deploy in Cloudflare

1. In your [Cloudflare dashboard](https://dash.cloudflare.com/), open **Workers AI → Use REST API**. Find your **Account ID** and create a **Workers AI API token** with access to that account.
2. Open **Workers & Pages**, create a Worker (for example, **Start with Hello World**), choose **Edit Code**, and replace the example with [`worker.js`](./worker.js).
3. Click **Deploy**.
4. Open your Worker **Settings → Variables and Secrets → Add** and configure the variables below. Deploy the updated settings.
5. Visit `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health`. A successful deployment returns JSON containing `"ok": true` and a version number.

**Required Worker variable**

| Name | Type | Value |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | Text | Your Cloudflare Account ID (32 hexadecimal characters) |

**Optional Worker secret**

| Name | Type | Value |
| --- | --- | --- |
| `GROQ_API_KEY` | Secret | Your Groq API key, used only for the optional text-cleanup fallback |

**Where to put the Cloudflare API token:** Enter it in your dictation application's **API Key** field. The Worker forwards `Authorization: Bearer <your Cloudflare Workers AI token>` to Cloudflare. There is no server-side Cloudflare token binding to configure. Never put a real token in `worker.js`, GitHub, a README, or screenshots.

### Optional model, limit, and language settings

All settings below can be added under **Settings → Variables and Secrets** as **Text** variables. Omit a variable to keep the default. The values shown here are the defaults and are applied without any configuration.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHAT_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | Preferred Cloudflare model; appears first in the picker; not a restriction |
| `CHAT_MODELS` | *(empty)* | Optional comma-separated additional model IDs shown if the Cloudflare catalog is unavailable |
| `GROQ_CHAT_MODEL` | `qwen/qwen3.8-27b` | Groq text fallback model |
| `GROQ_CHAT_URL` | `https://api.groq.com/openai/v1/chat/completions` | HTTPS Groq chat-completions endpoint |
| `ASR_MODEL` | `@cf/openai/whisper-large-v3-turbo` | Cloudflare audio transcription model |
| `ASR_ALIASES` | `whisper-1,whisper-large-v3-turbo,<ASR_MODEL>` | Comma-separated model names accepted by the ASR adapter; `<ASR_MODEL>` is replaced with the actual `ASR_MODEL` value |
| `MAX_CHAT_BYTES` | `65536` | Maximum JSON chat request size (bytes) |
| `MAX_AUDIO_BYTES` | `5242880` | Maximum uploaded audio file size (bytes) |
| `MAX_MULTIPART_BYTES` | `MAX_AUDIO_BYTES + 65536` | Maximum multipart request size (bytes), including form overhead |
| `DEFAULT_ASR_LANGUAGE` | `zh` | Default Whisper language; set to an empty string for automatic detection |
| `ASR_VOCAB_HINT` | `model, Qwen3, Qwen3-30B-A3B, Cloudflare, Workers AI, Handy, API, LLM, ASR, reasoning_effort, prompt, token, OpenRouter, Ollama` | Comma-separated context vocabulary provided as a Whisper prompt; set to an empty string to disable |

If you change `MAX_AUDIO_BYTES` but omit `MAX_MULTIPART_BYTES`, the multipart limit automatically follows your audio limit plus 65,536 bytes. Explicit multipart limits must be at least the audio limit. Numeric limits must be positive integers. Invalid settings return a configuration error (503) instead of silently reverting to a default.

`ASR_ALIASES` is a list of accepted incoming names, not the Cloudflare model ID itself. For example, `whisper-1,my-whisper` permits those two identifiers. Changing the actual ASR model does not require changing the client model name if you keep an alias.

## Configure OpenWhispr (Windows)

### 1. Speech recognition

In **Settings → AI Models → Speech-to-text → Dictation**, choose a cloud provider such as **Groq**, or configure a custom OpenAI-compatible provider:

```text
Endpoint URL : https://api.groq.com/openai/v1
API Key      : your Groq API key
Model        : whisper-large-v3
```

You can try `whisper-large-v3-turbo` if you want faster transcription. Your Groq transcription settings are independent of the Worker's optional `GROQ_API_KEY` fallback secret.

### 2. AI dictation cleanup

In **Settings → AI Models → Language Model → Dictation Cleanup**, enable text cleanup, select **Self Hosted / OpenAI-compatible**, and configure:

```text
Endpoint URL    : https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/v1
API Key         : your Cloudflare Workers AI API token
Model           : @cf/qwen/qwen3-30b-a3b-fp8
Disable thinking: on (if offered)
```

With an API token that has Workers AI Read permission, the model picker requests Cloudflare's **live text-generation model catalog**; `CHAT_MODEL` is listed first. Without a token or catalog permission, it lists `CHAT_MODEL` and any IDs in `CHAT_MODELS`. Refresh the list and **explicitly select** the model you want; changing `CHAT_MODEL` does not overwrite a model already saved in OpenWhispr. Specify the base URL ending in `/v1` — **do not** append `/chat/completions`.

The Worker accepts other syntactically valid `@cf/author/model` IDs even when they are not shown in the picker. Cloudflare decides whether a given model works with Chat Completions; image, embeddings, transcription and other incompatible models cannot be used for text cleanup here. Qwen3 and Qwen3.8 retain their legacy no-thinking behavior; **other models keep their own request parameters**. To show Qwen3.8 even when model-catalog fetching is denied, set `CHAT_MODELS=@cf/qwen/qwen3.8-27b`.

Qwen3 retains its existing `/no_think` behavior; Qwen3.8 uses `chat_template_kwargs.enable_thinking: false` and respects valid low temperatures (for example `0.2`). Both keep the existing Cloudflare daily-quota-only Groq fallback.

Handy and OpenLess can use the same `/v1` URL, model ID, and their own Cloudflare Workers AI tokens. Chat cleanup accepts JSON responses and streaming SSE; the optional Cloudflare ASR adapter accepts model `whisper-1` by default.

### 3. Cleanup prompt (optional)

OpenWhispr's **Prompt Studio** can customize text cleanup. For example:

```text
請以台灣繁體中文整理語音逐字稿，保留原本意思和語氣。
移除無意義的「嗯、呃、就是」和意外重複，修正標點與明顯口誤。
說話者改口時，以最後明確表達的內容為準。
保留 model、Qwen3、API、Cloudflare 等技術詞及原本大小寫。
只輸出整理後的文字，不要補充解釋。
```

## API endpoints

| Method / path | Purpose | Authorization |
| --- | --- | --- |
| `GET /health` | Service status, model IDs and version | None; does not expose tokens |
| `GET /v1/models` | OpenAI-compatible model list; live Cloudflare text-generation catalog if token is supplied | Optional Bearer token; catalog listing requires Workers AI Read permission |
| `POST /v1/chat/completions` | Text cleanup (JSON or SSE) | Your Cloudflare Workers AI Bearer token |
| `POST /v1/audio/transcriptions` | Optional Cloudflare Whisper adapter | Your Cloudflare Workers AI Bearer token |

The model, chat and audio paths also accept requests without the `/v1` prefix for compatibility.

## Groq fallback

- **Primary:** any compatible Cloudflare `@cf/...` chat model selected by the client; `CHAT_MODEL` controls picker order. For non-streaming requests, the Worker retries the same model once if Cloudflare produces no usable final text.
- **Fallback:** the configured Groq `GROQ_CHAT_MODEL` only on HTTP **429** indicating the Cloudflare daily free quota has been exhausted (error **3036** or the equivalent quota message), and only when `GROQ_API_KEY` is configured.
- **No automatic fallback:** HTTP 400/401/403, generic 429, capacity error **3040**, or unrelated upstream failures. An unconfigured fallback returns a clear quota error.

Cloudflare and Groq offer different models and have separate quotas, pricing and privacy terms. A fallback request forwards the text and cleanup instructions to Groq; it does not send the original audio recording. Model availability and free limits can change.

## Privacy and security

- This is **not** a fully local speech recognition pipeline. Groq Whisper may receive audio, and Cloudflare Workers AI receives transcribed text.
- A request with a Cloudflare API token is sent over HTTPS to your Worker. The Worker forwards the same token to Cloudflare, which validates it. Anyone with a valid token for your configured account could consume that account's inference quota; do not share tokens publicly.
- The optional Groq fallback uses `GROQ_API_KEY` stored as a Worker **Secret**. Keep it out of source control.
- The Worker logs model routing (`[llm-route] selected_model`) and limited response-status/shape metadata (`[cf-chat]` records both `requested_model` and `upstream_model` when Cloudflare provides it); it does **not** log transcript text, request headers, API tokens or full model outputs. Cloudflare's platform logs may still contain network metadata.
- Revoke any API token that has been posted in a public forum, repository or shared screenshot.

## Tests

Node.js 22+ is recommended. The test suite uses mocked upstream responses and does not access a real Cloudflare or Groq account.

```bash
node --check worker.js
node --test test.mjs
```

## References

- [Cloudflare Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Cloudflare Worker variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Groq API](https://console.groq.com/docs/overview)
- [OpenWhispr](https://github.com/OpenWhispr/openwhispr)
### Verify the selected model

After deployment, use OpenWhispr for one dictation and inspect Cloudflare Observability logs for `[llm-route] selected_model`. `provider: cloudflare` and the `model` field identify the submitted model; `[cf-chat]` reports `requested_model`, `upstream_model` (if returned), and `upstream_status`. On quota-only Groq failover, `[llm-route] cloudflare_daily_quota_exhausted` explicitly reports the different `fallback_model`. For streaming requests, the selected-model log records the request; the actual model reported by the stream is not parsed.

The live model catalog uses Cloudflare [`GET /accounts/{account_id}/ai/models/search`](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/) with the caller's API token, requesting `task=text-generation`. Listing supports up to five pages of 100 entries; if the request fails, the Worker lists the configured model IDs instead.
