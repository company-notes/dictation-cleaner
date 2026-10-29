# Dictation Cleaner

> Self-hosted, OpenAI-compatible speech-to-text cleanup gateway for **OpenWhispr**, **Handy**, and **OpenLess**, using Cloudflare Workers AI and optional Groq fallback.

Dictation Cleaner is a single-file Cloudflare Worker. It forwards dictation transcripts to Qwen3, normalizes chat-completion responses, handles Qwen3's empty final responses with a same-model retry, and optionally falls back to Groq when Cloudflare reports that the daily free quota is exhausted.

**Your own Cloudflare Account ID and tokens are configured in the Cloudflare dashboard. No credentials or account identifiers are hard-coded in `worker.js`.**

## How it works

```text
OpenWhispr / Handy / OpenLess
  ├── Speech recognition: Groq Whisper (configured in the app, optional)
  └── Text cleanup: OpenAI-compatible /v1/chat/completions
          ↓ HTTPS + GATEWAY_API_KEY
     Your Cloudflare Worker
          ↓ CF_API_TOKEN + CF_ACCOUNT_ID
     Cloudflare Workers AI / Qwen3-30B-A3B-FP8
          └── only on confirmed free-quota exhaustion (3036)
              → Groq Qwen3.8-27B (requires GROQ_API_KEY)
```

Cloudflare Whisper ASR is also supported at `/v1/audio/transcriptions`, so you can use the gateway as an optional ASR adapter. When OpenWhispr uses Groq Whisper directly, **audio goes to Groq** and only the transcript is sent to this Worker for cleanup.

## Quick start: Cloudflare Dashboard (no CLI required)

1. Create a Cloudflare account and visit **Workers AI → Use REST API**. Copy your **Account ID** and create a Workers AI API token with **Account → Workers AI → Read** permission. Use the specific account you will configure below.
2. In **Workers & Pages**, create a new Worker (for example, *Start with Hello World*), open **Edit Code**, replace the example with [`worker.js`](./worker.js), and **Deploy**.
3. In your Worker, open **Settings → Variables and Secrets → Add**. Add the values below, then **Deploy** the settings. **Never commit actual secret values to GitHub.**

| Variable name | Cloudflare type | Required | Value |
| --- | --- | --- | --- |
| `CF_ACCOUNT_ID` | **Text** | Yes | **Your own** Cloudflare Account ID (32 hexadecimal characters). |
| `CF_API_TOKEN` | **Secret** | Yes | Your own Cloudflare Workers AI API token. Paste only the token, without `Bearer `. |
| `GATEWAY_API_KEY` | **Secret** | Yes | A **different**, randomly generated key (at least 16 characters; 32+ recommended). You choose this key yourself; put it in your dictation app's API Key field. |
| `GROQ_API_KEY` | **Secret** | No | Your own Groq API key, used **only** for optional Groq text-cleanup fallback. |

**Why two keys?** `CF_API_TOKEN` gives the Worker access to your Cloudflare account and stays on the server. `GATEWAY_API_KEY` authenticates your OpenWhispr/Handy/OpenLess client. This separation prevents handing your Cloudflare account token to every client and prevents anonymous use of your quota. Never reuse the same value for both.

4. Open `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health` in a browser. A correctly configured Worker returns JSON with `"ok":true` and `"version":"2.6.0"`. Missing or invalid required variables yield **503**, including which setting needs attention (never its value).
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
API Key         : Your GATEWAY_API_KEY (not CF_API_TOKEN)
Model           : @cf/qwen/qwen3-30b-a3b-fp8
Disable thinking: On (if available)
```

Use the model-refresh control if OpenWhispr asks you to select a model. The Worker exposes `/v1/models` for the model picker. Do **not** append `/chat/completions` to the base URL; OpenWhispr builds that path.

**Handy and OpenLess** can use the same `/v1` base URL, Qwen3 model ID, and `GATEWAY_API_KEY` for chat cleanup. This gateway accepts both non-streaming JSON and streaming SSE. For Cloudflare ASR via OpenLess, use its OpenAI-compatible speech recognition provider with model `whisper-1` and the same gateway key.

### Configuration change when upgrading from an older Worker

Earlier versions accepted your **Cloudflare API token directly in OpenWhispr's API Key field** and hard-coded the Cloudflare Account ID. Version **2.6.0** deliberately changes this for safer public reuse. **Before deploying the new script, add all three required bindings**, and change the dictation application's API Key to the new **`GATEWAY_API_KEY`**. Your Qwen3 model name and the Worker URL do **not** change. If you do not update the client key, requests will correctly return HTTP **401**.

## API endpoints

| Method / path | Purpose | Authorization |
| --- | --- | --- |
| `GET /health` | Health/version; **503** if config missing | Public (no secret values returned) |
| `GET /v1/models` | OpenAI-compatible Qwen3 model listing | Public (non-sensitive metadata) |
| `POST /v1/chat/completions` | JSON or SSE chat cleanup | `Authorization: Bearer <GATEWAY_API_KEY>` |
| `POST /v1/audio/transcriptions` | Optional Whisper audio transcription adapter | `Authorization: Bearer <GATEWAY_API_KEY>` |

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
- **Server-side secrets:** `CF_API_TOKEN`, `GATEWAY_API_KEY`, and optional `GROQ_API_KEY` belong in Cloudflare **Secrets**. `CF_ACCOUNT_ID` is a non-secret configuration value. Neither real IDs nor keys are included in this repository.
- **Public Worker protection:** Always configure a strong, unique `GATEWAY_API_KEY`. If you share this key, others can consume your inference quota. A public `/health` response does not authenticate clients.
- **Rotation:** Previously shared or accidentally published credentials should be revoked and replaced, including any pasted into chat or screenshots.
- **Logs:** The Worker only logs response status/shape and count metadata for troubleshooting, not transcript text, model responses, request headers, or keys. Platform request logs may contain network metadata.
- **Local files:** Never commit `.env`, `.dev.vars`, Cloudflare API tokens, or screenshots showing live keys.

## Run the tests

Requires Node.js 22+ (built-in `fetch`, `FormData`, and test runner):

```bash
node --check worker.js
node --test test.mjs
```

Tests mock all HTTP calls and **do not access real Cloudflare/Groq APIs**. They cover required variables, gateway authentication, correct account URL and token, quota fallback, error handling, SSE, optional ASR, and the removed debug endpoint.

## Docs

- [Cloudflare Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Cloudflare Worker variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Groq API](https://console.groq.com/docs/overview)
- [OpenWhispr](https://github.com/OpenWhispr/openwhispr)

