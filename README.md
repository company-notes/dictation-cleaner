# Dictation Cleaner

> A lightweight OpenAI-compatible transcript cleanup gateway powered by Cloudflare Workers AI.

Dictation Cleaner is a Cloudflare Worker that improves speech-to-text output using LLMs.

It sits between your dictation tool and an AI model, cleaning up transcripts by removing filler words, fixing punctuation, correcting obvious recognition errors, and improving readability while preserving the speaker's original meaning.

The API is OpenAI-compatible and can be used with any application that supports OpenAI-style chat completion endpoints.

---

## Features

- OpenAI-compatible API
- Powered by Cloudflare Workers AI
- Optimized for speech-to-text transcript cleanup
- Removes filler words and accidental repetitions
- Fixes punctuation and formatting
- Preserves speaker intent and writing style
- Works with OpenWhispr, OpenLess, Handy, Whisper-based workflows, and custom integrations
- Optional Groq fallback when Cloudflare free quota is exhausted
- Simple single-file deployment

---

## How It Works

```text
Speech Input
      ↓
 Speech-to-Text
      ↓
 Dictation Cleaner
      ↓
 Cloudflare Workers AI
      ↓
 Cleaned Transcript
```

For example:

### Input

```text
Um... so I think we should probably finish the API first and then maybe start testing.
```

### Output

```text
I think we should finish the API first, then start testing.
```

The goal is not to rewrite the content, but to make the transcript cleaner and easier to read.

---

## Supported Use Cases

- Voice typing
- Dictation workflows
- Meeting notes
- Transcript correction
- Speech-to-text post-processing
- AI-assisted writing workflows

Compatible with tools such as:

- OpenWhispr
- OpenLess
- Handy
- Whisper CLI
- Faster-Whisper
- whisper.cpp
- Custom speech-to-text applications

---

## Default Model

This project is designed around:

```text
@cf/qwen/qwen3-30b-a3b-fp8
```

You can modify the Worker to use other Workers AI models if desired.

---

## Deploy to Cloudflare Workers

### 1. Create a Cloudflare Account

Sign in to Cloudflare and enable Workers AI.

### 2. Create a New Worker

Create a new Worker from the Cloudflare Dashboard.

### 3. Copy the Worker Source Code

Replace the default Worker code with the contents of:

```text
worker.js
```

### 4. Configure Your Account Information

Update any required configuration variables.

### 5. Deploy

Deploy your Worker.

Once deployed, you will receive a URL similar to:

```text
https://your-worker.your-subdomain.workers.dev
```

---

## Health Check

After deployment:

```text
https://your-worker.your-subdomain.workers.dev/health
```

A successful response indicates that the Worker is running correctly.

---

## API Endpoint

Use the following endpoint in applications that support OpenAI-compatible APIs:

```text
https://your-worker.your-subdomain.workers.dev/v1
```

---

## OpenWhispr Example Configuration

```text
Provider      : Self Hosted
Endpoint URL  : https://your-worker.your-subdomain.workers.dev/v1
API Key       : Your Cloudflare Workers AI Token
Model         : @cf/qwen/qwen3-30b-a3b-fp8
```

---

## Recommended Cleanup Prompt

You may customize the cleanup instructions to fit your workflow.

Example:

```text
You are a transcript cleanup assistant.

Preserve the speaker's original meaning, tone, and writing style.

Remove filler words such as "um", "uh", and other verbal pauses when they do not contribute meaning.

Remove accidental repetitions.

Correct obvious speech recognition mistakes, punctuation, and formatting issues.

Do not add new information.

Return only the cleaned transcript.
```

---

## Optional Groq Fallback

When Cloudflare Workers AI quota limits are reached, the Worker can optionally redirect cleanup requests to Groq.

Create a Worker Secret:

```text
GROQ_API_KEY
```

Set the value to your Groq API key and redeploy the Worker.

The fallback mechanism is only triggered for supported quota-exhaustion scenarios.

---

## Privacy Notice

This is not a local-only solution.

Depending on your configuration:

- Audio may be processed by your speech-to-text provider
- Transcript text may be sent to Cloudflare Workers AI
- Optional fallback requests may be sent to Groq

Do not use this setup for data that cannot be processed by third-party cloud services.

---

## Why This Project Exists

Many dictation tools provide excellent speech recognition but limited transcript cleanup capabilities.

Dictation Cleaner provides a lightweight, inexpensive, and flexible way to add AI-powered transcript correction without being tied to a specific dictation platform.

---

## License

MIT License
