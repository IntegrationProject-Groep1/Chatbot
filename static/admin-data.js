/* ============================================================
   Shift Festival — Admin Console data
   Real MCP topology — matches actual backend services
   ============================================================ */

const FLOW_W = 720;
const FLOW_H = 640;

const NODES = {
  user:       { x: 290, y: 22,  label: "Admin",         meta: "you@shift.be",   icon: "U", svc: "user" },
  api:        { x: 290, y: 100, label: "Chatbot API",   meta: "FastAPI · WS",   icon: "A", svc: "user" },
  llama:      { x: 290, y: 195, label: "Llama 3.1 8B",  meta: "NVIDIA NIM",     icon: "L", svc: "llama", llama: true },

  frontend:    { x: 30,  y: 320, label: "Frontend MCP",   meta: ":8006/mcp",     icon: "W", svc: "frontend" },
  facturatie:  { x: 170, y: 320, label: "Facturatie MCP", meta: ":8007/mcp",     icon: "€", svc: "facturatie" },
  crm:         { x: 310, y: 320, label: "CRM MCP",        meta: ":8008/mcp",     icon: "C", svc: "crm" },
  kassa:       { x: 450, y: 320, label: "Kassa MCP",      meta: ":8004/mcp",     icon: "K", svc: "kassa" },
  monitoring:  { x: 580, y: 320, label: "Monitoring MCP", meta: ":8005/mcp",     icon: "M", svc: "monitoring" },

  drupal:      { x: 30,  y: 440, label: "Drupal JSON:API", meta: "frontend",     icon: "D", svc: "frontend" },
  facturatieDb:{ x: 170, y: 440, label: "FossBilling",     meta: "MySQL",        icon: "B", svc: "facturatie" },
  crmDb:       { x: 310, y: 440, label: "Salesforce",      meta: "CRM",          icon: "S", svc: "crm" },
  kassaDb:     { x: 450, y: 440, label: "Odoo",            meta: "Kassa",        icon: "O", svc: "kassa" },
  elastic:     { x: 580, y: 440, label: "Elasticsearch",   meta: "logs-*",       icon: "E", svc: "monitoring" },

  audit:       { x: 290, y: 555, label: "RabbitMQ audit",  meta: "audit.events", icon: "Q", svc: "user" },
};

const EDGES = [
  ["user", "api",              "WebSocket"],
  ["api",  "llama",            "completion"],
  ["llama", "frontend",        "MCP"],
  ["llama", "facturatie",      "MCP"],
  ["llama", "crm",             "MCP"],
  ["llama", "kassa",           "MCP"],
  ["llama", "monitoring",      "MCP"],
  ["frontend",   "drupal",       "GET"],
  ["facturatie", "facturatieDb", "GET"],
  ["crm",        "crmDb",        "GET"],
  ["kassa",      "kassaDb",      "GET"],
  ["monitoring", "elastic",      "_search"],
  ["api", "audit",             "publish"],
];

const MCP_SERVERS = [
  { id: "frontend",   port: 8006, tools: 30, list: ["get_all_sessions", "get_session_detail", "get_session_attendance"] },
  { id: "facturatie", port: 8007, tools: 4,  list: ["list_invoices", "total_invoice_cost", "get_invoice_detail", "list_overdue"] },
  { id: "crm",        port: 8008, tools: 3,  list: ["resolve_user_by_email", "get_member_profile", "list_recent_registrations"] },
  { id: "kassa",      port: 8004, tools: 3,  list: ["list_orders", "revenue_by_period", "order_detail"] },
  { id: "monitoring", port: 8005, tools: 3,  list: ["get_service_status", "get_recent_errors", "get_active_alerts"] },
];

// Active nodes per MCP server (tool name prefix → nodes to highlight)
const SERVER_FLOW = {
  frontend:   { nodes: ["user", "api", "llama", "frontend", "drupal"],    edges: ["user->api", "api->llama", "llama->frontend", "frontend->drupal"] },
  facturatie: { nodes: ["user", "api", "llama", "facturatie", "facturatieDb"], edges: ["user->api", "api->llama", "llama->facturatie", "facturatie->facturatieDb"] },
  crm:        { nodes: ["user", "api", "llama", "crm", "crmDb"],          edges: ["user->api", "api->llama", "llama->crm", "crm->crmDb"] },
  kassa:      { nodes: ["user", "api", "llama", "kassa", "kassaDb"],      edges: ["user->api", "api->llama", "llama->kassa", "kassa->kassaDb"] },
  monitoring: { nodes: ["user", "api", "llama", "monitoring", "elastic"], edges: ["user->api", "api->llama", "llama->monitoring", "monitoring->elastic"] },
};

const SUGGESTIONS_INITIAL = [
  "Show all active sessions for this week",
  "Which services are degraded right now?",
  "Revenue from the Kassa today",
  "Recent error logs across all services",
];

window.FLOW_W = FLOW_W;
window.FLOW_H = FLOW_H;
window.NODES = NODES;
window.EDGES = EDGES;
window.MCP_SERVERS = MCP_SERVERS;
window.SERVER_FLOW = SERVER_FLOW;
window.SUGGESTIONS_INITIAL = SUGGESTIONS_INITIAL;
