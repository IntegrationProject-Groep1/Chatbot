# Chatbot MCP Server — XML/XSD Contracts v2.0

Deze pagina definieert alle XML contracts voor de Chatbot MCP Server die communiceert met downstream services via RabbitMQ RPC.

**Basis:** Compleet conform Integration Project XML/XSD Contract v2.3 (centrale contract-repo).

---

## Quick Reference — Per Service

| Service | Request Type | Response | Queue/Exchange |
|---------|---|---|---|
| **Planning** | `sessions_list_request` | `message` (sessions list) | `planning.exchange` |
| **Planning** | `user_enrollments_request` | `message` (enrollments) | `planning.exchange` |
| **Facturatie** | `invoices_list_request` | `message` (invoices) | `facturatie.rpc` |
| **Facturatie** | `invoices_total_request` | `message` (total) | `facturatie.rpc` |

---

## 1. Planning Service Requests

### 1.1 `sessions_list_request` — Request all available sessions

**Sent by:** Chatbot MCP Server  
**Sent to:** Planning team (queue: `planning.exchange`)  
**Purpose:** Fetch all available sessions (used by `list_all_sessions` MCP tool)

#### XML Example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<sessions_list_request>
  <master_uuid>e8b27c1d-4f2a-4b3e-9c5f-123456789abc</master_uuid>
</sessions_list_request>
```

#### XSD

```xml
<xs:element name="sessions_list_request">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="master_uuid" type="UUIDType"/>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

---

### 1.2 `user_enrollments_request` — Request sessions user is enrolled in

**Sent by:** Chatbot MCP Server  
**Sent to:** Planning team (queue: `planning.exchange`)  
**Purpose:** Fetch sessions the user is enrolled in (used by `list_my_sessions` MCP tool)

#### XML Example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<user_enrollments_request>
  <master_uuid>e8b27c1d-4f2a-4b3e-9c5f-123456789abc</master_uuid>
</user_enrollments_request>
```

#### XSD

```xml
<xs:element name="user_enrollments_request">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="master_uuid" type="UUIDType"/>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

---

## 2. Planning Service Responses

Both planning requests (`sessions_list_request` and `user_enrollments_request`) return the same response structure with a list of sessions.

### 2.1 Response Structure

**Sent by:** Planning team  
**Sent to:** Chatbot MCP Server  
**Queue:** Default reply queue (correlation_id based)

#### XML Example — Success (2+ sessions)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <message_id>63a4b5c6-d7e8-9012-abcd-ef1234567801</message_id>
    <timestamp>2026-05-15T10:30:15Z</timestamp>
    <source>planning</source>
    <type>sessions_list_response</type>
    <version>2.0</version>
    <correlation_id>550e8400-e29b-41d4-a716-446655440000</correlation_id>
  </header>
  <body>
    <status>ok</status>
    <session>
      <session_id>sess-2026-keynote-01</session_id>
      <name>Opening Keynote: AI in Integration</name>
      <date>2026-05-20T09:00:00Z</date>
      <location>Aula A, Building 1</location>
      <description>Keynote speech on AI applications</description>
    </session>
    <session>
      <session_id>sess-2026-workshop-02</session_id>
      <name>Hands-On: RabbitMQ & XML Integration</name>
      <date>2026-05-20T14:00:00Z</date>
      <location>Lab 3, Building 2</location>
      <description>Interactive workshop on message queuing</description>
    </session>
  </body>
</message>
```

#### XML Example — Success (No sessions)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <message_id>63a4b5c6-d7e8-9012-abcd-ef1234567802</message_id>
    <timestamp>2026-05-15T10:30:15Z</timestamp>
    <source>planning</source>
    <type>user_enrollments_response</type>
    <version>2.0</version>
    <correlation_id>550e8400-e29b-41d4-a716-446655440001</correlation_id>
  </header>
  <body>
    <status>ok</status>
  </body>
</message>
```

#### XML Example — Error (User not found)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <message_id>63a4b5c6-d7e8-9012-abcd-ef1234567803</message_id>
    <timestamp>2026-05-15T10:30:16Z</timestamp>
    <source>planning</source>
    <type>sessions_list_response</type>
    <version>2.0</version>
    <correlation_id>550e8400-e29b-41d4-a716-446655440002</correlation_id>
  </header>
  <body>
    <status>error</status>
    <error_code>profile_not_found</error_code>
    <error_message>Master UUID e8b27c1d-... not found in Planning database</error_message>
  </body>
</message>
```

#### XSD

```xml
<xs:complexType name="SessionType">
  <xs:sequence>
    <xs:element name="session_id" type="xs:string"/>
    <xs:element name="name" type="xs:string"/>
    <xs:element name="date" type="xs:dateTime"/>
    <xs:element name="location" type="xs:string" minOccurs="0"/>
    <xs:element name="description" type="xs:string" minOccurs="0"/>
  </xs:sequence>
