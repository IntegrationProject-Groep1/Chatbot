from __future__ import annotations

import os
from dataclasses import dataclass

from rabbitmq_rpc import RabbitMQRpcClient
from xml_builders import (
    build_identity_lookup_by_email_request,
    build_sessions_list_request,
    build_user_enrollments_request,
    build_invoices_list_request,
    build_invoices_total_request,
)
from xml_parsers import (
    parse_identity_response,
    parse_sessions_list_response,
    parse_user_enrollments_response,
    parse_invoices_list_response,
    parse_invoices_total_response,
    Session,
    Invoice,
    InvoiceTotal,
)


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default


@dataclass(frozen=True)
class DownstreamConfig:
    identity_queue: str = _env("IDENTITY_RPC_QUEUE", "identity.rpc")
    planning_exchange: str = _env("PLANNING_RPC_EXCHANGE", "planning.exchange")
    facturatie_queue: str = _env("FACTURATIE_RPC_QUEUE", "facturatie.rpc")
    rpc_timeout: float = float(os.getenv("RPC_TIMEOUT", "10.0"))


def resolve_master_uuid_by_email(email: str, cfg: DownstreamConfig) -> str:
    """Resolve a user to master_uuid via identity-service over RabbitMQ RPC."""
    req_xml = build_identity_lookup_by_email_request(email)
    with RabbitMQRpcClient() as rpc:
        result = rpc.call(
            cfg.identity_queue,
            req_xml.encode("utf-8"),
            timeout_seconds=cfg.rpc_timeout,
        )
    user = parse_identity_response(result.body.decode("utf-8", errors="replace"))
    return user.master_uuid


def get_all_sessions(master_uuid: str, cfg: DownstreamConfig) -> list[Session]:
    """Fetch all available sessions from Planning service."""
    req_xml = build_sessions_list_request(master_uuid)
    with RabbitMQRpcClient() as rpc:
        result = rpc.call(
            cfg.planning_exchange,
            req_xml.encode("utf-8"),
            timeout_seconds=cfg.rpc_timeout,
        )
    return parse_sessions_list_response(result.body.decode("utf-8", errors="replace"))


def get_user_enrollments(master_uuid: str, cfg: DownstreamConfig) -> list[Session]:
    """Fetch sessions the user is enrolled in from Planning service."""
    req_xml = build_user_enrollments_request(master_uuid)
    with RabbitMQRpcClient() as rpc:
        result = rpc.call(
            cfg.planning_exchange,
            req_xml.encode("utf-8"),
            timeout_seconds=cfg.rpc_timeout,
        )
    return parse_user_enrollments_response(result.body.decode("utf-8", errors="replace"))


def get_invoices_list(master_uuid: str, cfg: DownstreamConfig) -> list[Invoice]:
    """Fetch all invoices for a user from Facturatie service."""
    req_xml = build_invoices_list_request(master_uuid)
    with RabbitMQRpcClient() as rpc:
        result = rpc.call(
            cfg.facturatie_queue,
            req_xml.encode("utf-8"),
            timeout_seconds=cfg.rpc_timeout,
        )
    return parse_invoices_list_response(result.body.decode("utf-8", errors="replace"))


def get_invoices_total(master_uuid: str, cfg: DownstreamConfig) -> InvoiceTotal:
    """Fetch total invoice amount for a user from Facturatie service."""
    req_xml = build_invoices_total_request(master_uuid)
    with RabbitMQRpcClient() as rpc:
        result = rpc.call(
            cfg.facturatie_queue,
            req_xml.encode("utf-8"),
            timeout_seconds=cfg.rpc_timeout,
        )
    return parse_invoices_total_response(result.body.decode("utf-8", errors="replace"))

