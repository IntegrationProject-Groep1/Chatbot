# Chatbot MCP Server

A Model Context Protocol (MCP) server that connects an AI Chatbot to an event integration platform. It uses RabbitMQ and XML to communicate with downstream services (Planning and Facturatie).

## 🚀 Features

- **MCP Server Implementation**: Handles JSON-RPC 2.0 requests over stdio.
- **AI Toolset**: Provides tools for resolving users, listing sessions, and checking invoices.
- **RabbitMQ RPC**: Implements a request-response pattern with `correlation_id` for downstream communication.
- **XML Standards**: Fully compliant with v2.0/v2.3 XML message standards (Header/Body wrapping).
- **LLM Integration**: Integrated with NVIDIA's Llama-3.1-8b for general event assistance.

## 🛠 Available Tools

| Tool | Description | Input |
|------|-------------|-------|
| `resolve_user_by_email` | Resolves an email address to a `master_uuid` via Identity Service. | `email` |
| `list_all_sessions` | Lists all available event sessions from the Planning Service. | `master_uuid` |
| `list_my_sessions` | Lists sessions the user is enrolled in. | `master_uuid` |
| `count_my_invoices` | Gets the total count of invoices for the user. | `master_uuid` |
| `total_invoice_cost` | Gets the total monetary amount and count of user invoices. | `master_uuid` |
| `ask_event_assistant` | General Q&A for the event powered by an LLM. | `question` |

## 📦 Installation & Setup

### 1. Requirements
- Python 3.10+
- RabbitMQ Server
- NVIDIA API Key (for LLM features)

### 2. Setup
```bash
# Clone the repository
git clone <repository-url>
cd Chatbot

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env and add your NVIDIA_API_KEY and RabbitMQ details
```

### 3. Running the Server
The MCP server communicates over standard input/output (stdio).
```bash
python src/chatbot_mcp_server.py
```

## 🧪 Testing

### Basic Tests
Verify the MCP server initialization and LLM integration:
```bash
python test_basic.py
```

### Integration Tests
Verify communication with RabbitMQ and downstream services:
```bash
python test_integration.py
```

## 📄 Documentation

- [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md): Detailed instructions for Planning and Facturatie teams.
- [XML_XSD_CHATBOT_CONTRACTS.md](XML_XSD_CHATBOT_CONTRACTS.md): Formal XML/XSD specifications.
- [DEVELOPER_NOTES.md](DEVELOPER_NOTES.md): Internal implementation details.
