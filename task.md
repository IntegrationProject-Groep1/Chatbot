# A2A Architecture — Task Tracker

## Doel
De chatbot was te traag en te dom omdat hij 80-100 tools in één context laadde.
Oplossing: Agent-to-Agent (A2A) architectuur waarbij de orchestrator delegeert aan
per-MCP specialist sub-agents die elk slechts 10-20 tools zien.

---

## Status overzicht

| Taak | Status |
|---|---|
| `src/sub_agents.py` aanmaken | ✅ Done |
| `_SUB_AGENT_TOOL_DEFS` toevoegen aan `agent.py` | ✅ Done |
| Orchestrator stuurt sub-agent tools i.p.v. MCP tools | ✅ Done |
| `ask_*` dispatch in `_handle_local_tool` | ✅ Done |
| `_build_suggestions` update voor `ask_*` namen | ✅ Done |
| System prompt vereenvoudigd (orchestrator-gericht) | ✅ Done |
| Flow graph (admin-data.js + admin-flow.jsx) bijgewerkt | ✅ Done |
| Testen in dev omgeving | ⬜ TODO |
| UI cards aanpassen voor sub-agent responses | ⬜ TODO |
| Streaming doorvoer (sub-agent tokens live streamen) | ⬜ TODO (optioneel) |

---

## Architectuur (na implementatie)

```
Admin (WebSocket)
  → Orchestrator (agent.py) — ~14 tools zichtbaar
      Lokale tools: get_current_date, get_mcp_server_status,
                    batch_get_crm_members, batch_get_crm_members_by_email,
                    create_user, delete_user, admin_set_wallet_balance,
                    grant_wallet_lease, return_wallet_lease
      Sub-agent tools: ask_frontend, ask_crm, ask_kassa,
                       ask_facturatie, ask_monitoring
      ↓
      ask_frontend("...") → Frontend Sub-agent (src/sub_agents.py)
        → alleen frontend__ tools (~30 tools)
        → eigen system prompt, eigen tool-use loop (max 5 ronden)
        → geeft natural language antwoord terug aan orchestrator
      ↓
      ask_crm("...") → CRM Sub-agent
        → alleen crm__ tools (~15-20 tools)
      ↓
      ask_kassa("...") → Kassa Sub-agent
        → alleen kassa__ tools (~10-15 tools)
      ↓
      ask_facturatie("...") → Facturatie Sub-agent
        → alleen facturatie__ tools (~10-15 tools)
      ↓
      ask_monitoring("...") → Monitoring Sub-agent
        → alleen monitoring__ tools (~5-10 tools)
```

**Resultaat:** orchestrator ziet 14 tools i.p.v. 80-100. Elke sub-agent ziet 10-30 tools.

---

## Bekende limitaties / TODO's

### 1. UI Cards werken niet meer (⬜ TODO - prioriteit: medium)
**Probleem:** `_extract_cards()` in `agent.py` parsed tool-resultaten op JSON-keys zoals
`"sessions"`, `"invoices"`, `"members"`. Sub-agents geven natural language terug
wrapped in `{"result": "...", "service": "frontend"}`, dus card extractie vindt niets.

**Oplossing optie A (snel):** Sub-agents kunnen gestructureerde JSON teruggeven naast
hun tekst antwoord, bijv. `{"result": "tekst...", "data": {"sessions": [...]}}`.
De orchestrator logt dit maar toont de tekst. Cards worden geparsed uit `data`.

**Oplossing optie B (clean):** Aparte "data cards" endpoint waarbij de orchestrator
na ontvangst van sub-agent resultaat de UI-cards zelf genereert via een aparte
structured output call.

### 2. Streaming (⬜ TODO - prioriteit: laag)
Sub-agents roepen de LLM non-streaming aan. De eindgebruiker ziet pas tekst als de
héle sub-agent chain klaar is. Verbetering: sub-agents kunnen tokens streamen naar
de orchestrator die ze doorstuurt via `emit`.

### 3. Cross-agent context doorgeven (⬜ TODO - als nodig)
Voor de enrollment flow: orchestrator roept `ask_frontend` aan die attendee
master_uuids teruggeeft in de natural language response. De orchestrator parseert
die UUIDs en roept daarna `batch_get_crm_members` aan.
- Dit werkt omdat llama-3.3-70b UUIDs kan extracten uit tekst
- Als dit onbetrouwbaar blijkt: sub-agents uitbreiden zodat ze optioneel
  gestructureerde `extra_data` teruggeven naast hun tekstantwoord

### 4. Tests updaten (⬜ TODO - voor merge naar prod)
`tests/` en `test_basic.py` / `test_integration.py` moeten geüpdatet worden:
- `sub_agents.run_sub_agent()` mocken
- Orchestrator tool-list verificatie (14 tools, niet 80+)
- Integratie: volledige ask_crm → batch_get_crm_members flow

---

## Bestanden gewijzigd

| Bestand | Wijziging |
|---|---|
| `src/sub_agents.py` | **Nieuw** — stateless sub-agent runner per MCP label |
| `src/agent.py` | `_SUB_AGENT_TOOL_DEFS` toegevoegd, `_call_llama` gebruikt sub-agent tools, `_handle_local_tool` dispatcht `ask_*`, `_build_suggestions` herkent `ask_*` namen |
| `src/session_store.py` | System prompt herschreven: ~1700 → ~400 tokens, orchestrator-gericht |
| `task.md` | Dit bestand |

---

## Hoe verder gaan (volgende sessie)

1. Start de chatbot lokaal en test een paar vragen handmatig
2. Check of sub-agent dispatch correct logt (`Sub-agent [frontend] calling tool: ...`)
3. Fix UI cards (zie Limitatie 1) als cards belangrijk zijn voor de demo
4. Update de tests
5. Maak een PR naar `dev`

```bash
# Lokaal testen
docker run -p 5672:5672 rabbitmq:3-management-alpine
python src/mock_services.py
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Check de logs: je moet nu logs zien zoals:
```
INFO  Dispatching to sub-agent [crm]: query='...'
INFO  Sub-agent [crm] calling tool: crm__get_member_by_email args=...
```
