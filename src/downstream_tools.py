import os
from dataclasses import dataclass

from rabbitmq_rpc import get_thread_client
from xml_builders import build_identity_lookup_by_email_request
from xml_parsers import parse_identity_response, IdentityUser


def _env(name: str, default: str) -> str:
    val = os.getenv(name)
    return val.strip() if val and val.strip() else default


@dataclass(frozen=True)
class DownstreamConfig:
    identity_queue: str = _env("IDENTITY_RPC_QUEUE", "identity.user.lookup.email.request")
    rpc_timeout: float = float(os.getenv("RPC_TIMEOUT", "10.0"))


def _rpc_call(queue: str, xml: str, timeout: float) -> str:
    """Blocking RPC call using thread-local persistent connection."""
    client = get_thread_client()
    try:
        result = client.call(queue, xml.encode("utf-8"), timeout_seconds=timeout)
    except Exception:
        client.reconnect()
        result = client.call(queue, xml.encode("utf-8"), timeout_seconds=timeout)
    return result.body.decode("utf-8", errors="replace")


def resolve_identity_by_email(email: str, cfg: DownstreamConfig) -> IdentityUser:
    xml = build_identity_lookup_by_email_request(email)
    response = _rpc_call(cfg.identity_queue, xml, cfg.rpc_timeout)
    return parse_identity_response(response)
