import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class IdentityUser:
    identity_uuid: str
    email: str


@dataclass
class Session:
    session_id: str
    name: str
    date: str
    location: str
    description: Optional[str] = None


@dataclass
class Invoice:
    invoice_id: str
    amount: str
    date: str
    status: str
    description: Optional[str] = None


@dataclass
class InvoiceTotal:
    total_amount: str
    currency: str
    count: int


@dataclass
class AIResponse:
    """Response from a downstream team AI."""
    response: str                        # natural language answer from the team AI
    sessions: list[Session] = field(default_factory=list)
    invoices: list[Invoice] = field(default_factory=list)
    total: Optional[InvoiceTotal] = None


def _get_body(xml_text: str) -> ET.Element:
    """Extract <body> from <message> wrapper, or return root if no wrapper."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise RuntimeError(f"Invalid XML: {exc}")

    if root.tag == "message":
        body = root.find("body")
        if body is None:
            raise RuntimeError("Message received without <body> element")
        return body
    return root


def _text(el: ET.Element, *tags: str) -> str:
    """Try multiple tag names, return first match stripped, or empty string."""
    for tag in tags:
        val = el.findtext(tag)
        if val is not None:
            return val.strip()
    return ""


def _parse_sessions_from(parent: ET.Element) -> list[Session]:
    sessions = []
    # Support both <session> directly and <sessions><session>
    els = parent.findall("session") or parent.findall("sessions/session")
    for el in els:
        session_id = _text(el, "session_id")
        name = _text(el, "name", "title")
        date = _text(el, "date", "start_time")
        location = _text(el, "location")
        description = _text(el, "description") or None
        if session_id and name:
            sessions.append(Session(session_id, name, date, location, description))
    return sessions


def _parse_invoices_from(parent: ET.Element) -> list[Invoice]:
    invoices = []
    els = parent.findall("invoice") or parent.findall("invoices/invoice")
    for el in els:
        invoice_id = _text(el, "invoice_id")
        amount_el = el.find("amount")
        amount = (amount_el.text or "0").strip() if amount_el is not None else _text(el, "amount")
        date = _text(el, "date")
        status = _text(el, "status") or "unknown"
        description = _text(el, "description") or None
        if invoice_id:
            invoices.append(Invoice(invoice_id, amount, date, status, description))
    return invoices


def _parse_total_from(parent: ET.Element) -> Optional[InvoiceTotal]:
    amount_el = parent.find("total_amount")
    if amount_el is not None:
        total_amount = (amount_el.text or "0").strip()
        currency = (amount_el.get("currency") or _text(parent, "currency") or "EUR").upper()
    else:
        total_amount = _text(parent, "total_amount")
        currency = (_text(parent, "currency") or "EUR").upper()

    if not total_amount:
        return None

    count_str = _text(parent, "invoice_count", "count") or "0"
    try:
        count = int(count_str)
    except ValueError:
        count = 0
    return InvoiceTotal(total_amount, currency, count)


# --- Identity parser (unchanged — bare XML, no envelope) ---

def parse_identity_response(xml_text: str) -> IdentityUser:
    body = _get_body(xml_text)
    status = _text(body, "status").lower()

    if status not in ("ok", "success", ""):
        code = _text(body, "error_code") or "UNKNOWN"
        msg = _text(body, "error_description", "error_message", "message") or "Identity error"
        raise RuntimeError(f"identity-service error {code}: {msg}")

    user_el = body.find("user")
    src = user_el if user_el is not None else body
    identity_uuid = _text(src, "identity_uuid", "master_uuid")
    email = _text(src, "email")

    if not identity_uuid:
        raise RuntimeError("identity-service response missing UUID")

    return IdentityUser(identity_uuid=identity_uuid, email=email or "unknown")


# --- Multi-agent AI response parser ---

def parse_ai_response(xml_text: str) -> AIResponse:
    """
    Parse an ai_response from a downstream team AI.

    Expected body:
      <status>ok</status>
      <response>Natural language answer...</response>
      <data>
        <!-- optional structured data: sessions, invoices, totals -->
      </data>
    """
    body = _get_body(xml_text)
    status = _text(body, "status").lower()

    if status not in ("ok", ""):
        code = _text(body, "error_code") or "UNKNOWN"
        msg = _text(body, "error_message", "error_description", "message") or "Service error"
        raise RuntimeError(f"Team AI error {code}: {msg}")

    response_text = _text(body, "response", "answer", "message") or ""

    # Extract structured data from <data> element (optional)
    data_el = body.find("data")
    search_in = data_el if data_el is not None else body

    sessions = _parse_sessions_from(search_in)
    invoices = _parse_invoices_from(search_in)
    total = _parse_total_from(search_in)

    return AIResponse(response=response_text, sessions=sessions, invoices=invoices, total=total)
