● Now here's how to run everything locally — you need 4 terminals:
 
  ---
  Terminal 1 — RabbitMQ
  docker run -p 5672:5672 -p 15672:15672 rabbitmq:3-management-alpine
 
  Terminal 2 — Mock identity service (so login works without the real identity service running)
  cd C:\Users\Mediamonster\Documents\GitHub\Chatbot
  python tests/mock_services.py
 
  Terminal 3 — MCP servers (our two: sessions + monitoring)
  # Sessions MCP (port 8001) — will connect but tool calls fail gracefully without Drupal
  python -m src.mcp_servers.sessions
 
  # In a separate terminal, or background it:
  python -m src.mcp_servers.monitoring   # port 8005
 
  Terminal 4 — Chatbot
  cd C:\Users\Mediamonster\Documents\GitHub\Chatbot
  cp .env.example .env   # first time only — then add your NVIDIA_API_KEY
  python main.py
 
  Then open http://localhost:8000 → enter any email → you'll land in the chat.
 
  ---
  What works vs what errors:
 
  ┌────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │            Feature             │                                               Status                                                │
  ├────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Login (email → UUID)           │ ✅ mock returns a UUID                                                                              │
  ├────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Sending a message              │ ✅ needs NVIDIA_API_KEY                                                                             │
  ├────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Session/monitoring tool calls  │ ⚠️  MCP servers connect but tool calls fail (no Drupal/ES locally) — chatbot handles this gracefully │
  ├────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Facturatie / CRM / Kassa tools │ ⚠️  not in MCP_SERVERS yet — chatbot just won't have those tools                                     │
  └────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────┘
 
  Make sure your .env has:
  MCP_SERVERS=sessions@http://localhost:8001/mcp,monitoring@http://localhost:8005/mcp