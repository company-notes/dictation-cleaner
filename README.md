# Dictation Cleaner

> Self-hosted, OpenAI-compatible speech-to-text cleanup gateway for **OpenWhispr**, **Handy**, and **OpenLess**, using Cloudflare Workers AI and optional Groq fallback.

Dictation Cleaner is a single-file Cloudflare Worker. It forwards dictation transcripts to Qwen3, normalizes chat-completion responses, handles Qwen3's empty final responses with a same-model retry, and optionally falls back to Groq when Cloudflare reports that the daily free quota is exhausted.

**Set your Cloudflare Account ID as a Worker variable. Enter your Workers AI API token directly in OpenWhispr, just as in the original working setup. No Account ID or token is hard-coded in `worker.js`.**

## How it works

```text
OpenWhispr / Handy / OpenLess
  ├── Speech recognition: Groq Whisper (configured in the app, optional)
  └── Text cleanup: OpenAI-compatible /v1/chat/completions
          ↓ HTTPS + your Cloudflare Workers AI token (Bearer)
     Your Cloudflare Worker
          ↓ same Bearer token + CF_ACCOUNT_ID
     Cloudflare Workers AI / Qwen3-30B-A3B-FP8
          └── only on confirmed free-quota exhaustion (3036)
              → Groq Qwen3.8-27B (requires GROQ_API_KEY)
```

Cloudflare Whisper ASR is also supported at `/v1/audio/transcriptions`, so you can use the gateway as an optional ASR adapter. When OpenWhispr uses Groq Whisper directly, **audio goes to Groq** and only the transcript is sent to this Worker for cleanup.

## Quick start: Cloudflare Dashboard (no CLI required)

1. Create a Cloudflare account and visit **Workers AI → Use REST API**. Copy your **Account ID** and create a Workers AI API token with **Account → Workers AI → Read** permission. Use the specific account you will configure below.
2. In **Workers & Pages**, create a new Worker (for example, *Start with Hello World*), open **Edit Code**, replace the example with [`worker.js`](./worker.js), and **Deploy**.
3. In your Worker, open **Settings → Variables and Secrets → Add**. Set **`CF_ACCOUNT_ID`** as a **Text** variable containing your own 32-character Account ID, then **Deploy**. **Do not enter your Cloudflare API token in Worker settings**; the client will supply it on each request.

| Variable name | Cloudflare type | Required | Value |
| --- | --- | --- | --- |
| `CF_ACCOUNT_ID` | **Text** | Yes | Your Cloudflare Account ID (32 hexadecimal characters). |
| `GROQ_API_KEY` | **Secret** | No | Your Groq API key, only for fallback when Cloudflare's daily free quota is exhausted. |

**Cloudflare token:** Obtain a Workers AI API token in your Cloudflare account and enter it in **OpenWhispr's API Key field**. The Worker forwards the client's `Authorization: Bearer ...` header to Cloudflare. There is no `CF_API_TOKEN` or `GATEWAY_API_KEY` variable. Keep the token private, and do not embed it in source code, a public README, or screenshots.

4. Open `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health` in a browser. A correctly configured Worker returns JSON with `"ok":true` and `"version":"2.7.0"`. Missing or invalid required variables yield **503**, including which setting needs attention (never its value).
5. Configure your dictation client using the Worker base URL plus `/v1`.

### OpenWhispr (Windows)

In **AI Models → Speech-to-text**, choose **Groq** (or Custom) and configure your speech-recognition provider. For example:

```text
Speech provider : Groq / Custom
Base URL        : https://api.groq.com/openai/v1
API key         : Your Groq API key
ASR model       : whisper-large-v3 (or whisper-large-v3-turbo)
```

In **AI Models → Language Model → Dictation Cleanup**, enable cleanup and choose **Self Hosted / OpenAI-compatible**:

```text
Base URL        : https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/v1
API Key         : Your Cloudflare Workers AI API token
Model           : @cf/qwen/qwen3-30b-a3b-fp8
Disable thinking: On (if available)
```

Use the model-refresh control if OpenWhispr asks you to select a model. The Worker exposes `/v1/models` for the model picker. Do **not** append `/chat/completions` to the base URL; OpenWhispr builds that path.

**Handy and OpenLess** can use the same `/v1` base URL, Qwen3 model ID, and their own Cloudflare Workers AI API token for chat cleanup. This gateway accepts both non-streaming JSON and streaming SSE. For Cloudflare ASR via OpenLess, use its OpenAI-compatible speech recognition provider with model `whisper-1` and the same gateway key.

### Upgrading from the earlier Gateway Key version

