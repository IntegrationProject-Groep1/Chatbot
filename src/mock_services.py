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


import sqlite3
import threading
import time
import xml.etree.ElementTree as ET
import pika
import os

def _db_conn(db_path: str):
    return sqlite3.connect(db_path)

def _get_planning_data(identity_uuid: str, scope: str):
    conn = _db_conn("v2/planning.db")
    cursor = conn.cursor()
    if scope == "personal":
        cursor.execute("""
            SELECT s.session_id, s.name, s.date, s.location, s.description 
            FROM sessions s
            JOIN enrollments e ON s.session_id = e.session_id
            WHERE e.master_uuid = ?
        """, (identity_uuid,))
    else:
        cursor.execute("SELECT session_id, name, date, location, description FROM sessions")
    rows = cursor.fetchall()
    conn.close()
    return [{"session_id": r[0], "name": r[1], "date": r[2], "location": r[3], "description": r[4]} for r in rows]

def _get_facturatie_data(identity_uuid: str):
    conn = _db_conn("v2/facturatie.db")
    cursor = conn.cursor()
    cursor.execute("SELECT invoice_id, amount, currency, date, status FROM invoices WHERE master_uuid = ?", (identity_uuid,))
    rows = cursor.fetchall()
    conn.close()
    return [{"invoice_id": r[0], "amount": r[1], "currency": r[2], "date": r[3], "status": r[4]} for r in rows]


def _connection():
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
        # Bare XML response — no envelope
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

def run_planning_mock():
    conn = _connection()
    ch = conn.channel()
    ch.queue_declare(queue="planning.exchange", durable=True)
    ch.queue_declare(queue="planning.rpc", durable=True)

    def on_message(ch, method, props, body):
        ch.basic_ack(method.delivery_tag)
        identity_uuid, scope, query = _parse_ai_query(body)
        corr = props.correlation_id or ""

        # Simulated AI reasoning:
        # 1. AI identifies the query intent (e.g. "what sessions?")
        # 2. AI uses its "MCP Tool" (SQLite query) to fetch data
        sessions = _get_planning_data(identity_uuid, scope)

        if scope == "personal":
            response_text = f"You are enrolled in {len(sessions)} session(s)."
            if sessions:
                response_text += " Specifically: " + ", ".join(s["name"] for s in sessions)
        else:
            response_text = f"There are {len(sessions)} sessions available in the catalog."

        # 3. AI generates structured XML data block
        blocks = []
        for s in sessions:
            blocks.append(f"""      <session>
        <session_id>{s['session_id']}</session_id>
        <name>{s['name']}</name>
        <date>{s['date']}</date>
        <location>{s['location']}</location>
        <description>{s['description']}</description>
      </session>""")
        data_xml = "\n".join(blocks)

        xml = _wrap_response("planning", corr, response_text, data_xml)
        _reply(ch, props, xml)
        print(f"[Planning Mock] Processed query: '{query[:40]}...' -> Found {len(sessions)} sessions")

    ch.basic_consume("planning.exchange", on_message)
    ch.basic_consume("planning.rpc", on_message)
    print("[Planning Mock] Listening...")
    ch.start_consuming()


# ─── Facturatie Team AI Mock ──────────────────────────────────────────────────

def run_facturatie_mock():
    conn = _connection()
    ch = conn.channel()
    ch.queue_declare(queue="facturatie.rpc", durable=True)
    ch.queue_declare(queue="facturatie.incoming", durable=True)

    def on_message(ch, method, props, body):
        ch.basic_ack(method.delivery_tag)
        identity_uuid, scope, query = _parse_ai_query(body)
        corr = props.correlation_id or ""

        # Simulated AI reasoning:
        invoices = _get_facturatie_data(identity_uuid)
        total = sum(float(i["amount"]) for i in invoices)
        
        response_text = f"I found {len(invoices)} invoices for you, totalling {total:.2f} EUR."

        invoice_blocks = "\n".join(
            f"""      <invoice>
        <invoice_id>{i['invoice_id']}</invoice_id>
        <amount currency="{i['currency']}">{i['amount']}</amount>
        <date>{i['date']}</date>
        <status>{i['status']}</status>
      </invoice>"""
            for i in invoices
        )
        total_block = f"""      <total_amount currency="eur">{total:.2f}</total_amount>
      <invoice_count>{len(invoices)}</invoice_count>"""

        data_xml = invoice_blocks + "\n" + total_block
        xml = _wrap_response("facturatie", corr, response_text, data_xml)
        _reply(ch, props, xml)
        print(f"[Facturatie Mock] Processed query: '{query[:40]}...' -> Found {len(invoices)} invoices")

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
    print("[Mocks] All team AI services running (SQLite + Simulated Reasoning).")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("[Mocks] Shutting down.")

