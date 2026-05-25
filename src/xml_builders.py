import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone


def _uuid() -> str:
    return str(uuid.uuid4())


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _xml_text(parent: ET.Element, tag: str, value: str) -> None:
    child = ET.SubElement(parent, tag)
    child.text = str(value)


def _build_envelope(message_type: str, correlation_id: str) -> tuple[ET.Element, ET.Element]:
    """Standard <message><header><body> envelope (v2.0 contract)."""
    root = ET.Element("message")
    header = ET.SubElement(root, "header")
    _xml_text(header, "message_id", _uuid())
    _xml_text(header, "timestamp", _timestamp())
    _xml_text(header, "source", "chatbot")
    _xml_text(header, "type", message_type)
    _xml_text(header, "version", "2.0")
    _xml_text(header, "correlation_id", correlation_id)
    body = ET.SubElement(root, "body")
    return root, body


# --- Identity Service (exception: bare XML, no envelope) ---

def build_identity_create_request(email: str, source_system: str = "chatbot") -> str:
    root = ET.Element("identity_request")
    _xml_text(root, "email", email.strip().lower())
    _xml_text(root, "source_system", source_system)
    return ET.tostring(root, encoding="unicode")


def build_identity_lookup_by_email_request(email: str) -> str:
    root = ET.Element("identity_request")
    _xml_text(root, "email", email)
    return ET.tostring(root, encoding="unicode")


def build_identity_lookup_by_uuid_request(identity_uuid: str) -> str:
    root = ET.Element("identity_request")
    _xml_text(root, "master_uuid", identity_uuid)
    return ET.tostring(root, encoding="unicode")


def build_identity_delete_request(master_uuid: str, reason: str) -> str:
    root = ET.Element("identity_delete_request")
    _xml_text(root, "master_uuid", master_uuid)
    _xml_text(root, "reason", reason)
    return ET.tostring(root, encoding="unicode")


# --- Wallet lease management (chatbot → Kassa / CRM) ---

def build_wallet_lease_grant(
    master_uuid: str,
    current_balance: float,
    lease_id: str,
    payment_due_amount: float | None = None,
    payment_due_status: str | None = None,
    correlation_id: str | None = None,
) -> str:
    """Build wallet_lease_grant message: chatbot → kassa.incoming.
    Mimics what the CRM sender normally publishes after processing a wallet_lease_request."""
    corr = correlation_id or _uuid()
    root, body = _build_envelope("wallet_lease_grant", corr)
    _xml_text(body, "identity_uuid", master_uuid)
    bal = ET.SubElement(body, "wallet_balance")
    bal.text = f"{current_balance:.2f}"
    bal.set("currency", "eur")
    _xml_text(body, "lease_id", lease_id)
    if payment_due_amount is not None:
        pd = ET.SubElement(body, "payment_due")
        amt = ET.SubElement(pd, "amount")
        amt.text = f"{payment_due_amount:.2f}"
        amt.set("currency", "eur")
        _xml_text(pd, "status", payment_due_status or "unpaid")
    return ET.tostring(root, encoding="unicode")


def build_wallet_lease_return(
    master_uuid: str,
    final_balance: float,
    lease_id: str,
    transaction_count: int = 0,
    correlation_id: str | None = None,
) -> str:
    """Build wallet_lease_return message: chatbot → kassa.exchange (kassa.to.crm.wallet_lease_return).
    Mimics what Kassa sender publishes on badge-out — fields match Kassa's build_wallet_lease_return_xml."""
    corr = correlation_id or _uuid()
    root, body = _build_envelope("wallet_lease_return", corr)
    _xml_text(body, "identity_uuid", master_uuid)
    bal = ET.SubElement(body, "final_balance")
    bal.text = f"{final_balance:.2f}"
    bal.set("currency", "eur")
    _xml_text(body, "lease_id", lease_id)
    _xml_text(body, "transaction_count", str(transaction_count))
    return ET.tostring(root, encoding="unicode")


def build_wallet_balance_update(
    master_uuid: str,
    new_balance: float,
    authority: str | None = None,
    status: str | None = None,
    correlation_id: str | None = None,
) -> str:
    """Build wallet_balance_update broadcast: chatbot → kassa.exchange (kassa.frontend.wallet).
    Mimics Kassa's build_wallet_balance_update_xml — notifies Frontend and CRM of admin balance correction."""
    corr = correlation_id or _uuid()
    root, body = _build_envelope("wallet_balance_update", corr)
    _xml_text(body, "identity_uuid", master_uuid)
    bal = ET.SubElement(body, "wallet_balance")
    bal.text = f"{new_balance:.2f}"
    bal.set("currency", "eur")
    if authority:
        _xml_text(body, "authority", authority)
    if status:
        _xml_text(body, "status", status)
    return ET.tostring(root, encoding="unicode")


# --- Multi-agent query (Planning + Facturatie) ---

def build_ai_query_request(
    identity_uuid: str,
    scope: str,
    query: str,
    correlation_id: str | None = None,
) -> str:
    """
    Build an ai_query message for a downstream team AI.

    scope = "public"   → data available to everyone (e.g. all sessions)
    scope = "personal" → data specific to this user only (UUID filter enforced by receiver)
    """
    corr = correlation_id or _uuid()
    root, body = _build_envelope("ai_query", corr)
    _xml_text(body, "identity_uuid", identity_uuid)
    _xml_text(body, "scope", scope)
    _xml_text(body, "query", query)
    return ET.tostring(root, encoding="unicode")