</xs:complexType>

<xs:element name="message">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="header" type="HeaderType"/>
      <xs:element name="body">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="status">
              <xs:simpleType>
                <xs:restriction base="xs:string">
                  <xs:enumeration value="ok"/>
                  <xs:enumeration value="error"/>
                </xs:restriction>
              </xs:simpleType>
            </xs:element>
            <xs:element name="session" type="SessionType" minOccurs="0" maxOccurs="unbounded"/>
            <xs:element name="error_code" type="xs:string" minOccurs="0"/>
            <xs:element name="error_message" type="xs:string" minOccurs="0"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

---

## 3. Facturatie Service Requests

### 3.1 `invoices_list_request` — Request all invoices

**Sent by:** Chatbot MCP Server  
**Sent to:** Facturatie team (queue: `facturatie.rpc`)  
**Purpose:** Fetch all invoices for a user (used by `count_my_invoices` MCP tool)

#### XML Example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<invoices_list_request>
  <master_uuid>e8b27c1d-4f2a-4b3e-9c5f-123456789abc</master_uuid>
</invoices_list_request>
```

#### XSD

```xml
<xs:element name="invoices_list_request">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="master_uuid" type="UUIDType"/>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

---

### 3.2 `invoices_total_request` — Request total invoice amount

**Sent by:** Chatbot MCP Server  
**Sent to:** Facturatie team (queue: `facturatie.rpc`)  
**Purpose:** Fetch total invoice cost (used by `total_invoice_cost` MCP tool)

#### XML Example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<invoices_total_request>
  <master_uuid>e8b27c1d-4f2a-4b3e-9c5f-123456789abc</master_uuid>
</invoices_total_request>
```

#### XSD

```xml
<xs:element name="invoices_total_request">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="master_uuid" type="UUIDType"/>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

---

## 4. Facturatie Service Responses

### 4.1 `invoices_list_response` — List of invoices

**Sent by:** Facturatie team  
**Sent to:** Chatbot MCP Server  
**Queue:** Default reply queue (correlation_id based)

#### XML Example — Success

```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <message_id>73b5c6d7-e8f9-0123-bcde-012345678904</message_id>
    <timestamp>2026-05-15T10:30:20Z</timestamp>
    <source>facturatie</source>
    <type>invoices_list_response</type>
    <version>2.0</version>
    <correlation_id>550e8400-e29b-41d4-a716-446655440003</correlation_id>
  </header>
  <body>
    <status>ok</status>
    <invoice>
      <invoice_id>INV-2026-001</invoice_id>
      <amount currency="eur">50.00</amount>
      <date>2026-04-15</date>
      <status>paid</status>
      <description>Workshop: RabbitMQ Basics</description>
    </invoice>
    <invoice>
      <invoice_id>INV-2026-002</invoice_id>
      <amount currency="eur">75.50</amount>
      <date>2026-05-10</date>
      <status>pending</status>
      <description>Keynote: AI in Integration</description>
    </invoice>
  </body>
</message>
```

#### XML Example — Error

```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <message_id>73b5c6d7-e8f9-0123-bcde-012345678905</message_id>
    <timestamp>2026-05-15T10:30:21Z</timestamp>
    <source>facturatie</source>
    <type>invoices_list_response</type>
    <version>2.0</version>
    <correlation_id>550e8400-e29b-41d4-a716-446655440004</correlation_id>
  </header>
  <body>
    <status>error</status>
    <error_code>database_error</error_code>
    <error_message>Failed to retrieve invoices: connection timeout</error_message>
  </body>
</message>
```

#### XSD

```xml
<xs:complexType name="InvoiceType">
  <xs:sequence>
    <xs:element name="invoice_id" type="xs:string"/>
    <xs:element name="amount" type="AmountType"/>
    <xs:element name="date" type="xs:date"/>
    <xs:element name="status">
      <xs:simpleType>
        <xs:restriction base="xs:string">
          <xs:enumeration value="paid"/>
          <xs:enumeration value="pending"/>
          <xs:enumeration value="overdue"/>
        </xs:restriction>
      </xs:simpleType>
    </xs:element>
    <xs:element name="description" type="xs:string" minOccurs="0"/>
  </xs:sequence>
</xs:complexType>

<xs:element name="invoices_list_response">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="header" type="HeaderType"/>
      <xs:element name="body">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="status">
              <xs:simpleType>
                <xs:restriction base="xs:string">
                  <xs:enumeration value="ok"/>
                  <xs:enumeration value="error"/>
                </xs:restriction>
              </xs:simpleType>
            </xs:element>
            <xs:element name="invoice" type="InvoiceType" minOccurs="0" maxOccurs="unbounded"/>
            <xs:element name="error_code" type="xs:string" minOccurs="0"/>
            <xs:element name="error_message" type="xs:string" minOccurs="0"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

---

### 4.2 `invoices_total_response` — Total invoice cost

**Sent by:** Facturatie team  
**Sent to:** Chatbot MCP Server  
**Queue:** Default reply queue (correlation_id based)

#### XML Example — Success

```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <message_id>83c6d7e8-f9a0-1234-cdef-123456789005</message_id>
    <timestamp>2026-05-15T10:30:22Z</timestamp>
    <source>facturatie</source>
    <type>invoices_total_response</type>
    <version>2.0</version>
    <correlation_id>550e8400-e29b-41d4-a716-446655440005</correlation_id>
  </header>
  <body>
    <status>ok</status>
    <total_amount currency="eur">125.50</total_amount>
    <invoice_count>2</invoice_count>
  </body>
