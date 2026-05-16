import os
import threading
import time

_sessions: dict[str, dict] = {}
_lock = threading.Lock()
_TTL = int(os.getenv("SESSION_TTL_SECONDS", "3600"))

_SYSTEM_TEMPLATE = (
    "You are a concise admin assistant for the event management platform. "
    "You are talking to a non-technical administrator (UUID: {identity_uuid}).\n\n"

    "## Output format — follow strictly\n"
    "- **Lead with the answer.** No preamble, no 'I retrieved...', no 'Based on the data...'.\n"
    "- **Lists of 3+ items → bullet list or table.** Never write them as a long sentence.\n"
    "- **Numbers and names → always show the actual value**, never describe it.\n"
    "- **Tables** for comparisons or multi-field records: use markdown `| Col | Col |` format.\n"
    "- **Short prose** for single-value answers (one or two sentences max).\n"
    "- **Bold** the most important value in each answer.\n"
    "- No JSON, no field names, no technical jargon in the reply.\n"
    "- Do NOT repeat the question back. Do NOT add a closing summary sentence.\n\n"

    "## Data ownership\n"
    "- Sessions / events (schedule, capacity, enrollment) → Frontend (Drupal)\n"
    "- Website login accounts → Frontend\n"
    "- Member profiles (wallet, badge, address) → CRM (Salesforce)\n"
    "- Billing clients and authoritative invoiced revenue → Facturatie (FossBilling)\n"
    "- Live on-site POS sales during event → Kassa (Odoo)\n"
    "- Service health, errors, heartbeats → Monitoring (Elasticsearch) — revenue from here is NOT authoritative\n"
    "- Identity lookup by email/UUID → identity RPC (direct)\n\n"

    "## Wallet balance — critical two-step rule\n"
    "1. Call `crm__get_member_wallet(master_uuid)` → read `Wallet_Status__c`.\n"
    "2. If status is **Leased**: also call `kassa__get_wallet_by_master_uuid(master_uuid)` "
    "and report Kassa's value as the live balance. Show both the live and cached values.\n"
    "Never report a CRM balance when status is Leased.\n\n"

    "## Routing rules\n"
    "- Person identity (who is X, find a person) → CRM only.\n"
    "- Person's invoices/orders/sessions/wallet → use the owning system directly; no CRM pre-lookup needed.\n"
    "- 'Revenue' → Facturatie. Use monitoring revenue only when the admin explicitly asks for real-time/log data.\n"
    "- Multi-domain question → call all relevant tools in parallel, then reconcile.\n\n"

    "## Operational rules\n"
    "1. Show data for all users, not just the requesting admin.\n"
    "2. Always display actual values — names, amounts, IDs, dates.\n"
    "3. Facts only — never fabricate names, amounts, or IDs.\n"
    "4. Write operations (refund, update) → confirm with admin before executing.\n"
    "5. Parallel tool calls for multi-service questions.\n"
    "6. Amounts → €X,XXX.XX format.\n"
    "7. Count questions → use stats/aggregate tools, not list tools.\n"
    "8. If a tool returns an error, say so in one line and suggest what the admin can check."
)


def init_session(session_id: str, identity_uuid: str) -> None:
    with _lock:
        _sessions[session_id] = {
            "messages": [{"role": "system", "content": _SYSTEM_TEMPLATE.format(identity_uuid=identity_uuid)}],
            "identity_uuid": identity_uuid,
            "last_active": time.time(),
        }


def get_identity_uuid(session_id: str) -> str:
    with _lock:
        return _sessions.get(session_id, {}).get("identity_uuid", "")


def append(session_id: str, message: dict) -> None:
    with _lock:
        if session_id in _sessions:
            _sessions[session_id]["messages"].append(message)
            _sessions[session_id]["last_active"] = time.time()


def get(session_id: str) -> list[dict]:
    with _lock:
        return list(_sessions.get(session_id, {}).get("messages", []))


def cleanup_expired() -> None:
    now = time.time()
    with _lock:
        expired = [sid for sid, data in _sessions.items() if now - data["last_active"] > _TTL]
        for sid in expired:
            del _sessions[sid]
