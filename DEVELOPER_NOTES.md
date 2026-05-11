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
