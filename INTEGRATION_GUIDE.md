# Integration Guide v2.0 — Chatbot MCP Server

This document outlines how the **Planning** and **Facturatie** teams should integrate with the Chatbot MCP Server via RabbitMQ RPC.

## 1. Core Principles

- **Protocol**: RabbitMQ RPC (Request/Response using `reply_to` and `correlation_id`).
- **Data Format**: XML (conforming to XSDs in `/xsd`).
- **Encapsulation**: All responses **must** be wrapped in a `<message>` element containing a `<header>` and a `<body>`.

## 2. Planning Service (Sessions)

### Exchange: `planning.exchange`

#### Supported Requests
- `sessions_list_request`: Fetch all available sessions.
- `user_enrollments_request`: Fetch sessions a specific user is enrolled in.

#### Expected Response Format (v2.0)
```xml
<message>
  <header>
    <source>planning</source>
    <type>sessions_list_response</type>
    <correlation_id>REQ_CORRELATION_ID</correlation_id>
    <timestamp>2026-05-15T10:30:15Z</timestamp>
  </header>
  <body>
    <status>ok</status>
    <session>
      <session_id>sess-001</session_id>
      <name>Integration Workshop</name>
      <date>2026-05-15T09:00:00Z</date>
      <location>Room A</location>
      <description>Optional session description</description>
    </session>
  </body>
</message>
```

## 3. Facturatie Service (Invoices)

### Queue: `facturatie.rpc`

#### Supported Requests
- `invoices_list_request`: Fetch a list of all invoices for a user.
- `invoices_total_request`: Fetch the total amount of all invoices for a user.

#### Expected Response Format (v2.0)
```xml
<message>
  <header>
    <source>facturatie</source>
    <type>invoices_total_response</type>
    <correlation_id>REQ_CORRELATION_ID</correlation_id>
  </header>
  <body>
    <status>ok</status>
    <total_amount currency="eur">125.50</total_amount>
    <invoice_count>2</invoice_count>
  </body>
</message>
```

## 4. Error Handling

In case of an error, return a response with `<status>error</status>`. The MCP server is designed to parse multiple error formats for maximum compatibility.

### Standard Service Error
```xml
<message>
  <body>
    <status>error</status>
    <error_code>user_not_found</error_code>
    <error_description>The provided master_uuid does not exist in our records.</error_description>
  </body>
</message>
```

### System Error (v2.3 Standard)
```xml
<message>
  <header>
    <type>system_error</type>
  </header>
  <body>
    <error_code>database_timeout</error_code>
    <error_description>The database took too long to respond.</error_description>
  </body>
</message>
```

## 5. Available MCP Tools

The following tools are exposed by the server for the AI Chatbot:

1.  **`resolve_user_by_email`**: Converts a user's email into their `master_uuid`.
2.  **`list_all_sessions`**: Retrieves all available sessions from the Planning service.
3.  **`list_my_sessions`**: Retrieves sessions the user is enrolled in.
4.  **`count_my_invoices`**: Retrieves the count of invoices for the user.
5.  **`total_invoice_cost`**: Retrieves the total cost and count of all invoices.
6.  **`ask_event_assistant`**: General Q&A tool powered by LLM (NVIDIA).

## 6. Implementation Checklist for Teams

- [ ] Listen on the correct queue/exchange.
- [ ] Use the `correlation_id` from the request in the response header.
- [ ] Ensure all decimal amounts use `.` as a separator (e.g., `150.50`).
- [ ] Wrap all responses in the `<message>` structure.

---
**Status**: 🟢 Updated to v2.0/v2.3 XML Standards (English)
