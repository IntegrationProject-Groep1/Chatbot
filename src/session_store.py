import json
import os
import re
import threading
import time
from datetime import date as _date

import psycopg2
import psycopg2.pool

_sessions: dict[str, dict] = {}
_lock = threading.Lock()
_TTL = int(os.getenv("SESSION_TTL_SECONDS", "604800"))  # 7 days

_DB_HOST = os.getenv("DB_HOST", "postgredb-service")
_DB_PORT = int(os.getenv("DB_PORT", "5432"))
_DB_USER = os.getenv("DB_USER", "")
_DB_PASS = os.getenv("DB_PASSWORD", "")
_DB_NAME = os.getenv("DB_NAME", "")

# ── Section 1: Domain knowledge ────────────────────────────────────────────────
_SYSTEM_CONTEXT = (
    "You are a helpful admin assistant for the Shift Festival event management platform. "
    "You are talking to an administrator (UUID: {identity_uuid}).\n"
    "Give complete, useful answers. Include numbers, names, and relevant details from the tool results — don't just say 'it worked' or give one-liners. "
    "Format data as a short list or table when there are multiple items. "
    "Respond in the same language the admin uses (Dutch or English). "
    "The current date is injected at the end of this prompt — use it for all relative date questions. Never guess a date.\n\n"

    "## System ownership — one source of truth per concept\n"
    "| What | System | Key identifier |\n"
    "|---|---|---|\n"
    "| Member profiles, identity, wallet, badge | CRM (Salesforce) | master_uuid |\n"
    "| Sessions, schedule, enrollment | Frontend (planning_sessions DB) | session_id |\n"
    "| Invoices, billing, authoritative revenue | Facturatie (FossBilling) | client_id / invoice_id |\n"
    "| Live POS sales, live wallet balance during event | Kassa (Odoo) | order_id |\n"
    "| Service health, logs, heartbeats | Monitoring (Elasticsearch) | service name |\n\n"

    "CRITICAL: Monitoring revenue figures are event counts, NOT financial totals — always use Facturatie for money.\n\n"

    "## Term disambiguation\n"
    "- 'users' / 'members' / 'people' / 'wie is er' → **CRM only** (`crm__search_members`, `crm__list_members`, `crm__get_member_stats`). Frontend has no member listing tools.\n"
    "- 'create user' / 'add user' / 'new user' / 'register user' / 'gebruiker aanmaken' → **NOT POSSIBLE via chatbot**. User accounts are managed in the Drupal admin panel. Explain this and do NOT call any tool.\n"
    "- 'sessions' / 'events' / 'workshops' / 'agenda' → **Frontend** (`frontend__list_sessions`, etc.)\n"
    "- 'activity' / 'history' / 'recent events' / 'wat is er gebeurd' → **CRM** `crm__get_recent_tasks` (human-readable). Only use Monitoring if admin specifically asks for technical/error logs.\n"
    "- 'consumptions' / 'bar orders' / 'verbruik': live during event → Kassa; post-event record → CRM; pending billing → Facturatie.\n"
    "- 'company' / 'bedrijf': billing account → Facturatie; member profiles → CRM (`user_type='Bedrijf'`).\n\n"

    "## Member status — two independent fields\n"
    "- `Status__c`: lifecycle — **Active** (normal) / **Inactive** (deleted) / **Cancelled** (cancelled registration)\n"
    "- `Wallet_Status__c`: lease state — **Idle/Closed** (CRM holds balance) / **Leased** (Kassa holds live balance)\n"
    "'Active members' = Status__c is Active. These fields are independent.\n\n"

    "## Wallet balance — mandatory two-step rule\n"
    "1. Always call `crm__get_member_wallet(master_uuid)` first → check `Wallet_Status__c`.\n"
    "2. If **Leased**: call `kassa__get_wallet_by_master_uuid(master_uuid)` and show Kassa's live value. Show both values.\n"
    "NEVER show the CRM cached balance as current when status is Leased.\n\n"
)

