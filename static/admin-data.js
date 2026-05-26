/* ============================================================
   Shift Festival — Admin Console data
   A2A topology — Orchestrator → Sub-agents → MCP servers → Backends
   ============================================================ */

const FLOW_W = 720;
const FLOW_H = 495;

const NODES = {
  // ── Layer 1: Admin ──────────────────────────────────────────
  user:         { x: 295, y: 10,  label: "Admin",             meta: "",                      icon: "U", svc: "user" },

  // ── Layer 2: Orchestrator ───────────────────────────────────
  llama:        { x: 295, y: 90,  label: "Orchestrator",       meta: "Llama 3.3 · 70B",      icon: "L", svc: "llama", llama: true },

  // ── Layer 3: Sub-agents (internal — always available) ───────
  subFrontend:  { x: 15,  y: 200, label: "Frontend Agent",     meta: "Sessions · Users",      icon: "W", svc: "frontend",   subagent: true },
  subFacturatie:{ x: 155, y: 200, label: "Facturatie Agent",   meta: "Invoicing",             icon: "€", svc: "facturatie", subagent: true },
  subCrm:       { x: 295, y: 200, label: "CRM Agent",          meta: "Members",               icon: "C", svc: "crm",        subagent: true },
  subKassa:     { x: 435, y: 200, label: "Kassa Agent",        meta: "Orders · Sales",        icon: "K", svc: "kassa",      subagent: true },
  subMonitoring:{ x: 575, y: 200, label: "Monitoring Agent",   meta: "Health · Logs",         icon: "M", svc: "monitoring", subagent: true },

  // ── Layer 4: MCP servers (external — can disconnect) ────────
  frontend:     { x: 15,  y: 300, label: "Frontend MCP",       meta: "port 8006",             icon: "W", svc: "frontend" },
  facturatie:   { x: 155, y: 300, label: "Facturatie MCP",     meta: "port 8007",             icon: "€", svc: "facturatie" },
  crm:          { x: 295, y: 300, label: "CRM MCP",            meta: "port 8008",             icon: "C", svc: "crm" },
  kassa:        { x: 435, y: 300, label: "Kassa MCP",          meta: "port 8004",             icon: "K", svc: "kassa" },
  monitoring:   { x: 575, y: 300, label: "Monitoring MCP",     meta: "port 8005",             icon: "M", svc: "monitoring" },

  // ── Layer 5: Backends ───────────────────────────────────────
  drupal:       { x: 15,  y: 395, label: "Drupal",             meta: "Content platform",      icon: "D", svc: "frontend" },
  facturatieDb: { x: 155, y: 395, label: "FossBilling",        meta: "Billing database",      icon: "B", svc: "facturatie" },
  crmDb:        { x: 295, y: 395, label: "Salesforce",         meta: "CRM platform",          icon: "S", svc: "crm" },
  kassaDb:      { x: 435, y: 395, label: "Odoo",               meta: "Point of sale",         icon: "O", svc: "kassa" },
  elastic:      { x: 575, y: 395, label: "Elasticsearch",      meta: "Search engine",         icon: "E", svc: "monitoring" },
};

const EDGES = [
  // Admin ↔ Orchestrator
  ["user",          "llama",          "chat"],

  // Orchestrator → Sub-agents (via ask_* tools)
  ["llama",         "subFrontend",    "ask_frontend"],
  ["llama",         "subFacturatie",  "ask_facturatie"],
  ["llama",         "subCrm",         "ask_crm"],
  ["llama",         "subKassa",       "ask_kassa"],
  ["llama",         "subMonitoring",  "ask_monitoring"],

  // Sub-agents → MCP servers (via MCP protocol)
  ["subFrontend",   "frontend",       "MCP"],
  ["subFacturatie", "facturatie",     "MCP"],
  ["subCrm",        "crm",            "MCP"],
  ["subKassa",      "kassa",          "MCP"],
  ["subMonitoring", "monitoring",     "MCP"],

  // MCP servers → Backends
  ["frontend",      "drupal",         "GET"],
  ["facturatie",    "facturatieDb",   "GET"],
  ["crm",           "crmDb",          "GET"],
  ["kassa",         "kassaDb",        "GET"],
  ["monitoring",    "elastic",        "search"],
];

const MCP_SERVERS = [
  { id: "frontend",   port: 8006, tools: 30, list: ["get_all_sessions", "get_session_detail", "get_session_attendance"] },
  { id: "facturatie", port: 8007, tools: 4,  list: ["list_invoices", "total_invoice_cost", "get_invoice_detail", "list_overdue"] },
  { id: "crm",        port: 8008, tools: 20, list: ["list_members", "get_member", "get_member_by_email", "search_members", "get_member_wallet", "get_crm_overview", "get_member_stats", "list_active_leases", "get_wallet_stats", "get_recent_tasks", "+10 more"] },
  { id: "kassa",      port: 8004, tools: 3,  list: ["list_orders", "revenue_by_period", "order_detail"] },
  { id: "monitoring", port: 8005, tools: 34, list: ["get_service_status", "get_recent_logs", "get_heartbeat_timeline", "get_health_scores", "get_platform_health_overview", "+29 more"] },
];

// Active nodes/edges per MCP server — includes sub-agent layer
const SERVER_FLOW = {
  frontend:   {
    nodes: ["user", "llama", "subFrontend",   "frontend",   "drupal"],
    edges: ["user->llama", "llama->subFrontend",   "subFrontend->frontend",   "frontend->drupal"],
  },
  facturatie: {
    nodes: ["user", "llama", "subFacturatie", "facturatie", "facturatieDb"],
    edges: ["user->llama", "llama->subFacturatie", "subFacturatie->facturatie", "facturatie->facturatieDb"],
  },
  crm:        {
    nodes: ["user", "llama", "subCrm",        "crm",        "crmDb"],
    edges: ["user->llama", "llama->subCrm",        "subCrm->crm",        "crm->crmDb"],
  },
  kassa:      {
    nodes: ["user", "llama", "subKassa",      "kassa",      "kassaDb"],
    edges: ["user->llama", "llama->subKassa",      "subKassa->kassa",      "kassa->kassaDb"],
  },
  monitoring: {
    nodes: ["user", "llama", "subMonitoring", "monitoring", "elastic"],
    edges: ["user->llama", "llama->subMonitoring", "subMonitoring->monitoring", "monitoring->elastic"],
  },
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
