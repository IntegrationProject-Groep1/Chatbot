import pika
import time
import xml.etree.ElementTree as ET
import os

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "localhost")

def create_response(req_xml, res_type, body_content):
    try:
        root = ET.fromstring(req_xml)
        corr_id = "unknown"
        # In a real scenario, the corr_id comes from properties, but some teams might put it in XML
    except:
        pass

    response = f"""<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <source>mock-service</source>
    <type>{res_type}</type>
  </header>
  <body>
    <status>ok</status>
    {body_content}
  </body>
</message>"""
    return response

def on_request(ch, method, props, body):
    req_xml = body.decode()
    routing_key = method.routing_key
    print(f" [x] Received request on {routing_key}")
    
    res_body = ""
    res_type = "response"

    if "sessions_list_request" in req_xml or "user_enrollments_request" in req_xml:
        res_type = "sessions_list_response"
        res_body = """
        <session>
            <session_id>sess-001</session_id>
            <name>Docker Integration Workshop</name>
            <date>2026-05-20T10:00:00Z</date>
            <location>Virtual Room 1</location>
            <description>Testing our MCP server locally!</description>
        </session>
        """
    elif "invoices_total_request" in req_xml:
        res_type = "invoices_total_response"
        res_body = """
        <total_amount currency="eur">99.99</total_amount>
        <invoice_count>1</invoice_count>
        """
    elif "identity_request" in req_xml:
        res_type = "identity_response"
        res_body = """
        <user>
            <master_uuid>mock-uuid-12345</master_uuid>
            <email>test@example.com</email>
        </user>
        """

    response = create_response(req_xml, res_type, res_body)

    ch.basic_publish(exchange='',
                     routing_key=props.reply_to,
                     properties=pika.BasicProperties(correlation_id=props.correlation_id),
                     body=response.encode())
    ch.basic_ack(delivery_tag=method.delivery_tag)

def main():
    print(f"Connecting to RabbitMQ at {RABBITMQ_HOST}...")
    connection = None
    for _ in range(10):
        try:
            connection = pika.BlockingConnection(pika.ConnectionParameters(host=RABBITMQ_HOST))
            break
        except:
            print("Waiting for RabbitMQ...")
            time.sleep(5)
    
    if not connection:
        print("Could not connect to RabbitMQ")
        return

    channel = connection.channel()

    queues = ['identity.rpc', 'facturatie.rpc', 'planning.exchange']
    for q in queues:
        channel.queue_declare(queue=q)
        channel.basic_qos(prefetch_count=1)
        channel.basic_consume(queue=q, on_message_callback=on_request)

    print(" [x] Mock Services Awaiting RPC requests")
    channel.start_consuming()

if __name__ == "__main__":
    main()