# ── Section 2: Tool routing ─────────────────────────────────────────────────────
_SYSTEM_ROUTING = (
    "## Tool routing\n\n"

    "### CRM — members, wallets, activity\n"
    "Find member by name/partial → `crm__search_members(query=X)`\n"
    "Find member by email → `crm__get_member_by_email(email=X)`\n"
    "Find member by UUID → `crm__get_member(master_uuid=X)`\n"
    "Member count / stats → `crm__get_member_stats` — NOT list tools\n"
    "List members (newest first) → `crm__list_members(limit=N)`\n"
    "Full CRM dashboard → `crm__get_crm_overview`\n"
    "Members by type (Bedrijf / Particulier) → `crm__get_members_by_type(user_type=...)`\n"
    "Members with cancelled payment → `crm__get_members_with_cancelled_payment`\n"
    "Which wallets are leased / active in Kassa → `crm__list_active_leases`\n"
    "Wallet totals overview (cached, not live) → `crm__get_wallet_stats`\n"
    "Recent activity / history / wat is er gebeurd → `crm__get_recent_tasks`\n"
    "Activity filtered by topic → `crm__get_tasks_by_subject(keyword=...)` — keywords: 'Check-in', 'Payment registered', 'Invoice', 'Session', 'Badge', 'Refund'\n"
    "Check-in activity → `crm__get_checkin_tasks`\n"
    "Member consumptions (post-event) → Step 1: `crm__get_member(master_uuid)` to get Salesforce Id → Step 2: `crm__get_member_consumptions(member_sf_id=...)`\n"
    "Consumption aggregate stats → `crm__get_consumption_stats`\n"
    "Update member status → `crm__update_member_status(master_uuid, status)` [WRITE — confirm first] — valid: 'Active', 'Inactive', 'Cancelled', 'Pending'\n"
    "Update member profile (name/email/type/company) → `crm__update_member(master_uuid, ...)` [WRITE — confirm first]\n"
    "Create new CRM member → `crm__create_member(first_name, last_name, email, user_type)` [WRITE — confirm first]\n"
    "Delete (soft) CRM member → `crm__delete_member(master_uuid, reason)` [WRITE — confirm first; sets Status=Cancelled, clears badge]\n"
    "Admin wallet correction in CRM → `crm__update_member_wallet(master_uuid, wallet_balance?, wallet_status?, reason)` [WRITE — confirm first]\n\n"

    "### Facturatie — invoices, billing, revenue\n"
    "Revenue totals / billing overview → `facturatie__get_revenue_summary` — NOT monitoring\n"
    "Full billing dashboard → `facturatie__get_facturatie_overview`\n"
    "Overdue invoices → `facturatie__get_overdue_invoices`\n"
    "Member's invoices → `facturatie__get_invoices_by_email(email=X)`\n"
    "Invoices in date range → `facturatie__get_invoices_by_date_range(start_date, end_date)`\n"
    "Company invoices → Step 1: `facturatie__get_company_billing_account(company_id)` → Step 2: `facturatie__get_client_invoices(client_id)`\n"
    "Company outstanding balance → `facturatie__get_client_balance(client_id)`\n"
    "Company pending + billing combined → `facturatie__get_company_pending_and_billing(company_id)`\n"
    "Companies with pending consumptions → `facturatie__get_companies_with_pending`\n"
    "Pending summary by company → `facturatie__get_pending_summary_by_company`\n"
    "Trace message to invoice → `facturatie__lookup_invoice_by_correlation(correlation_id)`\n"
    "Mark invoice paid → `facturatie__mark_invoice_paid(invoice_id)` [WRITE — confirm first]\n"
    "Create new invoice → `facturatie__create_invoice(client_id, items, due_date)` [WRITE — confirm first; get client_id via get_company_billing_account]\n"
    "Cancel invoice → `facturatie__cancel_invoice(invoice_id, reason)` [WRITE — confirm first; only for unpaid invoices]\n"
    "Delete invoice → `facturatie__delete_invoice(invoice_id, reason)` [WRITE — confirm first; only for cancelled invoices]\n\n"

    "### Frontend — sessions, enrollment, and user accounts\n"
    "Frontend health check (when tools return errors) → `frontend__check_drupal_status`\n"
    "All sessions / filter by status → `frontend__list_sessions(status=...)`\n"
    "Single session by UUID → `frontend__get_session(session_id)` — use when you already have a specific session_id\n"
    "Sessions in date range / this week / this month → `frontend__get_sessions_by_date_range(start_date, end_date)`\n"
    "Sessions today → `frontend__get_sessions_today`\n"
    "Upcoming sessions → `frontend__get_upcoming_sessions`\n"
    "Search sessions by title → `frontend__search_sessions_by_title(title=...)`\n"
    "Sessions by type → Step 1: `frontend__get_all_session_types` (discover valid types) → Step 2: `frontend__get_sessions_by_type(session_type=...)`\n"
    "Sessions by location → Step 1: `frontend__get_all_session_locations` (discover valid locations) → Step 2: `frontend__get_sessions_by_location(location=...)`\n"
    "Full sessions / available spots → `frontend__get_full_sessions` / `frontend__get_sessions_with_available_spots`\n"
    "Capacity overview → `frontend__get_session_capacity_overview`\n"
    "Most popular sessions → `frontend__get_most_popular_sessions`\n"
    "Enrollment overview → `frontend__get_enrollment_overview`\n"
    "Session summary stats → `frontend__get_sessions_summary`\n"
    "Platform totals (users + sessions + fill rate) → `frontend__get_platform_stats`\n"
    "Who is in session X → `frontend__get_session_attendees(session_id)` — returns master_uuid list; look up names in CRM only if admin asks for them\n"
    "Sessions person X is enrolled in → Step 1: `crm__get_member_by_email(email)` to get master_uuid → Step 2: `frontend__get_user_enrolled_sessions(master_uuid)`\n"
    "Which users paid their invoices → Step 1: `facturatie__get_revenue_summary` or `facturatie__get_overdue_invoices` → Step 2: `batch_get_crm_members_by_email(emails=[...])` to resolve all names at once\n"
    "Who attended session X → Step 1: `frontend__get_session_attendees(session_id)` → Step 2: `batch_get_crm_members(master_uuids=[...])` to get all profiles at once\n"
    "Who attended a session AND has unpaid invoices → PARALLEL: `frontend__get_session_attendees(session_id)` + `facturatie__get_overdue_invoices`; then cross-reference\n"
    "Create Drupal user account → `frontend__create_user(name, email, first_name, last_name, role?)` [WRITE — confirm first]\n"
    "Delete Drupal user account → `frontend__delete_user(email, reason)` [WRITE — confirm first; use delete_user for full cascade]\n"
    "Enroll user in session (admin override) → `frontend__enroll_user(master_uuid, session_id, reason)` [WRITE — confirm first; checks capacity]\n"
    "Unenroll user from session (admin) → `frontend__unenroll_user(master_uuid, session_id, reason)` [WRITE — confirm first]\n\n"
    "### Batch tools — use when you have a list of IDs\n"
    "NEVER call `crm__get_member` or `crm__get_member_by_email` in a loop — use the batch tools:\n"
    "`batch_get_crm_members(master_uuids=[uuid1, uuid2, ...])` — resolves up to 20 UUIDs at once\n"
    "`batch_get_crm_members_by_email(emails=[e1, e2, ...])` — resolves up to 20 emails at once\n"
    "Cancel / activate session → `frontend__update_session_status(session_id, status)` [WRITE — confirm first]\n"
    "Change session capacity → `frontend__update_session_capacity(session_id, max_attendees)` [WRITE — confirm first; check current enrollment first]\n"
    "Block / unblock Drupal account → `frontend__set_user_blocked(email, blocked)` [WRITE — confirm first]\n"
    "Create new session → `frontend__create_session(title, start_datetime, end_datetime, location, session_type, max_attendees, price?, description?)` [WRITE — confirm first]\n"
    "Update session fields (title/dates/location/type/price/description) → `frontend__update_session(session_id, ...)` [WRITE — confirm first]\n"
    "Delete session → `frontend__delete_session(session_id, reason)` [WRITE — confirm first; check attendees first]\n\n"

    "### Delete user — FULL CASCADE across all services\n"
    "Delete a user + trigger cascade → Step 1: `crm__get_member_by_email(email)` to get master_uuid → Step 2: `delete_user(master_uuid, reason)` [WRITE — confirm first]\n"
    "IMPORTANT: `delete_user` sends a UserDeleted event to ALL services: CRM soft-deletes, Kassa zeros wallet, Facturatie cancels invoices, Frontend removes enrollments. Always resolve master_uuid first — NEVER guess it.\n\n"

    "### Kassa — POS sales, live wallets\n"
    "POS revenue totals → `kassa__get_sales_summary(date_from, date_to)`\n"
    "POS orders with detail → `kassa__get_recent_orders` or `kassa__get_orders_by_date_range(date_from, date_to)`\n"
    "Member's POS orders → `kassa__get_orders_by_email(email)`\n"
    "Top spenders → `kassa__get_top_spenders(limit=10)`\n"
    "All live wallet balances → `kassa__get_all_wallets`\n"
    "Single live wallet → `kassa__get_wallet_by_master_uuid(master_uuid)`\n"
    "Refund order → `kassa__process_refund(order_id, reason)` [WRITE — confirm first]\n"
    "Top up wallet → `kassa__topup_wallet(master_uuid, amount, reason)` [WRITE — confirm first; only effective when Wallet_Status__c=Leased]\n"
    "Admin set wallet balance (correction) → `kassa__set_wallet_balance(master_uuid, amount, reason)` [WRITE — confirm first]\n"
    "Cancel POS order (draft/new only) → `kassa__cancel_order(order_id, reason)` [WRITE — confirm first; for posted orders use process_refund]\n"
    "Archive Odoo partner → `kassa__delete_partner(master_uuid, reason)` [WRITE — confirm first]\n\n"

    "### Monitoring — health, logs, metrics\n"
    "Platform health check → PARALLEL: `get_mcp_server_status` + `monitoring__get_platform_health_overview`\n"
    "Are MCP servers reachable? → `get_mcp_server_status` ONLY — authoritative for chatbot connectivity\n"
    "Service online/offline → `monitoring__get_service_status` or `monitoring__get_offline_services`\n"
    "Health scores → `monitoring__get_health_scores`\n"
    "Uptime / availability % → `monitoring__get_service_uptime(service)` / `monitoring__get_service_availability(service)`\n"
    "Recent errors → `monitoring__get_error_logs`\n"
    "Most frequent errors → `monitoring__get_top_errors`\n"
    "Search logs → `monitoring__search_logs(query)`\n"
    "Logs for service X → `monitoring__get_logs_by_service(service)`\n"
    "Logs in time window → `monitoring__get_logs_in_timerange(start, end)`\n"
    "Log volume by service → `monitoring__get_log_volume_by_service`\n"
    "Error spikes → `monitoring__get_error_spikes`\n"
    "Latest daily report → `monitoring__get_latest_report`\n"
    "Business event counts → `monitoring__get_business_metrics` (counts only — use Facturatie for money)\n\n"

    "### Parallel vs sequential — MANDATORY RULE\n"
    "**You MUST call all independent tools in a SINGLE response. Never split independent calls across multiple rounds.**\n"
    "PARALLEL examples — return ALL these tool calls at once:\n"
    "- 'Show Kassa and Facturatie revenue' → call `kassa__get_sales_summary` + `facturatie__get_revenue_summary` simultaneously\n"
    "- 'Platform health' → call `get_mcp_server_status` + `monitoring__get_platform_health_overview` simultaneously\n"
    "- 'Member profile + wallet' → call `crm__get_member` + `crm__get_member_wallet` simultaneously\n"
    "- Any question touching 2+ services → call ALL needed tools at once\n"
    "SEQUENTIAL — only when result A is required as input to call B:\n"
    "- Need master_uuid before calling wallet: `crm__get_member_by_email` → then `kassa__get_wallet_by_master_uuid`\n"
    "- Need session_id before getting attendees\n"
    "- Need client_id before getting invoices\n\n"
)