</message>
```

#### XML Example — Error

```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <message_id>83c6d7e8-f9a0-1234-cdef-123456789006</message_id>
    <timestamp>2026-05-15T10:30:23Z</timestamp>
    <source>facturatie</source>
    <type>invoices_total_response</type>
    <version>2.0</version>
    <correlation_id>550e8400-e29b-41d4-a716-446655440006</correlation_id>
  </header>
  <body>
    <status>error</status>
    <error_code>identity_service_unavailable</error_code>
    <error_message>Cannot resolve user profile</error_message>
  </body>
</message>
```

#### XSD

```xml
<xs:complexType name="AmountType">
  <xs:simpleContent>
    <xs:extension base="xs:decimal">
      <xs:attribute name="currency" type="xs:string" fixed="eur" use="required"/>
    </xs:extension>
  </xs:simpleContent>
</xs:complexType>

<xs:element name="invoices_total_response">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="header" type="HeaderType"/>
      <xs:element name="body">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="status">
              <xs:simpleType>
                <xs:restriction base="xs:string">
                  <xs:enumeration value="ok"/>
                  <xs:enumeration value="error"/>
                </xs:restriction>
              </xs:simpleType>
            </xs:element>
            <xs:element name="total_amount" type="AmountType" minOccurs="0"/>
            <xs:element name="invoice_count" type="xs:nonNegativeInteger" minOccurs="0"/>
            <xs:element name="error_code" type="xs:string" minOccurs="0"/>
            <xs:element name="error_message" type="xs:string" minOccurs="0"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
  </xs:complexType>
</xs:element>
```

---

## 5. Error Handling

All error responses conform to the global `system_error` format (Contract §2.6). These error codes are used:

| Code | When |
|------|------|
| `profile_not_found` | Master UUID not found in downstream system |
| `database_error` | Database/storage failure |
| `identity_service_unavailable` | Identity Service cannot be reached |
| `invalid_xml_format` | Incoming request doesn't match XSD |
| `unknown_message_type` | Unknown request type received |

#### System Error XML Example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>
  <header>
    <message_id>93d7e8f9-a0b1-2345-def0-234567890006</message_id>
    <timestamp>2026-05-15T10:30:24Z</timestamp>
    <source>planning</source>
    <type>system_error</type>
    <version>2.0</version>
  </header>
  <body>
    <error_code>profile_not_found</error_code>
    <error_description>Master UUID e8b27c1d-... not found in Planning system</error_description>
    <related_message_id>550e8400-e29b-41d4-a716-446655440007</related_message_id>
  </body>
</message>
```

---

## 6. Integration Checklist

### Planning Team
- [ ] Confirm `planning.exchange` queue/exchange name
- [ ] Implement RPC responder for `sessions_list_request`
- [ ] Implement RPC responder for `user_enrollments_request`
- [ ] Return valid XML matching `sessions_list_response` XSD
- [ ] Test with sample `master_uuid` values

### Facturatie Team
- [ ] Confirm `facturatie.rpc` queue name
- [ ] Implement RPC responder for `invoices_list_request`
- [ ] Implement RPC responder for `invoices_total_request`
- [ ] Return valid XML matching response XSD's
- [ ] Ensure error responses use proper `error_code` (per §5)
- [ ] Test decimal precision for `amount` fields (2 decimals for EUR)

### Frontend/Chatbot Integration
- [ ] Pass `master_uuid` from login context to MCP tools
- [ ] Handle timeout gracefully (RPC timeout = 10 seconds)
- [ ] Display error messages to user in user-friendly way
- [ ] Log all RPC calls for debugging

---

## 7. Notes

- **Valuta:** Alle bedragen zijn verplicht in EUR met `currency="eur"` attribuut
- **Decimals:** Bedragen kunnen tot 2 decimalen (cent precisie) hebben: `xs:decimal`
- **Datums:** ISO 8601 formaat — `2026-05-20T09:00:00Z` (met timezone)
- **UUIDs:** Standaard UUID v4 formaat met patroon `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`

