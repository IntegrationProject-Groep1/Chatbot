# Project Documentation Master Guide

![Project Status](https://img.shields.io/badge/Status-Complete-success?style=for-the-badge)
![Tech Stack](https://img.shields.io/badge/Python-3.10%2B-blue?style=for-the-badge&logo=python)
![Framework](https://img.shields.io/badge/FastAPI-0.111.0-009688?style=for-the-badge&logo=fastapi)
![AI Model](https://img.shields.io/badge/LLM-Llama--3.1--8b-blueviolet?style=for-the-badge&logo=meta)
![Architecture](https://img.shields.io/badge/Architecture-Decentralized_AI-blue?style=for-the-badge)

Dit bestand bevat de geconsolideerde inhoud van de projectstatus, de integratiehandleiding en de technische aantekeningen voor developers.

---

# DEEL 1: PROJECT STATUS (Oorspronkelijk: PROJECT_STATUS.md)

## ✅ What's Done

### Core Implementation
- ✅ **MCP Server** (`src/chatbot_mcp_server.py`): Full JSON-RPC 2.0 MCP server over stdio
- ✅ **NVIDIA LLM Integration**: Free OpenAI-compatible API endpoint for LLM
- ✅ **RabbitMQ RPC Client** (`src/rabbitmq_rpc.py`): Request-response with correlation_id
- ✅ **XML Builders** (`src/xml_builders.py`): Request builders for all downstream services
- ✅ **XML Parsers** (`src/xml_parsers.py`): Response parsers with error handling
- ✅ **Downstream Tools** (`src/downstream_tools.py`): Integration layer for Planning & Facturatie

### Tools Implemented (8 total)
1. ✅ **ask_event_assistant** - General Q&A with LLM
2. ✅ **list_all_sessions** - Get all available sessions (Planning service)
3. ✅ **list_my_sessions** - Get user's enrolled sessions (Planning service)
4. ✅ **count_my_invoices** - Count user's invoices (Facturatie service)
5. ✅ **total_invoice_cost** - Get total invoice amount (Facturatie service)
6. ✅ **resolve_identity_by_uuid** - Lookup identity by UUID (Identity service)
7. ✅ **delete_user** - (LOCAL) Soft-delete user via Identity RPC
8. ✅ **process_refund** - (LOCAL) Process invoice refund via Facturatie RPC

---

## 🔒 Security & Safety Measures

### 1. Write-Gate Confirmation Flow
To prevent accidental data modification, all "write" operations (tools starting with `delete_`, `update_`, `process_`, etc.) are blocked by a **Write-Gate**.
- **Behavior:** The agent will pause and emit a `confirm_required` event.
- **Confirmation:** The user must explicitly confirm (e.g., "ja", "yes", "confirm", "yep").
- **Persistence:** Pending operations are stored in memory (`_PENDING_WRITE`) until confirmed or the session resets.

### 2. Session Ownership
The API now strictly enforces session ownership.
- **Endpoint:** `/api/session/{session_id}/messages`
- **Verification:** The system verifies that the `identity_uuid` of the requesting admin matches the UUID stored with the session. Unauthorized access attempts return a `403 Forbidden` response.

### 3. Concurrency Safety
The `session_store` uses a thread-safe `threading.Lock` to manage session state. All database persistence operations (`_persist`) are performed *inside* the lock to prevent race conditions during rapid message appends.

### Documentation
- ✅ `README.md` - Architecture, setup, tools documentation
- ✅ `DEVELOPER_NOTES.md` - Implementation notes & decisions
- ✅ `INTEGRATION_GUIDE.md` - Step-by-step integration guide
- ✅ `.env.example` - Environment variables template

### XSD Contracts
- ✅ `xsd/planning_contracts.xsd` - Planning service XML schema
- ✅ `xsd/facturatie_contracts.xsd` - Facturatie service XML schema
- ✅ `xsd/chatbot_contracts.xsd` - Chatbot service contracts (optional)

### Testing
- ✅ `test_basic.py` - Quick smoke tests (MCP initialize, tools list, LLM)
- ✅ `test_integration.py` - Integration test for downstream services

### Configuration
- ✅ `requirements.txt` - Dependencies (pika, python-dotenv)
- ✅ `.gitignore` - Git ignore patterns

---

## 📋 Next Steps for Teams

### Planning Team (Sessions Service)
**Action Items:**
1. ✅ Review `xsd/planning_contracts.xsd`
2. ✅ Implement RPC listener on `planning.exchange` queue
3. ✅ Handle request types:
   - `sessions_list_request` (master_uuid) → returns all sessions
   - `user_enrollments_request` (master_uuid) → returns user's sessions
4. ✅ Return XML responses with status, session list, and error handling

**Testing:**
```bash
# Once Planning service is running:
python test_integration.py
```

**Expected Response:**
```xml
<sessions_list_response>
  <status>ok</status>
  <session>
    <session_id>sess-001</session_id>
    <name>Integration Workshop</name>
    <date>2026-05-15T09:00:00</date>
    <location>Room A</location>
  </session>
</sessions_list_response>
```

### Facturatie Team (Invoices Service)
**Action Items:**
1. ✅ Review `xsd/facturatie_contracts.xsd`
2. ✅ Implement RPC listener on `facturatie.rpc` queue
3. ✅ Handle request types:
   - `invoices_list_request` (master_uuid) → returns all invoices
   - `invoices_total_request` (master_uuid) → returns total amount
4. ✅ Return XML responses with status, invoice data, and error handling

**Testing:**
```bash
# Once Facturatie service is running:
python test_integration.py
```

**Expected Response:**
```xml
<invoices_total_response>
  <status>ok</status>
  <total_amount>150.50</total_amount>
  <currency>EUR</currency>
  <invoice_count>3</invoice_count>
</invoices_total_response>
```

### Frontend Team (Chatbot Client)
**Action Items:**
1. ✅ Start MCP server: `python src/chatbot_mcp_server.py`
2. ✅ Connect to server over stdio (JSON-RPC 2.0)
3. ✅ Call `initialize` method to start session
4. ✅ Get available tools via `tools/list`
5. ✅ Pass `master_uuid` (from user login) to tools

**Example Tool Call:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "list_my_sessions",
    "arguments": {
      "master_uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  }
}
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "You are enrolled in 2 sessions:\n- Integration Workshop (sess-001) on 2026-05-15 at Room A\n- Advanced Topics (sess-002) on 2026-05-16 at Room B"
      }
    ]
  }
}
```

---

## 🔧 Quick Start

### 1. Setup
```bash
cd Chatbot
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your NVIDIA_API_KEY and RabbitMQ settings
```

### 2. Test Basic Functionality
```bash
# Set your NVIDIA API key first
export NVIDIA_API_KEY="your-key-here"

# Run basic tests
python test_basic.py
```

### 3. Run MCP Server
```bash
python src/chatbot_mcp_server.py
```

The server listens on stdin/stdout for JSON-RPC messages.

### 4. Test Integration (after Planning/Facturatie are running)
```bash
python test_integration.py
```

---

## 📦 File Structure

```
Chatbot/
├── src/
│   ├── chatbot_mcp_server.py      # MCP server implementation
│   ├── downstream_tools.py         # Integration layer for RPC calls
│   ├── rabbitmq_rpc.py            # RabbitMQ RPC client
│   ├── xml_builders.py            # XML request builders
│   └── xml_parsers.py             # XML response parsers
├── xsd/
│   ├── planning_contracts.xsd     # Planning service schema
│   ├── facturatie_contracts.xsd   # Facturatie service schema
│   └── chatbot_contracts.xsd      # Chatbot contracts (optional)
├── tests/                          # Unit tests (to be populated)
├── README.md                       # Main documentation
├── DEVELOPER_NOTES.md             # Implementation notes
├── INTEGRATION_GUIDE.md            # Integration guide
├── test_basic.py                  # Quick smoke tests
├── test_integration.py            # Integration test
├── .env.example                   # Environment template
├── requirements.txt               # Python dependencies
└── .gitignore
```

---

## 🔑 Environment Variables

```bash
# Required
NVIDIA_API_KEY=your-key-here

# Optional (defaults provided)
NVIDIA_MODEL=meta/llama-3.1-8b-instruct
NVIDIA_API_URL=https://integrate.api.nvidia.com/v1/chat/completions

# RabbitMQ
RABBITMQ_HOST=localhost
RABBITMQ_PORT=5672
RABBIT_USER=guest
RABBIT_PASS=guest
RABBITMQ_VHOST=/

# Service Queues
IDENTITY_RPC_QUEUE=identity.rpc
PLANNING_RPC_EXCHANGE=planning.exchange
FACTURATIE_RPC_QUEUE=facturatie.rpc
RPC_TIMEOUT=10.0
```

---

## 🎯 Success Criteria

- ✅ MCP server responds to initialize, tools/list, tools/call
- ✅ NVIDIA LLM queries work (requires valid API key)
- ✅ XML builders generate valid requests
- ✅ RabbitMQ RPC client connects and sends messages
- ✅ Planning service responds with sessions
- ✅ Facturatie service responds with invoices
- ✅ Frontend can pass master_uuid and get results

---

## 🐛 Troubleshooting

### "NVIDIA_API_KEY not set"
- Get free key: https://integrate.api.nvidia.com/
- Set: `export NVIDIA_API_KEY="your-key"`

### RPC Timeout / Connection Refused
- Check RabbitMQ is running: `docker-compose ps` (if using docker)
- Verify queue names in .env match downstream services
- Check downstream service logs

### "Unknown tool"
- Ensure frontend is calling valid tool names (from tools/list)
- Check tool name spelling

### XML Parse Error
- Ensure downstream services return valid XML
- Check for `<status>` field in response
- Review XSD contracts

---

## 📚 References

- **MCP Protocol**: https://modelcontextprotocol.io/
- **NVIDIA API**: https://integrate.api.nvidia.com/
- **RabbitMQ**: https://www.rabbitmq.com/
- **XML/XSD**: https://www.w3.org/XML/

---

## 👥 Team Contacts

- **Chatbot Owner**: [Your Name]
- **Planning Team**: [Contact]
- **Facturatie Team**: [Contact]
- **Identity Service**: [Contact]
- **Infrastructure**: [Contact]

---

# DEEL 2: INTEGRATION GUIDE (Oorspronkelijk: INTEGRATION_GUIDE.md)

# Integration Guide v2.0 — Chatbot MCP Server

This document outlines how the **Planning** and **Facturatie** teams should integrate with the Chatbot MCP Server via RabbitMQ RPC.

## 1. Core Principles

- **Protocol**: RabbitMQ RPC (Request/Response using `reply_to` and `correlation_id`).
- **Data Format**: XML (conforming to XSDs in `/xsd`).
- **Encapsulation**: All responses **must** be wrapped in a `<message>` element containing a `<header>` and a `<body>`.

## 2. Planning Service (Sessions)

### Exchange: `planning.exchange`

#### Supported Requests
- `sessions_list_request`: Fetch all available sessions.
- `user_enrollments_request`: Fetch sessions a specific user is enrolled in.

#### Expected Response Format (v2.0)
```xml
<message>
  <header>
    <source>planning</source>
    <type>sessions_list_response</type>
    <correlation_id>REQ_CORRELATION_ID</correlation_id>
    <timestamp>2026-05-15T10:30:15Z</timestamp>
  </header>
  <body>
    <status>ok</status>
    <session>
      <session_id>sess-001</session_id>
      <name>Integration Workshop</name>
      <date>2026-05-15T09:00:00Z</date>
      <location>Room A</location>
      <description>Optional session description</description>
    </session>
  </body>
</message>
```

## 3. Facturatie Service (Invoices)

### Queue: `facturatie.rpc`

#### Supported Requests
- `invoices_list_request`: Fetch a list of all invoices for a user.
- `invoices_total_request`: Fetch the total amount of all invoices for a user.

#### Expected Response Format (v2.0)
```xml
<message>
  <header>
    <source>facturatie</source>
    <type>invoices_total_response</type>
    <correlation_id>REQ_CORRELATION_ID</correlation_id>
  </header>
  <body>
    <status>ok</status>
    <total_amount currency="eur">125.50</total_amount>
    <invoice_count>2</invoice_count>
  </body>
</message>
```

## 4. Error Handling

In case of an error, return a response with `<status>error</status>`. The MCP server is designed to parse multiple error formats for maximum compatibility.

### Standard Service Error
```xml
<message>
  <body>
    <status>error</status>
    <error_code>user_not_found</error_code>
    <error_description>The provided master_uuid does not exist in our records.</error_description>
  </body>
</message>
```

### System Error (v2.3 Standard)
```xml
<message>
  <header>
    <type>system_error</type>
  </header>
  <body>
    <error_code>database_timeout</error_code>
    <error_description>The database took too long to respond.</error_description>
  </body>
</message>
```

## 5. Available MCP Tools

The following tools are exposed by the server for the AI Chatbot:

1.  **`resolve_user_by_email`**: Converts a user's email into their `master_uuid`.
2.  **`list_all_sessions`**: Retrieves all available sessions from the Planning service.
3.  **`list_my_sessions`**: Retrieves sessions the user is enrolled in.
4.  **`count_my_invoices`**: Retrieves the count of invoices for the user.
5.  **`total_invoice_cost`**: Retrieves the total cost and count of all invoices.
6.  **`ask_event_assistant`**: General Q&A tool powered by LLM (NVIDIA).

## 6. Implementation Checklist for Teams

- [ ] Listen on the correct queue/exchange.
- [ ] Use the `correlation_id` from the request in the response header.
- [ ] Ensure all decimal amounts use `.` as a separator (e.g., `150.50`).
- [ ] Wrap all responses in the `<message>` structure.

---

# DEEL 3: DEVELOPER NOTES (Oorspronkelijk: DEVELOPER_NOTES.md)

# Chatbot Development Notes

## Project Structure

```
Chatbot/
├── src/
│   ├── chatbot_mcp_server.py      # Main MCP server + tool implementations
│   ├── downstream_tools.py         # RabbitMQ RPC client wrappers
│   ├── rabbitmq_rpc.py             # Low-level RabbitMQ RPC (correlation_id-based)
│   ├── xml_builders.py             # XML request builders
│   └── xml_parsers.py              # XML response parsers + dataclasses
├── xsd/
│   └── chatbot_contracts.xsd       # XSD schema for all XML contracts
├── tests/
│   └── test_*.py
├── .env.example                    # Environment variables template
├── requirements.txt                # Python dependencies
├── README.md                       # Main documentation
├── INTEGRATION_GUIDE.md            # How to integrate with Planning/Facturatie
├── DEVELOPER_NOTES.md              # This file
├── test_basic.py                   # Quick test script
└── docker-compose.yml              # (optional) Local dev environment
```

## Code Organization

### `chatbot_mcp_server.py`
- **NvidiaLLMClient**: Calls NVIDIA API, handles retries/errors
- **ChatbotMCPServer**: Tool definitions and dispatch logic
  - Tool registry: `tools_list()`
  - Tool executor: `call_tool(name, arguments)`
- **JSONRPCMCPAdapter**: Handles MCP JSON-RPC protocol
- **build_server_from_env()**: Factory function

### `downstream_tools.py`
- **DownstreamConfig**: Environment-based config (dataclass)
- **Helper functions**:
  - `resolve_master_uuid_by_email(email)` - Get user ID from email
  - `get_all_sessions(master_uuid)` - Query Planning for all sessions
  - `get_user_enrollments(master_uuid)` - Query Planning for user sessions
  - `get_invoices_list(master_uuid)` - Query Facturatie for invoice list
  - `get_invoices_total(master_uuid)` - Query Facturatie for invoice sum

Each function:
1. Builds XML request via `xml_builders.py`
2. Makes RPC call via `RabbitMQRpcClient`
3. Parses response via `xml_parsers.py`

### `xml_builders.py`
Simple XML construction:
```python
def build_sessions_list_request(master_uuid: str) -> str:
    root = ET.Element("sessions_list_request")
    _xml_text(root, "master_uuid", master_uuid)
    return ET.tostring(root, encoding="unicode")
```

### `xml_parsers.py`
Dataclasses for type safety + parsing logic:
```python
@dataclass
class Session:
    session_id: str
    name: str
    date: str
    location: str

def parse_sessions_list_response(xml_text: str) -> list[Session]:
    # Parse XML, check <status>, extract <session> elements
```

### `rabbitmq_rpc.py`
Low-level RPC client (already provided):
- Context manager pattern (safe cleanup)
- Correlation ID matching
- Timeout handling
- Configurable connection params

## Adding a New Tool

Let's say you want to add a "get_user_profile" tool from a "UserService":

### 1. Add builder in `xml_builders.py`
```python
def build_user_profile_request(master_uuid: str) -> str:
    root = ET.Element("user_profile_request")
    _xml_text(root, "master_uuid", master_uuid)
    return ET.tostring(root, encoding="unicode")
```

### 2. Add parser in `xml_parsers.py`
```python
@dataclass
class UserProfile:
    first_name: str
    last_name: str
    email: str

def parse_user_profile_response(xml_text: str) -> UserProfile:
    root = ET.fromstring(xml_text)
    status = (root.findtext("status") or "").strip().lower()
    if status != "ok":
        code = (root.findtext("error_code") or "UNKNOWN").strip()
        msg = (root.findtext("message") or "Error").strip()
        raise RuntimeError(f"user-service error {code}: {msg}")
    
    first_name = (root.findtext("first_name") or "").strip()
    last_name = (root.findtext("last_name") or "").strip()
    email = (root.findtext("email") or "").strip()
    
    return UserProfile(first_name, last_name, email)
```

### 3. Add RPC wrapper in `downstream_tools.py`
```python
def get_user_profile(master_uuid: str, cfg: DownstreamConfig) -> UserProfile:
    req_xml = build_user_profile_request(master_uuid)
    with RabbitMQRpcClient() as rpc:
        result = rpc.call(
            cfg.user_service_queue,  # Add to DownstreamConfig
            req_xml.encode("utf-8"),
            timeout_seconds=cfg.rpc_timeout,
        )
    return parse_user_profile_response(result.body.decode("utf-8", errors="replace"))
```

### 4. Add tool to `chatbot_mcp_server.py`
```python
class ChatbotMCPServer:
    # ...
    TOOL_GET_PROFILE = "get_user_profile"
    
    def tools_list(self) -> dict[str, Any]:
        return {
            "tools": [
                # ... existing tools ...
                {
                    "name": self.TOOL_GET_PROFILE,
                    "description": "Get user profile information",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "master_uuid": {"type": "string"}
                        },
                        "required": ["master_uuid"],
                    },
                }
            ]
        }
    
    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        # ...
        if name == self.TOOL_GET_PROFILE:
            master_uuid = self._require_master_uuid(arguments)
            profile = get_user_profile(master_uuid, self.cfg)
            text = f"{profile.first_name} {profile.last_name} ({profile.email})"
            return {"content": [{"type": "text", "text": text}]}
