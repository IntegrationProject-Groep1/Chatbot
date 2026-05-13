import threading
import time
import xml.etree.ElementTree as ET
import pika
import os
import json
import httpx
import sqlite3

# ─── NL2SQL Agent Logic (LLM Powered) ────────────────────────────────────────

class NL2SQLAgent:
    """
    A robust NL2SQL agent with caching and error handling.
    """
    def __init__(self, team_name: str, db_path: str, schema_ddl: str):
        self.team_name = team_name
        self.db_path = db_path
        self.schema_ddl = schema_ddl
        self.api_key = os.getenv("NVIDIA_API_KEY", "")
        self.api_url = os.getenv("NVIDIA_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
        self.model = os.getenv("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")
        self._cache = {}

    def _get_sql_from_llm(self, query: str, identity_uuid: str, scope: str) -> str:
        """Asks the LLM to generate SQL. Uses local cache to avoid redundant calls."""
        cache_key = f"{query}|{identity_uuid}|{scope}"
        if cache_key in self._cache:
            print(f"[{self.team_name}] Cache Hit for: {query}")
            return self._cache[cache_key]

        if not self.api_key:
            return "SELECT 'API KEY MISSING' as error"

        system_prompt = f"""You are the official SQL expert for the '{self.team_name}' team.
Your database schema is:
{self.schema_ddl}

Rules:
1. Return ONLY a single SQLite-compatible SELECT statement.
2. No commentary, no triple backticks, just the plain SQL text.
3. If scope='personal', you MUST include: WHERE master_uuid = '{identity_uuid}' (or AND if where exists).
4. If scope='public', DO NOT filter by master_uuid.
5. If the user asks for something outside your schema (e.g. billing data from the planning agent), return: SELECT 'UNSUPPORTED_QUERY' as error.
6. Use LIMIT 50 to prevent huge responses."""

        try:
            response = httpx.post(
                self.api_url,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"User is asking: {query}"}
                    ],
                    "temperature": 0.0
                },
                timeout=12.0
            )
            response.raise_for_status()
            sql = response.json()['choices'][0]['message']['content'].strip()
            # Clean possible markdown artifacts
            sql = sql.replace("```sql", "").replace("```", "").strip()
            self._cache[cache_key] = sql
            return sql
        except Exception as e:
            print(f"[{self.team_name}] LLM Error: {e}")
            return "SELECT 'LLM_REASONING_FAILED' as error"

    def handle_query(self, identity_uuid: str, scope: str, query: str) -> tuple[str, list]:
        """Translates NL to SQL, executes it safely, and returns results."""
        sql = self._get_sql_from_llm(query, identity_uuid, scope)
        print(f"[{self.team_name}] Executing SQL: {sql}")
        
        results = []
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            # Basic safety check
            forbidden = ["DROP", "DELETE", "UPDATE", "INSERT", "ALTER", "TRUNCATE"]
            if any(word in sql.upper() for word in forbidden):
                return f"Access denied: write operations are forbidden for the {self.team_name} agent.", []

            cursor.execute(sql)
            rows = cursor.fetchall()
            results = [dict(r) for r in rows]
            conn.close()
            
            if results and "error" in results[0]:
                err = results[0]["error"]
                if err == "UNSUPPORTED_QUERY":
                    return f"I am the {self.team_name} expert. I cannot answer that because it involves data I don't have access to.", []
                return f"The {self.team_name} agent encountered an internal logic error: {err}", []

            response_text = f"As the {self.team_name} specialist, I've analyzed our records. "
            if not results:
                response_text += "I couldn't find any data matching your request."
            else:
                response_text += f"I found {len(results)} relevant entry/entries for you."
                
            return response_text, results
        except Exception as e:
            return f"The {self.team_name} database reported an error: {str(e)}", []


# ─── Helper Functions ─────────────────────────────────────────────────────────

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


# ─── Team Agent Workers ──────────────────────────────────────────────────────

def run_team_agent(team_name: str, queue_name: str, db_path: str, schema_ddl: str):
    agent = NL2SQLAgent(team_name, db_path, schema_ddl)
    conn = _connection()
    ch = conn.channel()
    ch.queue_declare(queue=queue_name, durable=True)

    def on_message(ch, method, props, body):
        ch.basic_ack(method.delivery_tag)
        identity_uuid, scope, query = _parse_ai_query(body)
        
        print(f"[{team_name.upper()} Agent] Processing Natural Language: '{query}'")
        response_text, data = agent.handle_query(identity_uuid, scope, query)

        data_xml = ""
        if data:
            blocks = []
            for item in data:
                if team_name == "planning":
                    blocks.append(f"""      <session>
        <session_id>{item.get('session_id', '')}</session_id>
        <name>{item.get('name', '')}</name>
        <date>{item.get('date', '')}</date>
        <location>{item.get('location', '')}</location>
        <description>{item.get('description', '')}</description>
      </session>""")
                elif team_name == "facturatie":
                    blocks.append(f"""      <invoice>
        <invoice_id>{item.get('invoice_id', '')}</invoice_id>
        <amount currency="{item.get('currency', 'eur')}">{item.get('amount', '0.00')}</amount>
        <date>{item.get('date', '')}</date>
        <status>{item.get('status', '')}</status>
      </invoice>""")
            
            data_xml = "\n".join(blocks)
            if team_name == "facturatie":
                total = sum(float(i.get("amount", 0)) for i in data)
                data_xml += f"""\n      <total_amount currency="eur">{total:.2f}</total_amount>
      <invoice_count>{len(data)}</invoice_count>"""

        xml = _wrap_response(team_name, props.correlation_id or "", response_text, data_xml)
        _reply(ch, props, xml)
        print(f"[{team_name.upper()} Agent] Replied with {len(data)} records.")

    ch.basic_consume(queue_name, on_message)
    print(f"[{team_name.upper()} Agent] Real NL2SQL Listening on {queue_name}...")
    ch.start_consuming()


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    planning_ddl = """
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, name TEXT, date TEXT, location TEXT, description TEXT);
    CREATE TABLE enrollments (master_uuid TEXT, session_id TEXT);
    """
    facturatie_ddl = """
    CREATE TABLE invoices (invoice_id TEXT PRIMARY KEY, master_uuid TEXT, amount DECIMAL, currency TEXT, date TEXT, status TEXT);
    """

    threads = [
        threading.Thread(target=run_identity_mock, daemon=True),
        threading.Thread(target=lambda: run_team_agent("planning", "planning.exchange", "planning.db", planning_ddl), daemon=True),
        threading.Thread(target=lambda: run_team_agent("facturatie", "facturatie.rpc", "facturatie.db", facturatie_ddl), daemon=True),
    ]
    for t in threads:
        t.start()
    print("[System] Real LLM-Powered NL2SQL Network Online.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("[System] Shutting down.")
