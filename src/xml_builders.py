import xml.etree.ElementTree as ET
import uuid
from datetime import datetime


def _xml_text(parent: ET.Element, tag: str, value: str) -> None:
    child = ET.SubElement(parent, tag)
    child.text = str(value)


def build_identity_lookup_by_email_request(email: str) -> str:
    """Request user identity by email."""
    root = ET.Element("identity_request")
    _xml_text(root, "email", email)
    return ET.tostring(root, encoding="unicode")


# --- Planning service requests (via planning.exchange) ---

def build_sessions_list_request(master_uuid: str) -> str:
    """Request all available sessions from Planning service."""
    root = ET.Element("sessions_list_request")
    _xml_text(root, "master_uuid", master_uuid)
    return ET.tostring(root, encoding="unicode")


def build_user_enrollments_request(master_uuid: str) -> str:
    """Request all sessions the user is enrolled in."""
    root = ET.Element("user_enrollments_request")
    _xml_text(root, "master_uuid", master_uuid)
    return ET.tostring(root, encoding="unicode")


# --- Facturatie service requests ---

def build_invoices_list_request(master_uuid: str) -> str:
    """Request all invoices for a user."""
    root = ET.Element("invoices_list_request")
    _xml_text(root, "master_uuid", master_uuid)
    return ET.tostring(root, encoding="unicode")


def build_invoices_total_request(master_uuid: str) -> str:
    """Request the total amount of all invoices for a user."""
    root = ET.Element("invoices_total_request")
    _xml_text(root, "master_uuid", master_uuid)
    return ET.tostring(root, encoding="unicode")