```

### 5. Update .env.example
```bash
USER_SERVICE_QUEUE=user.rpc
```

### 6. Update DownstreamConfig
```python
@dataclass(frozen=True)
class DownstreamConfig:
    # ...
    user_service_queue: str = _env("USER_SERVICE_QUEUE", "user.rpc")
```

## Testing Strategy

### Unit Tests (`tests/test_*.py`)
```python
def test_parse_sessions_response():
    xml = """
    <sessions_list_response>
        <status>ok</status>
        <session>
            <session_id>s1</session_id>
            <name>Workshop</name>
            <date>2026-05-15</date>
            <location>Room A</location>
        </session>
    </sessions_list_response>
    """
    sessions = parse_sessions_list_response(xml)
    assert len(sessions) == 1
    assert sessions[0].name == "Workshop"
```

### Integration Tests
```bash
# Requires RabbitMQ + downstream services running
python test_integration.py
```

### Manual Testing
```bash
# Start MCP server
python src/chatbot_mcp_server.py

# In another terminal, send JSON-RPC test
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | nc localhost 9999
```

## Error Handling Patterns

### Parser errors
```python
try:
    sessions = parse_sessions_list_response(xml_response)
except RuntimeError as e:
    # Service returned error XML
    return {"content": [{"type": "text", "text": f"Planning service error: {e}"}]}
