/* ============================================================
   Shift Festival — Admin Console data
   Real MCP topology — matches actual backend services
   ============================================================ */

const FLOW_W = 720;
const FLOW_H = 460;

const NODES = {
  user:        { x: 310, y: 25,  label: "Admin",           meta: "",                   icon: "U", svc: "user" },
  llama:       { x: 310, y: 120, label: "AI Agent",         meta: "Llama 3.3 · 70B",   icon: "L", svc: "llama", llama: true },

  frontend:    { x: 30,  y: 255, label: "Frontend MCP",    meta: "Sessions · Users",    icon: "W", svc: "frontend" },
  facturatie:  { x: 170, y: 255, label: "Facturatie MCP",  meta: "Invoicing",           icon: "€", svc: "facturatie" },
  crm:         { x: 310, y: 255, label: "CRM MCP",         meta: "Members",             icon: "C", svc: "crm" },
  kassa:       { x: 450, y: 255, label: "Kassa MCP",       meta: "Orders · Sales",      icon: "K", svc: "kassa" },
  monitoring:  { x: 590, y: 255, label: "Monitoring MCP",  meta: "Health · Logs",       icon: "M", svc: "monitoring" },

  drupal:      { x: 30,  y: 375, label: "Drupal",          meta: "Content platform",    icon: "D", svc: "frontend" },
  facturatieDb:{ x: 170, y: 375, label: "FossBilling",     meta: "Billing database",    icon: "B", svc: "facturatie" },
  crmDb:       { x: 310, y: 375, label: "Salesforce",      meta: "CRM platform",        icon: "S", svc: "crm" },
  kassaDb:     { x: 450, y: 375, label: "Odoo",            meta: "Point of sale",       icon: "O", svc: "kassa" },
  elastic:     { x: 590, y: 375, label: "Elasticsearch",   meta: "Search engine",       icon: "E", svc: "monitoring" },
};

const EDGES = [
  ["user",       "llama",         "chat"],
  ["llama",      "frontend",      "MCP"],
  ["llama",      "facturatie",    "MCP"],
  ["llama",      "crm",           "MCP"],
  ["llama",      "kassa",         "MCP"],
  ["llama",      "monitoring",    "MCP"],
  ["frontend",   "drupal",        "GET"],
  ["facturatie", "facturatieDb",  "GET"],
  ["crm",        "crmDb",         "GET"],
  ["kassa",      "kassaDb",       "GET"],
  ["monitoring", "elastic",       "search"],
];

const MCP_SERVERS = [
  { id: "frontend",   port: 8006, tools: 30, list: ["get_all_sessions", "get_session_detail", "get_session_attendance"] },
  { id: "facturatie", port: 8007, tools: 4,  list: ["list_invoices", "total_invoice_cost", "get_invoice_detail", "list_overdue"] },
  { id: "crm",        port: 8008, tools: 20, list: ["list_members", "get_member", "get_member_by_email", "search_members", "get_member_wallet", "get_crm_overview", "get_member_stats", "list_active_leases", "get_wallet_stats", "get_recent_tasks", "+10 more"] },
  { id: "kassa",      port: 8004, tools: 3,  list: ["list_orders", "revenue_by_period", "order_detail"] },
  { id: "monitoring", port: 8005, tools: 34, list: ["get_service_status", "get_recent_logs", "get_heartbeat_timeline", "get_health_scores", "get_platform_health_overview", "+29 more"] },
];

// Active nodes per MCP server (tool name prefix → nodes to highlight)
const SERVER_FLOW = {
  frontend:   { nodes: ["user", "llama", "frontend", "drupal"],         edges: ["user->llama", "llama->frontend", "frontend->drupal"] },
  facturatie: { nodes: ["user", "llama", "facturatie", "facturatieDb"], edges: ["user->llama", "llama->facturatie", "facturatie->facturatieDb"] },
  crm:        { nodes: ["user", "llama", "crm", "crmDb"],               edges: ["user->llama", "llama->crm", "crm->crmDb"] },
  kassa:      { nodes: ["user", "llama", "kassa", "kassaDb"],           edges: ["user->llama", "llama->kassa", "kassa->kassaDb"] },
  monitoring: { nodes: ["user", "llama", "monitoring", "elastic"],      edges: ["user->llama", "llama->monitoring", "monitoring->elastic"] },
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
