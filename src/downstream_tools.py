import os
from dataclasses import dataclass

from rabbitmq_rpc import get_thread_client
from xml_builders import (
    build_identity_create_request,
    build_identity_lookup_by_email_request,
    build_identity_lookup_by_uuid_request,
    build_identity_delete_request
)
from xml_parsers import parse_identity_response, parse_identity_delete_response, IdentityUser


def _env(name: str, default: str) -> str:
    val = os.getenv(name)
    return val.strip() if val and val.strip() else default


@dataclass(frozen=True)
class DownstreamConfig:
    identity_queue: str          = _env("IDENTITY_RPC_QUEUE", "identity.user.lookup.email.request")
    identity_create_queue: str   = _env("IDENTITY_CREATE_QUEUE", "identity.user.create.request")
    identity_delete_queue: str   = _env("IDENTITY_DELETE_QUEUE", "identity.user.delete.request")
    rpc_timeout: float           = float(os.getenv("RPC_TIMEOUT", "10.0"))


def _rpc_call(queue: str, xml: str, timeout: float) -> str:
    """Blocking RPC call using thread-local persistent connection."""
    client = get_thread_client()
    try:
        result = client.call(queue, xml.encode("utf-8"), timeout_seconds=timeout)
    except Exception:
        client.reconnect()
        result = client.call(queue, xml.encode("utf-8"), timeout_seconds=timeout)
    return result.body.decode("utf-8", errors="replace")


def create_identity_user(email: str, cfg: DownstreamConfig) -> dict:
    """Register a new user with the Identity service and return their master_uuid.

    Idempotent: if the email already exists, returns the existing master_uuid.
    On success triggers a UserCreated fanout to user.events (Kassa + Facturatie auto-create their records).
    Returns {"success": True, "master_uuid": "...", "email": "..."} or {"success": False, "error": "..."}.
    """
    try:
        xml = build_identity_create_request(email)
        response = _rpc_call(cfg.identity_create_queue, xml, cfg.rpc_timeout)
        user = parse_identity_response(response)
        return {"success": True, "master_uuid": user.identity_uuid, "email": user.email}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def resolve_identity_by_email(email: str, cfg: DownstreamConfig) -> IdentityUser:
    xml = build_identity_lookup_by_email_request(email)
    response = _rpc_call(cfg.identity_queue, xml, cfg.rpc_timeout)
    return parse_identity_response(response)


def resolve_identity_by_uuid(identity_uuid: str, cfg: DownstreamConfig) -> IdentityUser:
    xml = build_identity_lookup_by_uuid_request(identity_uuid)
    response = _rpc_call(cfg.identity_queue, xml, cfg.rpc_timeout)
    return parse_identity_response(response)


def delete_identity_user(master_uuid: str, reason: str, cfg: DownstreamConfig) -> dict:
    """Send a delete request to identity-service via RabbitMQ RPC.

    Returns {"success": True, ...} on success or {"success": False, "error": "..."} on failure.
    Triggers UserDeleted event publication to user.events fanout by identity-service.
    """
    xml = build_identity_delete_request(master_uuid, reason)
    response = _rpc_call(cfg.identity_delete_queue, xml, cfg.rpc_timeout)
    return parse_identity_delete_response(response)