# ── Section 3: Output format & operational rules ────────────────────────────────
# Placed last — freshest instruction before the model responds.
_SYSTEM_OUTPUT = (
    "## Output rules — follow strictly\n\n"

    "**Format:**\n"
    "- Lead with the answer. Never write 'Based on the data...', 'I retrieved...', 'Here is...', or any preamble.\n"
    "- Multiple records (3+) → markdown table. Never use bullet lists when a table fits better.\n"
    "- Single value → one or two sentences max.\n"
    "- Bold the most important value in each answer.\n"
    "- Amounts → €X,XXX.XX format.\n"
    "- Dates → readable format (e.g. 'vrijdag 23 mei' or 'Friday 23 May'), not raw ISO strings.\n"
    "- Skip null / empty / unknown fields — don't show them at all.\n"
    "- No JSON, no raw field names (e.g. never show `Status__c`), no technical jargon.\n"
    "- Do NOT repeat the question. Do NOT add a closing summary sentence.\n\n"

    "**Behaviour:**\n"
    "1. Show data for everyone, not just the requesting admin.\n"
    "2. Never fabricate names, amounts, IDs, or dates — only show what tools returned.\n"
    "3. Count / stats questions → use aggregate tools (`_stats`, `_overview`, `_summary`), not list tools.\n"
    "4. Write operations: the system will block execution and return `status: pending_confirmation`. When this happens: clearly state **what** you want to do and **who/what** it affects (name, ID, amount), then ask the admin to type **'ja'** to confirm or **'nee'** to cancel. When the admin replies 'ja', retry the exact same tool call immediately. Do NOT continue executing other tools in the same turn after a pending_confirmation.\n"
    "4a. Creating users/accounts is **not supported** via this chatbot. If asked to create a user, explain that accounts are managed in the Drupal admin panel and do NOT call any tool.\n"
    "5. If a tool returns an error with 'unavailable', 'not found', '404', or 'Database unavailable': report it in one sentence and stop — do NOT retry or call other tools from the same service.\n"
    "6. Service status questions → always call `get_mcp_server_status` first. Monitoring heartbeats can be stale; socket status is authoritative.\n"
    "7. Don't ask clarifying questions unless the request is genuinely ambiguous about WHICH system to use — make a reasonable call and answer.\n"
    "8. If asked for session attendees, return the list — only look up CRM profiles if the admin explicitly asks for member details.\n"
    "Today's date is {today}.\n"
)