This version **restores the original authentication behavior**. Keep the same Worker URL and Qwen3 model. Set `CF_ACCOUNT_ID` in Cloudflare Worker Variables; in your dictation app's API Key field, use **your Cloudflare Workers AI API token directly**, not the gateway key. The formerly required `CF_API_TOKEN` and `GATEWAY_API_KEY` Worker Secrets are no longer used and may be deleted from Worker settings. `GROQ_API_KEY` remains optional.

## API endpoints

| Method / path | Purpose | Authorization |
| --- | --- | --- |
| `GET /health` | Health/version; **503** if Account ID missing | Public (no secret values returned) |
| `GET /v1/models` | OpenAI-compatible Qwen3 model listing | Public (non-sensitive metadata) |
| `POST /v1/chat/completions` | JSON or SSE chat cleanup | `Authorization: Bearer <Cloudflare Workers AI API token>` |
| `POST /v1/audio/transcriptions` | Optional Whisper audio transcription adapter | `Authorization: Bearer <Cloudflare Workers AI API token>` |

Without the `/v1` prefix, the model/chat/audio routes are also accepted for compatibility. The previous `/debug/qwen` endpoint has been **removed** (404).

## Models and fallback behavior

- **Primary:** Cloudflare `@cf/qwen/qwen3-30b-a3b-fp8`, with `/no_think` control; if Cloudflare returns 200 but no usable final content, the Worker retries **the same model** once without that control for non-streaming requests.
- **Optional fallback:** Groq `qwen/qwen3.8-27b` only when a Cloudflare HTTP **429** clearly means daily free-neuron quota exhausted (**Cloudflare error code 3036** or matching quota wording). This is a **different Qwen model**, not the same model hosted elsewhere.
- **No fallback** for authorization errors, malformed requests, generic 429, or Cloudflare error **3040** (capacity issues). If `GROQ_API_KEY` is missing, the gateway returns an explicit quota error instead of silently using another provider.
- **ASR:** Cloudflare `@cf/openai/whisper-large-v3-turbo` is available through this Worker's optional ASR endpoint; external Groq Whisper ASR is configured directly in OpenWhispr and is unrelated to the text-cleanup fallback.

Provider free limits, availability, and model names can change. Neither service guarantees unlimited free processing; if a provider bills your account, charges may apply. The Worker never silently changes to Groq unless the documented quota condition is detected and its key has been configured.

## Custom cleanup prompt

Configure your cleanup instructions in OpenWhispr's **Prompt Studio**. An example for Traditional Chinese:

```text
請以台灣繁體中文整理語音逐字稿，保留原本意思和語氣。
移除無意義的「嗯、呃、就是」和意外重複，修正標點與明顯口誤。
說話者改口時，以最後明確表達的內容為準。
保留 model、Qwen3、API、Cloudflare 等技術詞及原本大小寫。
只輸出整理後的文字，不要補充解釋。
```

The client controls the prompt; this project is an API adapter, not a replacement for speech recognition or OpenWhispr's prompt settings.

## Privacy and security

- **Not a local-only solution:** Cloud speech recognition can send audio to Groq; cleanup sends text to Cloudflare Workers AI. Optional fallback sends the cleanup request to Groq.
- **Configuration:** `CF_ACCOUNT_ID` is a non-secret Worker Text variable. OpenWhispr supplies the Cloudflare Workers AI API token per request. Optional `GROQ_API_KEY` belongs in Cloudflare **Secrets**. Do not commit real IDs or keys.
- **Authentication:** Chat and optional ASR endpoints require an `Authorization: Bearer <Cloudflare Workers AI API token>` header. The Worker forwards the token to Cloudflare without storing it; Cloudflare validates it. Do not share your Cloudflare token with untrusted users.
- **Rotation:** Previously shared or accidentally published credentials should be revoked and replaced, including any pasted into chat or screenshots.
- **Logs:** The Worker only logs response status/shape and count metadata for troubleshooting, not transcript text, model responses, request headers, or keys. Platform request logs may contain network metadata.
- **Local files:** Never commit `.env`, `.dev.vars`, Cloudflare API tokens, or screenshots showing live keys.

## Run the tests

Requires Node.js 22+ (built-in `fetch`, `FormData`, and test runner):

```bash
node --check worker.js
node --test test.mjs
```

Tests mock all HTTP calls and **do not access real Cloudflare/Groq APIs**. They cover the required Account ID, client-provided Bearer token, correct account URL, quota fallback, error handling, SSE, optional ASR, and the removed debug endpoint.

## Docs

- [Cloudflare Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Cloudflare Worker variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Groq API](https://console.groq.com/docs/overview)
- [OpenWhispr](https://github.com/OpenWhispr/openwhispr)
