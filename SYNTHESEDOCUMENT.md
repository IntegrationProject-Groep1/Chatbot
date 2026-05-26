# Synthesedocument — Chatbot Team

## 1. Overzicht team

| Naam | GitHub | E-mail | Rol |
|------|--------|--------|-----|
| Tom Dekoning | [tombomeke-ehb](https://github.com/tombomeke-ehb) | tom1dekoning@gmail.com | Team Lead / Developer |
| Jeremy Luyckfasseel | [JeremyLuyckfasseel](https://github.com/JeremyLuyckfasseel) | jeremy.luyckfasseel@student.ehb.be | Team Lead / Developer |

Beide teamleden hebben als Team Lead gefungeerd en hebben samen de volledige ontwikkeling van de chatbot op zich genomen — van architectuurkeuzes en integraties tot admin UI en CI/CD.

---

## 2. Opgeleverde features

### Core agent

- **MCP client** (`src/mcp_client.py`) — verbindt bij opstart met alle externe MCP servers (frontend, monitoring, facturatie, kassa, crm), ontdekt automatisch hun tools en namespace-t ze per label (`frontend__get_session`, `crm__get_member`, ...).
- **A2A orchestrator + sub-agents** (`src/agent.py` + `src/sub_agents.py`) — de orchestrator ziet ~14 tools en delegeert leesvragen naar één van vijf specialist sub-agents (`ask_frontend`, `ask_crm`, `ask_kassa`, `ask_facturatie`, `ask_monitoring`). Elke sub-agent heeft alleen de tools van zijn eigen MCP server (10–30 tools) en loopt een eigen tool-use loop van max. 5 ronden. Meerdere sub-agents kunnen parallel worden opgeroepen in één orchestrator-ronde.
- **Llama tool-use loop** — real-time SSE streaming van tokens naar de browser, parallelle tool dispatch, deduplicatiefilter op identieke tool calls, inline JSON fallback parser voor modellen die tool calls in `content` plaatsen, exponential backoff op NVIDIA 429/5xx.
- **Write-tool gate** — alle schrijfoperaties (`create_*`, `delete_*`, `update_*`, `admin_*`, `grant_*`, `return_*`) worden onderschept; de admin moet expliciet `ja` typen vóór uitvoering. Pending write wordt opgeslagen in PostgreSQL zodat een pagina-refresh het niet kwijt is. Blokkade op nee: actie wordt volledig afgebroken en niet opnieuw voorgesteld.
- **Europe/Brussels timezone** — datum en tijd worden bij elke LLM-aanroep live geïnjecteerd; de agent weet altijd de actuele dag/maand/week.

### Admin tools (lokale orchestrator-tools)

| Tool | Wat het doet |
|------|-------------|
| `create_user` | Maakt gebruiker aan in Identity → CRM → Drupal; Kassa en Facturatie worden automatisch via RabbitMQ UserCreated event genotificeerd |
| `delete_user` | Cascadegewijs verwijderen uit alle services; blokt als het admin's eigen account is |
| `admin_set_wallet_balance` | Zet wallet-saldo in Kassa én broadcast het via `kassa.exchange` naar Frontend en CRM |
| `grant_wallet_lease` | Geeft handmatig walletverlof aan Kassa; pre-flight check op dubbele lease |
| `return_wallet_lease` | Geeft walletverlof terug van Kassa naar CRM met eindbalans |
| `batch_get_crm_members` | Parallel max. 20 CRM-profielen ophalen op UUID |
| `batch_get_crm_members_by_email` | Parallel max. 20 CRM-profielen ophalen op e-mail |
| `get_mcp_server_status` | Live verbindingsstatus per MCP server |
| `get_current_date` | Huidige datum/tijd in Brussels-timezone |

### Identity & RabbitMQ

- **Identity lookup via RabbitMQ RPC** — UUID opzoeken op e-mail en omgekeerd (e-mail op UUID), via `correlation_id`-patroon met thread-local persistente verbindingen (`src/rabbitmq_rpc.py`).
- **Audit events** — elke schrijfoperatie publiceert een audit event naar RabbitMQ (`user.created`, `wallet.lease_granted`, `tool_called.*`, ...).
- **XML v2.0 berichtstandaard** — alle inter-service berichten volgen een XML-envelope (header + body). Builders in `src/xml_builders.py`, parsers in `src/xml_parsers.py`, XSD-contracten in `xsd/`.

### Admin console UI (React, standalone SPA)

- **Admin authenticatie** — HMAC-gesigneerde 8-uur sessiecookies (`src/auth.py`), `ADMIN_CREDENTIALS` env var, automatische re-login bij verlopen sessie, logout-knop in topbar.
- **PostgreSQL-persistentie** — sessies, gespreksgeschiedenis, per-admin pin/unpin en actieve gesprek tracking (`src/session_store.py`) opgeslagen in een gedeelde PostgreSQL.
- **Conversatiegeschiedeniszijbalk** — gesprekken laden, aanmaken, verwijderen, pinnnen, automatisch herstellen na page-refresh inclusief actief gesprek.
- **Live log monitoring** — live polling van Elasticsearch via Monitoring MCP (laatste 15 min), automatische refresh elke 10 seconden, SQLite write-through cache (`src/log_store.py`), fallback naar cache bij MCP-uitval met "gecached" badge.
- **Tijdfilterknopppen** — Live / 15 min (MCP + DB), 1 uur / 4 uur / 7 uur (DB only); cache-wis knop persisteert `cleared_at` in DB zodat herstelde MCP-data geen gewiste entries terugtoont.
- **Berichtenflow visualizer** — interactieve grafiek van de A2A-architectuurlagen met draggable nodes, animated dots op edges, klik-op-node/edge voor detailpanel, live feed met inter-service berichten.
- **MCP tool sidebar** — toont alle tools van verbonden MCP servers met naam, beschrijving en volledige `inputSchema`. Detail-modal toont parameter-tabel (type, vereist, enum).
- **Service overview dashboard** — combineert hardcoded metadata (host, poort, afhankelijkheden) met live heartbeat-data: beschikbaarheidspercentage, health score, error density.
- **Slash-commando's** — sneltoetsen in de chatinterface.
- **Tech-themed custom cursor** in de Berichtenflow.

### Widget

- **Floating chat-widget** (`static/widget.js` + `static/widget.css`) — embedbaar in Drupal via twee regels HTML; de pagina injecteert automatisch de `identity_uuid` van de ingelogde gebruiker. Widget verschijnt niet als de gebruiker niet ingelogd is.

### Infrastructuur

- **MCP auto-reconnect** — achtergrondloop die periodiek herverbindt met uitgevallen MCP servers.
- **Rotating file logger** — gestructureerde logging naar bestand (`src/logging_config.py`).
- **CI/CD pipeline** — GitHub Actions op push/PR naar `main`, Python 3.10, RabbitMQ service, `python -m unittest discover tests`.
- **Docker** — `Dockerfile` + `docker-compose.yml` voor lokale omgeving met RabbitMQ en mock-services.
- **Mock-services** (`src/mock_services.py`) — simuleert alle downstream MCP-diensten voor lokale ontwikkeling.

---

## 3. Niet-afgeraakte features

| Feature | Reden |
|---------|-------|
| **UI cards in A2A-modus** | `_extract_cards()` in `agent.py` zoekt op JSON-keys zoals `"sessions"` en `"invoices"`, maar sub-agents geven natural language terug gewrapped in `{"result": "...", "service": "..."}`. Cards verschijnen dus niet meer. Oplossing (sub-agents gestructureerde `data`-key laten meegeven) was gepland maar niet meer geïmplementeerd wegens tijdgebrek. |
| **Sub-agent token streaming** | Sub-agents consumeren de SSE-stroom intern maar sturen tokens niet door naar de WebSocket client. De gebruiker ziet pas tekst als de volledige sub-agent chain klaar is. De infrastructuur staat er (emit wordt doorgegeven), de doorstuur-logica is niet uitgewerkt. |
| **Tests updaten voor A2A** | `tests/`, `test_basic.py` en `test_integration.py` zijn geschreven voor de pre-A2A architectuur. Ze mocken `sub_agents.run_sub_agent()` niet en testen de orchestrator-toollijst (14 tools) niet. Niet meer bijgehouden wegens tijdgebrek in de laatste sprint. |
| **Niet alle CRUD-tools werken perfect** | De CRUD-operaties zijn geïmplementeerd (create/delete user, wallet tools) maar niet alle tools zijn volledig uitgetest en fine-tuned. Randgevallen en foutafhandeling bij bepaalde tools zijn nog niet volledig robuust. Meer tijd was nodig voor grondige integratie-tests met de echte backends. |

---

## 4. Relevante repositories en documentatie

### GitHub repository

| Repository | URL |
|------------|-----|
| **Chatbot** | [github.com/IntegrationProject-Groep1/Chatbot](https://github.com/IntegrationProject-Groep1/Chatbot) |

### Documentatie in de repository

| Bestand | Inhoud |
|---------|--------|
| `CLAUDE.md` | Volledige architectuurbeschrijving, modules, env-variabelen, log-queryflow |
| `README.md` | Quickstart, feature-overzicht, v2-architectuur uitleg |
| `XML_XSD_CHATBOT_CONTRACTS.md` | Formele XML/XSD-specificaties voor inter-service berichten |
| `docs/admin-console-logs.md` | Gedetailleerde documentatie van het log-querysysteem |
| `docs/facturatie-mcp-guide.md` | Integratiegids voor het Facturatie-team |
| `docs/kassa-mcp-guide.md` | Integratiegids voor het Kassa-team |
| `docs/crm-mcp-guide.md` | Integratiegids voor het CRM-team |
| `PROJECT_MASTER_GUIDE.md` | Geconsolideerde projectstatus en integratiegids |
| `TESTING_GUIDE.md` | Testinstructies |
| `task.md` | A2A implementatie tracker met bekende limitaties |
| `xsd/` | XSD-schemabestanden voor XML-contractvalidatie |

### Planning

Er is geen apart Kanban/Scrum-board of ClickUp-workspace gebruikt. Taakopvolging verliep via GitHub Issues & Pull Requests op de Chatbot-repository en via `task.md` als in-repo taaktracker voor de A2A-sprint.

---

## 5. Aanmeldgegevens

> Vul de ontbrekende velden aan of vervang met een link naar de interne Confluence-pagina.

| Systeem | URL | Gebruikersnaam | Wachtwoord / Toegang |
|---------|-----|----------------|----------------------|
| Chatbot admin console | `http://<host>:8000` | _(in te vullen)_ | _(in te vullen via `ADMIN_CREDENTIALS` env var)_ |
| NVIDIA API (LLM) | https://integrate.api.nvidia.com/ | — | `NVIDIA_API_KEY` in `.env` |
| RabbitMQ management | `http://<host>:15672` | `guest` | `guest` _(dev default)_ |
| PostgreSQL | `<host>:5432` | `DB_USER` in `.env` | `DB_PASSWORD` in `.env` |
| GitHub repository | https://github.com/IntegrationProject-Groep1/Chatbot | _(GitHub account)_ | _(repository access)_ |
| _(overige systemen)_ | _(in te vullen)_ | _(in te vullen)_ | _(in te vullen)_ |

---

*Opgesteld door Tom Dekoning & Jeremy Luyckfasseel — Chatbot Team, IntegrationProject Groep 1.*
