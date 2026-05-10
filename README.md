# Chatbot

Minimal MCP server base for the integration project chatbot, using NVIDIA's free API-compatible endpoint as the LLM backend.

Default API endpoint: `https://integrate.api.nvidia.com/v1/chat/completions` (NVIDIA OpenAI-compatible endpoint).

## What it supports

- MCP JSON-RPC over stdio
- `tools/list`
- `tools/call` with tool: `ask_event_assistant`
- Basic event/user Q&A prompt routing to NVIDIA API

## Setup

1. Set API key:

   ```bash
   export NVIDIA_API_KEY="your-key"
   ```

2. Optional model override:

   ```bash
   export NVIDIA_MODEL="meta/llama-3.1-8b-instruct"
   ```

   Optional API URL override:

   ```bash
   export NVIDIA_API_URL="https://integrate.api.nvidia.com/v1/chat/completions"
   ```

3. Run:

   ```bash
   python src/chatbot_mcp_server.py
   ```

## Test

```bash
python -m unittest discover -s tests -v
```