_SYSTEM_TEMPLATE = _SYSTEM_CONTEXT + _SYSTEM_ROUTING + _SYSTEM_OUTPUT

# ── PostgreSQL persistence ───────────────────────────────────────────────────

_pool: psycopg2.pool.ThreadedConnectionPool | None = None
_pool_lock = threading.Lock()
_pool_next_retry: float = 0.0
_RETRY_COOLDOWN = 60.0


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool | None:
    global _pool, _pool_next_retry
    if _pool is not None:
        return _pool
    if not _DB_USER:
        return None
    if time.time() < _pool_next_retry:
        return None
    with _pool_lock:
        if _pool is not None:
            return _pool
        if time.time() < _pool_next_retry:
            return None
        try:
            p = psycopg2.pool.ThreadedConnectionPool(
                1, 5,
                host=_DB_HOST, port=_DB_PORT,
                user=_DB_USER, password=_DB_PASS, dbname=_DB_NAME,
            )
            conn = p.getconn()
            try:
                with conn.cursor() as cur:
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS chatbot_sessions (
                            session_id    TEXT PRIMARY KEY,
                            identity_uuid TEXT NOT NULL,
                            messages      TEXT NOT NULL,
                            pending_write TEXT,
                            last_active   DOUBLE PRECISION NOT NULL
                        )
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS chatbot_conversations (
                            session_id    TEXT PRIMARY KEY,
                            identity_uuid TEXT NOT NULL,
                            label         TEXT NOT NULL,
                            created_at    DOUBLE PRECISION NOT NULL,
                            last_active   DOUBLE PRECISION NOT NULL,
                            pinned        BOOLEAN NOT NULL DEFAULT FALSE
                        )
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_conv_identity
                        ON chatbot_conversations (identity_uuid, last_active DESC)
                    """)
                conn.commit()
            finally:
                p.putconn(conn)
            _pool = p
        except Exception as e:
            _pool_next_retry = time.time() + _RETRY_COOLDOWN
            import logging as _lg
            _lg.getLogger(__name__).error(
                "session_store: PostgreSQL unavailable, retrying in %ds: %s", int(_RETRY_COOLDOWN), e
            )
    return _pool


def _persist(session_id: str, identity_uuid: str, messages: list, last_active: float, pending_write: dict | None = None) -> None:
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO chatbot_sessions (session_id, identity_uuid, messages, pending_write, last_active)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (session_id) DO UPDATE SET
                        identity_uuid = EXCLUDED.identity_uuid,
                        messages      = EXCLUDED.messages,
                        pending_write = EXCLUDED.pending_write,
                        last_active   = EXCLUDED.last_active
                """, (session_id, identity_uuid, json.dumps(messages), 
                      json.dumps(pending_write) if pending_write else None, last_active))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception:
        pass


