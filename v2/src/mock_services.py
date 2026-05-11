"""
Mock RabbitMQ services — simulates the team AIs for Planning and Facturatie.

Each mock:
  1. Receives an ai_query XML message
  2. Reads scope ("public" / "personal") and the natural language query
  3. Returns an ai_response XML with a natural language <response> + structured <data>

Identity service mock uses bare XML (no envelope) — it is the contract exception.
"""
import threading
import time
import xml.etree.ElementTree as ET
import pika


def _connection():
    import os
    host = os.getenv("RABBITMQ_HOST", "localhost")
    for attempt in range(10):
        try:
            return pika.BlockingConnection(
                pika.ConnectionParameters(host=host, heartbeat=60, blocked_connection_timeout=30)
            )
        except Exception:
            print(f"[Mock] RabbitMQ not ready, retrying ({attempt + 1}/10)...")
            time.sleep(3)
    raise RuntimeError("Could not connect to RabbitMQ after 10 attempts")


def _reply(channel, props, xml_body: str) -> None:
    if not props.reply_to:
        return
    channel.basic_publish(
        exchange="",
        routing_key=props.reply_to,
        properties=pika.BasicProperties(
            correlation_id=props.correlation_id,
            content_type="application/xml",
        ),
        body=xml_body.encode("utf-8"),
    )


def _parse_ai_query(body: bytes) -> tuple[str, str, str]:
    """Returns (identity_uuid, scope, query) from an ai_query XML message."""
    try:
        root = ET.fromstring(body.decode("utf-8"))
        b = root.find("body") if root.tag == "message" else root
        identity_uuid = (b.findtext("identity_uuid") or "").strip()
        scope = (b.findtext("scope") or "public").strip()
        query = (b.findtext("query") or "").strip()
        return identity_uuid, scope, query
    except ET.ParseError:
        return "", "public", ""


def _wrap_response(source: str, correlation_id: str, response_text: str, data_xml: str) -> str:
    return f"""<message>
  <header>
    <source>{source}</source>
    <type>ai_response</type>
    <correlation_id>{correlation_id}</correlation_id>
    <version>2.0</version>
  </header>
  <body>
    <status>ok</status>
    <response>{response_text}</response>
    <data>
{data_xml}
    </data>
  </body>
</message>"""


# ─── Identity Service Mock ────────────────────────────────────────────────────

def run_identity_mock():
    conn = _connection()
    ch = conn.channel()
    ch.queue_declare(queue="identity.user.lookup.email.request", durable=True)
    ch.queue_declare(queue="identity.user.lookup.uuid.request", durable=True)

    def on_message(ch, method, props, body):
        ch.basic_ack(method.delivery_tag)
        try:
            req = ET.fromstring(body.decode("utf-8"))
            email = (req.findtext("email") or "test@example.com").strip()
        except ET.ParseError:
            email = "unknown@example.com"

        uuid_val = "mock-uuid-12345"
        # Bare XML response — no envelope (Identity is the contract exception)
        response = f"""<identity_response>
  <status>ok</status>
  <user>
    <master_uuid>{uuid_val}</master_uuid>
    <identity_uuid>{uuid_val}</identity_uuid>
    <email>{email}</email>
  </user>
</identity_response>"""
        _reply(ch, props, response)
        print(f"[Identity Mock] Resolved {email} → {uuid_val}")

    ch.basic_consume("identity.user.lookup.email.request", on_message)
    ch.basic_consume("identity.user.lookup.uuid.request", on_message)
    print("[Identity Mock] Listening...")
    ch.start_consuming()


# ─── Planning Team AI Mock ────────────────────────────────────────────────────

ALL_SESSIONS = [
    {"session_id": "sess-001", "name": "Docker &amp; Microservices Workshop", "date": "2026-05-20T09:00:00Z", "location": "Room A — Tech Hub"},
    {"session_id": "sess-002", "name": "API Design Best Practices", "date": "2026-05-21T14:00:00Z", "location": "Room B — Innovation Lab"},
    {"session_id": "sess-003", "name": "Integration Patterns with RabbitMQ", "date": "2026-05-22T10:00:00Z", "location": "Auditorium"},
]
ENROLLED_SESSIONS = ALL_SESSIONS[:2]


