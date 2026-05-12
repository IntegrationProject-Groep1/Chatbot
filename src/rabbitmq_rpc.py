import os
import threading
import time
import uuid
from dataclasses import dataclass

import pika


def _connection_params() -> pika.ConnectionParameters:
    host = os.getenv("RABBITMQ_HOST", "localhost")
    port = int(os.getenv("RABBITMQ_PORT", "5672"))
    user = os.getenv("RABBIT_USER") or os.getenv("RABBITMQ_USER", "guest")
    password = os.getenv("RABBIT_PASS") or os.getenv("RABBITMQ_PASSWORD", "guest")
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
                queue=self._reply_queue, auto_ack=True
            )
            if method_frame and header_frame and header_frame.correlation_id == corr_id:
                return RpcResult(
                    body=response_body,
                    correlation_id=corr_id,
                    content_type=getattr(header_frame, "content_type", None),
                )
            self._connection.process_data_events(time_limit=0.2)
        raise TimeoutError(f"RPC timeout waiting for response from '{request_queue}'")


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
                queue=self._reply_queue, auto_ack=True
            )
            if method_frame and header_frame and header_frame.correlation_id == corr_id:
                return RpcResult(
                    body=response_body,
                    correlation_id=corr_id,
                    content_type=getattr(header_frame, "content_type", None),
                )
            self._connection.process_data_events(time_limit=0.2)
        raise TimeoutError(f"RPC timeout waiting for response from '{request_queue}'")