def _load_from_db(session_id: str) -> dict | None:
    """Load a session directly from the database."""
    pool = _get_pool()
    if pool is None:
        return None
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT identity_uuid, messages, last_active, pending_write FROM chatbot_sessions WHERE session_id = %s AND last_active > %s",
                    (session_id, time.time() - _TTL),
                )
                row = cur.fetchone()
                if row:
                    return {
                        "identity_uuid": row[0],
                        "messages": json.loads(row[1]),
                        "last_active": row[2],
                        "pending_write": json.loads(row[3]) if row[3] else None,
                    }
        finally:
            pool.putconn(conn)
    except Exception:
        pass
    return None

# ── Public API ──────────────────────────────────────────────────────────────


def _refresh_date(messages: list) -> None:
    """Update the date in the system message to today (called on every WS connect)."""
    today = _date.today().isoformat()
    for m in messages:
        if m.get("role") == "system":
            m["content"] = re.sub(
                r"Today's date is \d{4}-\d{2}-\d{2}\.",
                f"Today's date is {today}.",
                m["content"],
            )
            break


def init_session(session_id: str, identity_uuid: str) -> None:
    # Always try to load from DB or create new — no global memory dict
    session = _load_from_db(session_id)
    if session:
        msgs = session["messages"]
        _refresh_date(msgs)
        _persist(session_id, identity_uuid, msgs, time.time(), session.get("pending_write"))
        return

    # Brand new session
    messages = [{"role": "system", "content": _SYSTEM_TEMPLATE.format(
        identity_uuid=identity_uuid,
        today=_date.today().isoformat(),
    )}]
    _persist(session_id, identity_uuid, messages, time.time())


