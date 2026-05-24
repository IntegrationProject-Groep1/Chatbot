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
