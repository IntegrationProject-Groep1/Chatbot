# Chatbot MCP Server

![CI Status](https://img.shields.io/badge/CI-Passing-brightgreen?style=for-the-badge)
![Tests](https://img.shields.io/badge/Tests-3_Passing-brightgreen?style=for-the-badge)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue?style=for-the-badge&logo=python)
![Architecture](https://img.shields.io/badge/Architecture-Decentralized_AI-blue?style=for-the-badge)



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

---

## 🤖 v2 — Multi-Agent Architectuur

De `v2/` map bevat een volledig herschreven versie van de chatbot. Dit is de versie die live gaat. Lees dit gedeelte zorgvuldig door.

### Waarom een v2?

De originele chatbot was een passieve server: de AI (Llama) werd alleen gebruikt voor vrije tekstvragen. De AI besliste zelf **niet** welke diensten aangesproken moesten worden — dat deed externe tooling. Bovendien was er geen conversatiegeheugen, geen webinterface, en waren de queue-namen incorrect ten opzichte van het echte contract.

De v2 lost al dit op.

---

### Hoe de v2 werkt

#### 1. Widget in de Drupal frontend

De chatbot is geen aparte pagina. Het is een **floating widget** rechtsonder op elke pagina van de Drupal frontend — een paars bolletje dat opent in een popup-venster.

Het Drupal-thema injecteert automatisch de `identity_uuid` van de ingelogde gebruiker:

```html
<script>
  window.CHATBOT_USER_UUID = "{{ user.field_identity_uuid.value|e('js') }}";
  window.CHATBOT_HOST = "chatbot:8000";
</script>
<link rel="stylesheet" href="http://chatbot:8000/static/widget.css">
<script src="http://chatbot:8000/static/widget.js"></script>
```

De gebruiker hoeft nooit te zeggen wie hij is. Als `CHATBOT_USER_UUID` leeg is (niet ingelogd), verschijnt de widget niet.

#### 2. WebSocket verbinding

Wanneer de popup opent, maakt de browser een WebSocket-verbinding met de chatbot-server. Het eerste bericht identificeert de gebruiker:

```json
{ "type": "identify", "identity_uuid": "abc-123-..." }
```

Vanaf dat moment onthoudt de server wie de gebruiker is voor de rest van het gesprek.

#### 3. Llama als de echte AI

De gebruiker stelt een vraag. Die gaat via WebSocket naar de FastAPI-server, die de **Llama AI** aanroept (NVIDIA API). Llama krijgt de volledige gespreksgeschiedenis + een beschrijving van twee tools:

| Tool | Wanneer |
|------|---------|
| `ask_planning(query, scope)` | Vragen over sessies of inschrijvingen |
| `ask_facturatie(query)` | Vragen over facturen of bedragen |

Llama beslist zelf welke tool(s) nodig zijn, met welke `scope`, en formuleert de vraag in natuurlijke taal. De Python-code voert de tool uit — Llama ziet nooit rechtstreeks de XML.

#### 4. Multi-agent: elke dienst heeft zijn eigen AI

Dit is het kernidee van de v2. De chatbot stuurt **geen hardcoded XML-berichttypen** meer (zoals `session_view_request`). In plaats daarvan stuurt hij een generieke `ai_query` met een vraag in natuurlijke taal:

```xml
<message>
  <header>
    <source>chatbot</source>
    <type>ai_query</type>
    <version>2.0</version>
    <correlation_id>uuid-hier</correlation_id>
  </header>
  <body>
    <identity_uuid>abc-123</identity_uuid>
    <scope>personal</scope>
    <query>In welke sessies is deze gebruiker ingeschreven?</query>
  </body>
</message>
```

**Elk team implementeert een AI-listener** die op hun eigen queue luistert, de vraag begrijpt, hun database raadpleegt, en antwoordt:

```xml
<message>
  <header>
    <source>planning</source>
    <type>ai_response</type>
    <correlation_id>uuid-hier</correlation_id>
    <version>2.0</version>
  </header>
  <body>
    <status>ok</status>
    <response>De gebruiker is ingeschreven voor 2 sessies: Docker Workshop en API Design.</response>
    <data>
      <session>
        <session_id>sess-001</session_id>
        <name>Docker Workshop</name>
        <date>2026-05-20T09:00:00Z</date>
        <location>Zaal A</location>
      </session>
    </data>
  </body>
</message>
```

De chatbot verwerkt het antwoord en geeft het terug aan de gebruiker — inclusief visuele kaartjes voor sessies en facturen.

#### 5. Scope: publiek vs. persoonlijk

Elke `ai_query` bevat een `scope`-veld:

| Scope | Betekenis | Voorbeeld |
|-------|-----------|-----------|
| `public` | Data beschikbaar voor iedereen | Alle beschikbare sessies |
| `personal` | Alleen data van deze gebruiker | Ingeschreven sessies, facturen |

De team-AI gebruikt de `identity_uuid` **alleen** als filter wanneer `scope = personal`. Bij `public` wordt er geen UUID-filter toegepast.

> **Belangrijk voor elke team-AI:** gebruik een read-only databasegebruiker. De AI mag enkel lezen, nooit schrijven.

---

### Bestandsstructuur v2

```
v2/
├── src/
│   ├── agent.py           # Llama tool-use loop — het brein
│   ├── api.py             # FastAPI + WebSocket server
│   ├── session_store.py   # Conversatiegeheugen per sessie
│   ├── rabbitmq_rpc.py    # Persistente RabbitMQ-verbinding per thread
│   ├── xml_builders.py    # Bouwt ai_query XML-berichten
│   ├── xml_parsers.py     # Parseert ai_response XML-berichten
│   ├── downstream_tools.py # Stuurt queries naar Planning en Facturatie
│   └── mock_services.py   # Simuleert de team-AI's voor lokaal testen
├── static/
│   ├── widget.js          # De floating chat-widget (embed in Drupal)
│   ├── widget.css         # Widget styling
│   └── test.html          # Testpagina zonder Drupal
├── main.py                # Uvicorn entry point
├── requirements.txt
├── Dockerfile
└── docker-compose.yml
```

### Lokaal starten

```bash
cd v2
pip install -r requirements.txt

# Kopieer .env.example naar .env en vul NVIDIA_API_KEY in
cp .env.example .env

# Terminal 1 — RabbitMQ
docker run -p 5672:5672 rabbitmq:3-management-alpine

# Terminal 2 — Mock team-AI's (simuleert Planning + Facturatie)
python src/mock_services.py

# Terminal 3 — Chatbot server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Open http://localhost:8000 → vul een UUID in → klik "Load Widget"
```

### Wat andere teams moeten implementeren

Elk team voegt een **AI-listener** toe aan hun bestaande service. Die listener:

1. Luistert op hun eigen RabbitMQ queue
2. Parseert het `ai_query` XML-bericht (leest `identity_uuid`, `scope`, `query`)
3. Raadpleegt de eigen database (read-only, gefilterd op `identity_uuid` als `scope = personal`)
4. Roept de NVIDIA Llama API aan om een antwoord te formuleren
5. Stuurt een `ai_response` XML-bericht terug via `reply_to`

De queues:

| Team | Queue |
|------|-------|
| Planning | `planning.exchange` |
| Facturatie | `facturatie.rpc` |
| Identity | `identity.user.lookup.email.request` (ongewijzigd, bare XML) |