def get_identity_uuid(session_id: str) -> str:
    session = _load_from_db(session_id)
    return session.get("identity_uuid", "") if session else ""


def append(session_id: str, message: dict) -> None:
    session = _load_from_db(session_id)
    if not session:
        return
    msgs = session["messages"]
    msgs.append(message)
    _persist(session_id, session["identity_uuid"], msgs, time.time(), session.get("pending_write"))


def get(session_id: str) -> list[dict]:
    session = _load_from_db(session_id)
    return list(session.get("messages", [])) if session else []


def set_pending_write(session_id: str, tool_call: dict | None) -> None:
    """Persist a tool call blocked by the write-gate."""
    session = _load_from_db(session_id)
    if not session:
        return
    _persist(session_id, session["identity_uuid"], session["messages"], time.time(), tool_call)


def get_pending_write(session_id: str) -> dict | None:
    """Retrieve the pending tool call for a session."""
    session = _load_from_db(session_id)
    return session.get("pending_write") if session else None


def get_messages_for_api(session_id: str) -> list[dict]:
    """Return user/assistant/tool messages for restoring the chat UI."""
    msgs = get(session_id)
    result = []
    for m in msgs:
        role = m.get("role")
        if role not in ("user", "assistant", "tool"):
            continue
        
        # User/Assistant/Tool content
        content = m.get("content", "")
        if isinstance(content, list):
            text = " ".join(
                block.get("text", "") for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        else:
            text = str(content) if content is not None else ""
        
        entry = {"role": role, "text": text.strip()}
        
        # Include tool_calls for assistant messages
        if role == "assistant" and "tool_calls" in m:
            entry["tool_calls"] = m["tool_calls"]
            
        # Include tool details for tool messages
        if role == "tool":
            entry["tool_call_id"] = m.get("tool_call_id")
            entry["name"] = m.get("name")
            
        result.append(entry)
    return result


def cleanup_expired() -> None:
    now = time.time()
    with _lock:
        expired = [sid for sid, data in _sessions.items() if now - data["last_active"] > _TTL]
        for sid in expired:
            del _sessions[sid]
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM chatbot_sessions WHERE last_active < %s", (now - _TTL,))
                cur.execute("DELETE FROM chatbot_conversations WHERE last_active < %s AND pinned = FALSE", (now - _TTL,))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception:
        pass


# ── Conversation metadata (per-admin, cross-device) ─────────────────────────

def upsert_conversation(session_id: str, identity_uuid: str, label: str) -> None:
    pool = _get_pool()
    if pool is None:
        return
    now = time.time()
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO chatbot_conversations
                        (session_id, identity_uuid, label, created_at, last_active, pinned)
                    VALUES (%s, %s, %s, %s, %s, FALSE)
                    ON CONFLICT (session_id) DO UPDATE SET
                        label       = EXCLUDED.label,
                        last_active = EXCLUDED.last_active
                """, (session_id, identity_uuid, label, now, now))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception:
        pass


def get_conversations(identity_uuid: str) -> list[dict]:
    pool = _get_pool()
    if pool is None:
        return []
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT session_id, label, created_at, last_active, pinned
                    FROM chatbot_conversations
                    WHERE identity_uuid = %s
                    ORDER BY pinned DESC, last_active DESC
                    LIMIT 50
                """, (identity_uuid,))
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            pool.putconn(conn)
    except Exception:
        return []


def set_pinned(session_id: str, identity_uuid: str, pinned: bool) -> bool:
    pool = _get_pool()
    if pool is None:
        return False
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE chatbot_conversations
                    SET pinned = %s
                    WHERE session_id = %s AND identity_uuid = %s
                """, (pinned, session_id, identity_uuid))
                updated = cur.rowcount > 0
            conn.commit()
            return updated
        finally:
            pool.putconn(conn)
    except Exception:
        return False


def delete_conversation(session_id: str, identity_uuid: str) -> bool:
    pool = _get_pool()
    if pool is None:
        return False
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM chatbot_conversations WHERE session_id = %s AND identity_uuid = %s",
                    (session_id, identity_uuid),
                )
                deleted = cur.rowcount > 0
                if deleted:
                    cur.execute("DELETE FROM chatbot_sessions WHERE session_id = %s", (session_id,))
            conn.commit()
            with _lock:
                _sessions.pop(session_id, None)
            return deleted
        finally:
            pool.putconn(conn)
    except Exception:
        return False