def _sessions_xml(sessions: list) -> str:
    blocks = []
    for s in sessions:
        blocks.append(f"""      <session>
        <session_id>{s['session_id']}</session_id>
        <name>{s['name']}</name>
        <date>{s['date']}</date>
        <location>{s['location']}</location>
      </session>""")
    return "\n".join(blocks)


def run_planning_mock():
    conn = _connection()
    ch = conn.channel()
    ch.queue_declare(queue="planning.exchange", durable=True)
    ch.queue_declare(queue="planning.rpc", durable=True)

    def on_message(ch, method, props, body):
        ch.basic_ack(method.delivery_tag)
        identity_uuid, scope, query = _parse_ai_query(body)
        corr = props.correlation_id or ""

        if scope == "personal":
            sessions = ENROLLED_SESSIONS
            response_text = (
                f"The user (UUID: {identity_uuid}) is enrolled in {len(sessions)} sessions: "
                + ", ".join(s["name"] for s in sessions) + "."
            )
        else:
            sessions = ALL_SESSIONS
            response_text = (
                f"There are {len(sessions)} available sessions: "
                + ", ".join(s["name"] for s in sessions) + "."
            )

        data_xml = _sessions_xml(sessions)
        xml = _wrap_response("planning", corr, response_text, data_xml)
        _reply(ch, props, xml)
        print(f"[Planning Mock] Answered '{query[:60]}' (scope={scope}) with {len(sessions)} sessions")

    ch.basic_consume("planning.exchange", on_message)
    ch.basic_consume("planning.rpc", on_message)
    print("[Planning Mock] Listening...")
    ch.start_consuming()


# ─── Facturatie Team AI Mock ──────────────────────────────────────────────────

MOCK_INVOICES = [
    {"invoice_id": "inv-001", "amount": "49.99", "currency": "eur", "date": "2026-04-01", "status": "paid"},
    {"invoice_id": "inv-002", "amount": "50.00", "currency": "eur", "date": "2026-05-01", "status": "pending"},
    {"invoice_id": "inv-003", "amount": "50.00", "currency": "eur", "date": "2026-05-10", "status": "overdue"},
]


def run_facturatie_mock():
    conn = _connection()
    ch = conn.channel()
    ch.queue_declare(queue="facturatie.rpc", durable=True)
    ch.queue_declare(queue="facturatie.incoming", durable=True)

    def on_message(ch, method, props, body):
        ch.basic_ack(method.delivery_tag)
        identity_uuid, scope, query = _parse_ai_query(body)
        corr = props.correlation_id or ""

        total = sum(float(i["amount"]) for i in MOCK_INVOICES)
        response_text = (
            f"The user (UUID: {identity_uuid}) has {len(MOCK_INVOICES)} invoices "
            f"totalling €{total:.2f}. "
            f"Status breakdown: "
            + ", ".join(f"{i['invoice_id']} ({i['status']})" for i in MOCK_INVOICES) + "."
        )

        invoice_blocks = "\n".join(
            f"""      <invoice>
        <invoice_id>{i['invoice_id']}</invoice_id>
        <amount currency="{i['currency']}">{i['amount']}</amount>
        <date>{i['date']}</date>
        <status>{i['status']}</status>
      </invoice>"""
            for i in MOCK_INVOICES
        )
        total_block = f"""      <total_amount currency="eur">{total:.2f}</total_amount>
      <invoice_count>{len(MOCK_INVOICES)}</invoice_count>"""

        data_xml = invoice_blocks + "\n" + total_block
        xml = _wrap_response("facturatie", corr, response_text, data_xml)
        _reply(ch, props, xml)
        print(f"[Facturatie Mock] Answered '{query[:60]}' with {len(MOCK_INVOICES)} invoices")

    ch.basic_consume("facturatie.rpc", on_message)
    ch.basic_consume("facturatie.incoming", on_message)
    print("[Facturatie Mock] Listening...")
    ch.start_consuming()


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    threads = [
        threading.Thread(target=run_identity_mock, daemon=True),
        threading.Thread(target=run_planning_mock, daemon=True),
        threading.Thread(target=run_facturatie_mock, daemon=True),
    ]
    for t in threads:
        t.start()
    print("[Mocks] All team AI services running. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("[Mocks] Shutting down.")
