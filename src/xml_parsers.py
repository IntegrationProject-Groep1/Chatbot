from dataclasses import dataclass
import xml.etree.ElementTree as ET
from typing import Optional, List


@dataclass
class IdentityUser:
    master_uuid: str
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


def _get_body(xml_text: str) -> ET.Element:
    """Helper to extract the <body> element from a <message> wrapper, or return the root if no wrapper."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise RuntimeError(f"Invalid XML received: {e}")

    if root.tag == "message":
        body = root.find("body")
        if body is None:
            raise RuntimeError("Message received without <body> element")
        return body
    return root


def parse_identity_response(xml_text: str) -> IdentityUser:
    body = _get_body(xml_text)
    status = (body.findtext("status") or "").strip().lower()
    
    if status != "ok" and status != "":
        code = (body.findtext("error_code") or "UNKNOWN").strip()
        msg = (body.findtext("error_description") or body.findtext("error_message") or body.findtext("message") or "Identity RPC error").strip()
        raise RuntimeError(f"identity-service error {code}: {msg}")

    # Fallback for system_error which might not have status=error but is a different root
    if body.tag == "system_error" or body.find("error_code") is not None:
        if status != "ok":
            code = (body.findtext("error_code") or "UNKNOWN").strip()
            msg = (body.findtext("error_description") or "System error").strip()
            raise RuntimeError(f"system error {code}: {msg}")

    user = body.find("user")
    if user is None:
        # Some systems might put master_uuid directly in body
        master_uuid = (body.findtext("master_uuid") or "").strip()
        email = (body.findtext("email") or "").strip()
    else:
        master_uuid = (user.findtext("master_uuid") or "").strip()
        email = (user.findtext("email") or "").strip()

    if not master_uuid:
        raise RuntimeError("identity-service response missing master_uuid")

    return IdentityUser(master_uuid=master_uuid, email=email or "unknown")


def parse_sessions_list_response(xml_text: str) -> List[Session]:
    body = _get_body(xml_text)
    status = (body.findtext("status") or "").strip().lower()
    
    if status != "ok":
        code = (body.findtext("error_code") or "UNKNOWN").strip()
        msg = (body.findtext("error_message") or body.findtext("message") or "Planning error").strip()
        raise RuntimeError(f"planning-service error {code}: {msg}")

    sessions = []
    for session_elem in body.findall("session"):
        session_id = (session_elem.findtext("session_id") or "").strip()
        name = (session_elem.findtext("name") or "").strip()
        date = (session_elem.findtext("date") or "").strip()
        location = (session_elem.findtext("location") or "").strip()
        description = (session_elem.findtext("description") or "").strip()
        
        if session_id and name:
            sessions.append(Session(session_id, name, date, location, description))
    return sessions


def parse_user_enrollments_response(xml_text: str) -> List[Session]:
    # Documentation shows same structure for both session responses
    return parse_sessions_list_response(xml_text)


def parse_invoices_list_response(xml_text: str) -> List[Invoice]:
    body = _get_body(xml_text)
    status = (body.findtext("status") or "").strip().lower()
    
    if status != "ok":
        code = (body.findtext("error_code") or "UNKNOWN").strip()
        msg = (body.findtext("error_message") or body.findtext("message") or "Facturatie error").strip()
        raise RuntimeError(f"facturatie-service error {code}: {msg}")

    invoices = []
    for invoice_elem in body.findall("invoice"):
        invoice_id = (invoice_elem.findtext("invoice_id") or "").strip()
        amount_elem = invoice_elem.find("amount")
        if amount_elem is not None:
            amount = (amount_elem.text or "0").strip()
        else:
            amount = (invoice_elem.findtext("amount") or "0").strip()
            
        date = (invoice_elem.findtext("date") or "").strip()
        inv_status = (invoice_elem.findtext("status") or "unknown").strip()
        description = (invoice_elem.findtext("description") or "").strip()
        
        if invoice_id:
            invoices.append(Invoice(invoice_id, amount, date, inv_status, description))
    return invoices


def parse_invoices_total_response(xml_text: str) -> InvoiceTotal:
    body = _get_body(xml_text)
    status = (body.findtext("status") or "").strip().lower()
    
    if status != "ok":
        code = (body.findtext("error_code") or "UNKNOWN").strip()
        msg = (body.findtext("error_message") or body.findtext("message") or "Facturatie error").strip()
        raise RuntimeError(f"facturatie-service error {code}: {msg}")

    total_amount_elem = body.find("total_amount")
    if total_amount_elem is not None:
        total_amount = (total_amount_elem.text or "0").strip()
        currency = total_amount_elem.get("currency") or (body.findtext("currency") or "EUR").strip()
    else:
        total_amount = (body.findtext("total_amount") or "0").strip()
        currency = (body.findtext("currency") or "EUR").strip()
        
    count_str = (body.findtext("invoice_count") or "0").strip()
    try:
        count = int(count_str)
    except ValueError:
        count = 0

    return InvoiceTotal(total_amount, currency, count)
