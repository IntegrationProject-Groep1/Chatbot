import os
import threading
import time
import uuid
import json
from dataclasses import dataclass

import pika


def _connection_params() -> pika.ConnectionParameters:
    host = os.getenv("RABBITMQ_HOST", "localhost")
    port = int(os.getenv("RABBITMQ_PORT", "5672"))
    # RABBITMQCHATBOT_USER/PASS are the team-prefixed names in the shared Infra .env.
    # RABBIT_USER/PASS are the standard override names (docker-compose local dev, K8s direct inject).
    user = (os.getenv("RABBIT_USER")
            or os.getenv("RABBITMQCHATBOT_USER")
            or os.getenv("RABBITMQ_USER", "guest"))
    password = (os.getenv("RABBIT_PASS")
                or os.getenv("RABBITMQCHATBOT_PASS")
                or os.getenv("RABBITMQ_PASSWORD", "guest"))
    vhost = os.getenv("RABBITMQ_VHOST", "/")
    return pika.ConnectionParameters(
        host=host,
        port=port,
        virtual_host=vhost,
        credentials=pika.PlainCredentials(user, password),
        connection_attempts=3,
        retry_delay=2,
        heartbeat=30,
        blocked_connection_timeout=30,
        socket_timeout=10,
    )


@dataclass
class RpcResult:
    body: bytes
    correlation_id: str
    content_type: str | None


# ---------------------------------------------------------------------------
# Thread-local persistent client (used by downstream_tools in v2)
# ---------------------------------------------------------------------------

class PersistentRabbitMQClient:
    """One long-lived RabbitMQ connection per thread."""

    def __init__(self) -> None:
        self._connection: pika.BlockingConnection | None = None
        self._channel = None
        self._reply_queue: str | None = None

    def connect(self) -> None:
        self._connection = pika.BlockingConnection(_connection_params())
        self._channel = self._connection.channel()
        result = self._channel.queue_declare(queue="", exclusive=True, auto_delete=True)
        self._reply_queue = result.method.queue

    def is_alive(self) -> bool:
        try:
            return (
                self._connection is not None
                and self._connection.is_open
                and self._channel is not None
                and self._channel.is_open
            )
        except Exception:
            return False

    def reconnect(self) -> None:
        try:
            if self._connection and self._connection.is_open:
                self._connection.close()
        except Exception:
            pass
        self._connection = None
        self._channel = None
        self._reply_queue = None
        self.connect()

    def call(
        self,
        request_queue: str,
        body: bytes,
        *,
        timeout_seconds: float = 10.0,
        content_type: str = "application/xml",
        correlation_id: str | None = None,
    ) -> RpcResult:
        corr_id = correlation_id or uuid.uuid4().hex
        props = pika.BasicProperties(
            content_type=content_type,
            delivery_mode=2,
            reply_to=self._reply_queue,
            correlation_id=corr_id,
        )
        self._channel.basic_publish(
            exchange="",
            routing_key=request_queue,
            body=body,
            properties=props,
        )
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            method_frame, header_frame, response_body = self._channel.basic_get(
                queue=self._reply_queue, auto_ack=False
            )
            if method_frame:
                # Always ack to keep the exclusive queue clean; only return on ID match.
                self._channel.basic_ack(method_frame.delivery_tag)
                if header_frame and header_frame.correlation_id == corr_id:
                    return RpcResult(
                        body=response_body,
                        correlation_id=corr_id,
                        content_type=getattr(header_frame, "content_type", None),
                    )
                # Stale reply from a previous timed-out call — discard and keep polling.
            self._connection.process_data_events(time_limit=0.2)
        raise TimeoutError(f"RPC timeout waiting for response from '{request_queue}'")

    def publish_event(
        self,
        exchange_name: str,
        routing_key: str,
        event_data: dict,
        *,
        content_type: str = "application/json",
    ) -> None:
        """Publishes a fire-and-forget event (Audit/Logging)."""
        # Ensure exchange exists
        self._channel.exchange_declare(exchange=exchange_name, exchange_type="topic", durable=True)

        body = json.dumps(event_data, ensure_ascii=False).encode("utf-8")
        props = pika.BasicProperties(
            content_type=content_type,
            delivery_mode=2,
            timestamp=int(time.time()),
        )
        self._channel.basic_publish(
            exchange=exchange_name,
            routing_key=routing_key,
            body=body,
            properties=props,
        )


_thread_local = threading.local()


def get_thread_client() -> PersistentRabbitMQClient:
    """Return (or create) a persistent RabbitMQ client for the current thread."""
    client: PersistentRabbitMQClient | None = getattr(_thread_local, "client", None)
    if client is None or not client.is_alive():
        client = PersistentRabbitMQClient()
        client.connect()
        _thread_local.client = client
    return client