except ET.ParseError as e:
    # Malformed XML
    return {"content": [{"type": "text", "text": f"Planning service returned invalid XML: {e}"}]}
```

### RPC errors
```python
try:
    result = rpc.call(queue, xml, timeout_seconds=10)
except TimeoutError:
    return {"content": [{"type": "text", "text": "Request timed out"}]}
```

### All errors flow through `JSONRPCMCPAdapter._error()`
```python
except ValueError as exc:
    return self._error(request_id, -32602, str(exc))  # Invalid params
except RuntimeError as exc:
    return self._error(request_id, -32000, str(exc))  # Server error
```

## Best Practices

1. **Always validate master_uuid**: Check format/length before RPC
2. **Use dataclasses**: Type safety for parsed responses
3. **Handle timeouts gracefully**: User-friendly messages
4. **Log RPC calls**: For debugging in production
5. **Batch requests if possible**: Reduce RPC overhead
6. **Cache XML schemas**: Validate incoming responses if XSD available
7. **Use correlation_id tracing**: Track requests through system

## Configuration Hierarchy

```
.env file (highest priority)
    ↓
os.getenv() (environment variables)
    ↓
DownstreamConfig defaults (lowest priority)
```

Example:
```python
# If PLANNING_RPC_EXCHANGE env var is set, use it
# Otherwise use "planning.exchange"
planning_exchange: str = _env("PLANNING_RPC_EXCHANGE", "planning.exchange")
```

## Performance Tuning

1. **RPC Timeout**: 
   - Default: 10s
   - Increase if downstream services are slow
   - Decrease if you want faster timeouts

2. **Connection Pooling**:
   - Currently creates new RabbitMQ connection per RPC call
   - For high load: implement connection pool

3. **Caching**:
   - Sessions rarely change: cache for 5-10 minutes
   - Invoices: cache for 1 minute or ask user to refresh

4. **Batch Queries**:
   - If frontend needs sessions + invoices: call both tools in parallel

## Debugging

### Enable RabbitMQ logging
```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

### Print RPC messages
```python
# In downstream_tools.py
print(f"→ Sending: {req_xml}")
print(f"← Received: {result.body.decode('utf-8')}")
```

### Test XML parsing
```python
python3 -c "
from src.xml_parsers import parse_sessions_list_response
xml = open('test_response.xml').read()
print(parse_sessions_list_response(xml))
"
```

## Known Limitations

1. **No request validation against XSD**: Could add with `lxml` if needed
2. **No caching layer**: Every tool call hits downstream service
3. **Simple RPC correlation**: Assumes single-threaded use (safe for stdio)
4. **XML only**: No JSON variant yet
5. **No authentication to downstream services**: Assumes secure RabbitMQ network

## Future Improvements

- [ ] Add response caching layer
- [ ] Support for batch RPC calls
- [ ] XSD validation for responses
- [ ] Circuit breaker pattern for failing services
- [ ] Metrics/tracing integration
- [ ] JSON variant of contracts
- [ ] GraphQL query language support