# ---------------------------------------------------------------------------
# Legacy context-manager client (kept for mock_services.py compatibility)
# ---------------------------------------------------------------------------

class RabbitMQRpcClient:
    def __init__(self) -> None:
        self._connection = None
        self._channel = None
        self._reply_queue: str | None = None

    def __enter__(self) -> "RabbitMQRpcClient":
        self._connection = pika.BlockingConnection(_connection_params())
        self._channel = self._connection.channel()
        result = self._channel.queue_declare(queue="", exclusive=True, auto_delete=True)
        self._reply_queue = result.method.queue
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if self._channel and self._channel.is_open:
                self._channel.close()
        finally:
            if self._connection and self._connection.is_open:
                self._connection.close()

    def call(
        self,
        request_queue: str,
        body: bytes,
        *,
        timeout_seconds: float = 10.0,
        content_type: str = "application/xml",
        correlation_id: str | None = None,
    ) -> RpcResult:
        corr_id = correlation_id or uuid.uuid4().hex
        props = pika.BasicProperties(
            content_type=content_type,
            delivery_mode=2,
            reply_to=self._reply_queue,
            correlation_id=corr_id,
        )
        self._channel.basic_publish(
            exchange="",
            routing_key=request_queue,
            body=body,
            properties=props,
        )
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            method_frame, header_frame, response_body = self._channel.basic_get(
                queue=self._reply_queue, auto_ack=False
            )
            if method_frame:
                self._channel.basic_ack(method_frame.delivery_tag)
                if header_frame and header_frame.correlation_id == corr_id:
                    return RpcResult(
                        body=response_body,
                        correlation_id=corr_id,
                        content_type=getattr(header_frame, "content_type", None),
                    )
            self._connection.process_data_events(time_limit=0.2)
        raise TimeoutError(f"RPC timeout waiting for response from '{request_queue}'")

    def publish_event(
        self,
        exchange_name: str,
        routing_key: str,
        event_data: dict,
        *,
        content_type: str = "application/json",
    ) -> None:
        """Publishes a fire-and-forget event (Audit/Logging)."""
        # Ensure exchange exists
        self._channel.exchange_declare(exchange=exchange_name, exchange_type="topic", durable=True)

        body = json.dumps(event_data, ensure_ascii=False).encode("utf-8")
        props = pika.BasicProperties(
            content_type=content_type,
            delivery_mode=2,
            timestamp=int(time.time()),
        )
        self._channel.basic_publish(
            exchange=exchange_name,
            routing_key=routing_key,
            body=body,
            properties=props,
        )


def publish_xml_to_queue(queue: str, xml: str) -> None:
    """Fire-and-forget: publish raw XML to a named queue (direct/default exchange). Retries once on failure."""
    import logging
    _log = logging.getLogger(__name__)
    for attempt in range(2):
        try:
            client = get_thread_client()
            if attempt > 0:
                client.reconnect()
            client._channel.basic_publish(
                exchange="",
                routing_key=queue,
                body=xml.encode("utf-8"),
                properties=pika.BasicProperties(content_type="application/xml", delivery_mode=2),
            )
            return
        except Exception as exc:
            if attempt > 0:
                _log.warning("XML publish to queue '%s' failed: %s", queue, exc)


def publish_xml_to_exchange(exchange: str, routing_key: str, xml: str) -> None:
    """Fire-and-forget: publish raw XML to a topic exchange. Retries once on failure."""
    import logging
    _log = logging.getLogger(__name__)
    for attempt in range(2):
        try:
            client = get_thread_client()
            if attempt > 0:
                client.reconnect()
            client._channel.exchange_declare(exchange=exchange, exchange_type="topic", durable=True)
            client._channel.basic_publish(
                exchange=exchange,
                routing_key=routing_key,
                body=xml.encode("utf-8"),
                properties=pika.BasicProperties(content_type="application/xml", delivery_mode=2),
            )
            return
        except Exception as exc:
            if attempt > 0:
                _log.warning("XML publish to exchange '%s/%s' failed: %s", exchange, routing_key, exc)


def publish_audit_event(routing_key: str, event_data: dict) -> None:
    """Publish a fire-and-forget audit event. Retries once after forced reconnect on connection loss."""
    import logging
    _alog = logging.getLogger(__name__)
    for attempt in range(2):
        try:
            client = get_thread_client()
            if attempt > 0:
                client.reconnect()
            client.publish_event("ai.events", routing_key, event_data)
            return
        except Exception as exc:
            if attempt == 0:
                _alog.debug("Audit publish failed (%s) — reconnecting and retrying", exc)
            else:
                _alog.warning("Audit event lost after reconnect: %s", exc)
