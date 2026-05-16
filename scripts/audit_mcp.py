"""
audit_mcp.py — Static analysis of all 5 MCP server sources + AI-driven system prompt sync.

Usage:
    python scripts/audit_mcp.py            # show unified diff of proposed _SYSTEM_TEMPLATE
    python scripts/audit_mcp.py --apply    # show diff + patch src/session_store.py
    python scripts/audit_mcp.py --report   # print full audit report without diff
"""

import argparse
import difflib
import os
import re
import sys
import textwrap

import anthropic

# ── Source map ──────────────────────────────────────────────────────────────

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEAM_SOURCES: dict[str, tuple[str, str]] = {
    "crm":        (r"C:\Users\Mediamonster\Documents\GitHub\CRM\src\mcp_server.js",                        "js"),
    "facturatie": (r"C:\Users\Mediamonster\Documents\GitHub\Facturatie\src\services\mcp_server.py",        "py"),
    "frontend":   (r"C:\Users\Mediamonster\Documents\GitHub\IP-groep1-frontend\integratie\mcp_server.py",  "py"),
    "kassa":      (r"C:\Users\Mediamonster\Documents\GitHub\Kassa\integratie\mcp_server.py",               "py"),
    "monitoring": (r"C:\Users\Mediamonster\Documents\GitHub\Monitoring\integratie\mcp_server.py",          "py"),
}

SESSION_STORE = os.path.join(_BASE, "src", "session_store.py")

# ── Helpers ──────────────────────────────────────────────────────────────────

def read_source(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def read_system_template() -> str:
    """Extract the _SYSTEM_TEMPLATE string value from session_store.py."""
    src = read_source(SESSION_STORE)
    m = re.search(r'_SYSTEM_TEMPLATE\s*=\s*\((.*?)\n\)', src, re.DOTALL)
    if not m:
        raise RuntimeError("Could not locate _SYSTEM_TEMPLATE in session_store.py")
    # Reconstruct the actual string by joining the parts
    raw = m.group(1)
    # Strip leading/trailing whitespace and concatenate string literals
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', raw)
    return "\n".join(parts)


def read_full_template_block() -> str:
    """Return the raw Python source of the _SYSTEM_TEMPLATE assignment (for diff)."""
    src = read_source(SESSION_STORE)
    m = re.search(r'(_SYSTEM_TEMPLATE\s*=\s*\(.*?\n\))', src, re.DOTALL)
    if not m:
        raise RuntimeError("Could not locate _SYSTEM_TEMPLATE block in session_store.py")
    return m.group(1)


# ── Synthesis prompt ─────────────────────────────────────────────────────────

SYNTHESIS_PROMPT = """\
You are a senior software architect auditing a chatbot's routing system prompt against its actual MCP tool sources.

## Task

You will receive:
1. The source code of 5 MCP server files (the ground truth of what tools actually exist)
2. The current `_SYSTEM_TEMPLATE` used by the chatbot (what it thinks exists)

Your job:
1. Parse every tool definition from each MCP server source
2. Compare against the current system prompt
3. Produce a COMPLETE replacement `_SYSTEM_TEMPLATE` that is accurate, complete, and well-organized

## Output format

Return ONLY a valid Python string in this exact format — no prose before or after:

```python
_SYSTEM_TEMPLATE = (
    "line 1\\n"
    "line 2\\n"
    ...
)
```

## Requirements for the replacement template

### Keep and refine all existing correct rules:
- Data ownership section (which system owns which concept)
- Term disambiguation section
- Wallet balance two-step rule (CRM Wallet_Status__c → if Leased, call Kassa)
- Output format rules
- Operational rules

### Fix ghost tool references:
- Remove any reference to tools that do NOT exist in the source files
- `frontend__list_users` does NOT exist — remove or replace with correct alternatives

### Add routing for ALL tools currently missing from guidance:

**CRM tools needing routing added:**
- `list_active_leases` → "which wallets/members are currently leased?"
- `get_wallet_stats` → wallet statistics overview
- `get_members_with_cancelled_payment` → cancelled payment members
- `get_checkin_tasks` → check-in events / who checked in
- `get_tasks_by_subject` → look up tasks by subject keyword
- `get_member_consumptions(master_uuid)` → consumption history for a specific member
- `get_consumption_stats` → aggregate consumption statistics
- `get_member_invoice_info(master_uuid)` → member invoice info from CRM
- `get_members_by_type(user_type)` → filter members by type (Bedrijf, Particulier, etc.)
- `get_crm_overview` → high-level CRM overview / dashboard

**Monitoring tools needing routing added:**
- `get_platform_health_overview` → overall platform health dashboard
- `get_error_logs(limit)` → recent error-level logs
- `get_top_errors(limit)` → most frequent errors
- `get_health_scores` → per-service health scores
- `get_offline_services` → which services are currently offline
- `search_logs(query, limit)` → free-text log search
- `get_business_metrics(date_from, date_to)` → business-level metrics from logs
- `get_log_volume_by_service(hours)` → log volume breakdown by service
- `get_error_spikes(hours, threshold)` → detect sudden error rate spikes
- `get_latest_report` → most recent health report
- `get_service_uptime(service_name, days)` → uptime for a specific service
- `get_service_availability(days)` → availability across all services
- `get_payment_revenue(date_from, date_to)` → revenue data from monitoring logs (NOT authoritative — use Facturatie)
- `get_quarantine_stats` → quarantine/isolation statistics

**Frontend tools needing routing added:**
- `get_session_capacity_overview` → all sessions with capacity utilization
- `get_upcoming_sessions(days)` → sessions in the next N days
- `get_sessions_today` → sessions happening today
- `get_most_popular_sessions(limit)` → sessions by enrollment count
- `get_full_sessions` → sessions that have reached capacity
- `get_platform_stats` → overall platform statistics (user counts, session counts)
- `get_enrollment_overview` → enrollment statistics across sessions
- `get_sessions_summary` → summary of all sessions
- `search_sessions_by_title(query)` → search sessions by title keyword
- `get_users_by_role(role)` → Drupal users filtered by role
- `get_blocked_users` → Drupal accounts that are blocked/disabled
- `get_recent_registrations(limit)` → most recently registered website accounts

**Kassa tools needing routing added:**
- `get_all_wallets` → ALL live wallet balances during event (total overview)

**Facturatie tools needing routing added:**
- `get_facturatie_overview` → billing system overview / dashboard
- `get_company_pending_and_billing(client_id)` → pending + billing info for a company
- `get_pending_summary_by_company` → pending amounts grouped by company
- `get_registration_invoices(limit)` → invoices for event registrations
- `get_client_balance(client_id)` → balance for a FossBilling client

### Important rules to preserve verbatim:
- `crm__get_member_wallet(master_uuid)` → reads `Wallet_Status__c`; if Leased → call `kassa__get_wallet_by_master_uuid(master_uuid)`
- Generic user/member questions → CRM, NOT Frontend
- Revenue/billing totals → Facturatie, NOT Monitoring
- DRUPAL user_id ≠ CRM master_uuid — different identifiers
- Parallel tool calls for multi-domain questions
- Write operations require admin confirmation before executing

### Style requirements:
- Use ONLY plain double-quoted Python string literals (no f-strings, no triple-quotes)
- Use \\n within strings for newlines, \\\\n for literal backslash-n
- Escape any double-quotes inside as \\"
- Keep sections clearly labeled with ## headers
- Q: / → format for routing rules
- Keep it concise — prefer one Q: block per concept rather than repeating

---

## MCP Server Sources

"""


def build_prompt(sources: dict[str, str], current_template: str) -> str:
    parts = [SYNTHESIS_PROMPT]
    for label, content in sources.items():
        parts.append(f"### {label.upper()} MCP Server\n\n```\n{content}\n```\n\n")
    parts.append("---\n\n## Current _SYSTEM_TEMPLATE\n\n```\n")
    parts.append(current_template)
    parts.append("\n```\n")
    return "".join(parts)


# ── Claude API call ──────────────────────────────────────────────────────────

def call_claude(prompt: str) -> str:
    client = anthropic.Anthropic()

    # Split prompt into cacheable prefix (sources, static) and volatile suffix (template may change)
    # We cache up to the "Current _SYSTEM_TEMPLATE" marker
    split_marker = "## Current _SYSTEM_TEMPLATE"
    idx = prompt.rfind(split_marker)
    if idx > 0:
        cached_part = prompt[:idx]
        volatile_part = prompt[idx:]
    else:
        cached_part = prompt
        volatile_part = ""

    content_blocks: list[dict] = []
    if volatile_part:
        content_blocks = [
            {
                "type": "text",
                "text": cached_part,
                "cache_control": {"type": "ephemeral"},
            },
            {
                "type": "text",
                "text": volatile_part,
            },
        ]
    else:
        content_blocks = [{"type": "text", "text": cached_part}]

    print("Calling Claude (claude-opus-4-7) for synthesis… this may take 30–90 s", file=sys.stderr)

    with client.messages.stream(
        model="claude-opus-4-7",
        max_tokens=8192,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": content_blocks}],
        betas=["prompt-caching-2024-07-31"],
    ) as stream:
        chunks = []
        for event in stream:
            pass
        message = stream.get_final_message()

    # Extract text from content blocks
    text_parts = [
        block.text
        for block in message.content
        if hasattr(block, "text") and block.text
    ]
    return "\n".join(text_parts)


# ── Extract proposed template from Claude's response ─────────────────────────

def extract_template_block(response: str) -> str:
    """Pull the _SYSTEM_TEMPLATE = (...) block out of Claude's markdown response."""
    # Try fenced code block first
    m = re.search(r"```python\s*\n(_SYSTEM_TEMPLATE\s*=\s*\(.*?\n\))\s*\n```", response, re.DOTALL)
    if m:
        return m.group(1)
    # Fallback: bare assignment
    m = re.search(r"(_SYSTEM_TEMPLATE\s*=\s*\(.*?\n\))", response, re.DOTALL)
    if m:
        return m.group(1)
    raise RuntimeError(
        "Could not find _SYSTEM_TEMPLATE block in Claude's response.\n"
        "Raw response saved to audit_response.txt for inspection."
    )


# ── Diff + patch ─────────────────────────────────────────────────────────────

def show_diff(current_block: str, proposed_block: str) -> None:
    current_lines = current_block.splitlines(keepends=True)
    proposed_lines = proposed_block.splitlines(keepends=True)
    diff = list(difflib.unified_diff(
        current_lines, proposed_lines,
        fromfile="src/session_store.py (current)",
        tofile="src/session_store.py (proposed)",
        lineterm="",
    ))
    if not diff:
        print("No changes — system prompt is already up to date.")
        return
    for line in diff:
        # Simple ANSI coloring if terminal supports it
        if line.startswith("+") and not line.startswith("+++"):
            print(f"\033[32m{line}\033[0m")
        elif line.startswith("-") and not line.startswith("---"):
            print(f"\033[31m{line}\033[0m")
        else:
            print(line)


def apply_patch(proposed_block: str) -> None:
    src = read_source(SESSION_STORE)
    current_block = read_full_template_block()
    if proposed_block not in src:
        new_src = src.replace(current_block, proposed_block, 1)
        if new_src == src:
            print("ERROR: Could not locate _SYSTEM_TEMPLATE block to replace.", file=sys.stderr)
            sys.exit(1)
        with open(SESSION_STORE, "w", encoding="utf-8") as f:
            f.write(new_src)
        print(f"Patched {SESSION_STORE}")
    else:
        print("Template already matches proposed — no changes written.")


# ── Report mode ───────────────────────────────────────────────────────────────

def extract_py_tools(source: str) -> list[str]:
    return re.findall(r'@mcp\.tool\(\)\s*(?:async\s+)?def\s+(\w+)', source)


def extract_js_tools(source: str) -> list[str]:
    # Handles both: server.tool('name', ...) and server.tool(\n  'name',\n  ...)
    return re.findall(r"server\.tool\(\s*['\"](\w+)['\"]", source)


def print_report(sources: dict[str, str], current_template: str) -> None:
    print("\n=== MCP Tool Audit Report ===\n")
    all_tools: dict[str, list[str]] = {}
    for label, content in sources.items():
        if label == "crm":
            tools = extract_js_tools(content)
        else:
            tools = extract_py_tools(content)
        all_tools[label] = tools
        print(f"[{label.upper()}] {len(tools)} tools:")
        for t in tools:
            namespaced = f"{label}__{t}"
            in_prompt = namespaced in current_template or t in current_template
            marker = "  [ok]" if in_prompt else "  [MISSING from system prompt]"
            print(f"  {namespaced}{marker}")
        print()

    # Ghost tools
    print("=== Ghost tools (referenced in system prompt but not found in sources) ===\n")
    # Find all tool references in system prompt (label__toolname pattern)
    referenced = re.findall(r'`(\w+)__(\w+)', current_template)
    for label, tool in referenced:
        if label in all_tools and tool not in all_tools[label]:
            print(f"  GHOST: {label}__{tool}")
    print()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Audit MCP tool sources vs chatbot system prompt")
    parser.add_argument("--apply",  action="store_true", help="Patch session_store.py after showing diff")
    parser.add_argument("--report", action="store_true", help="Print audit report only (no Claude call)")
    args = parser.parse_args()

    # Read all sources
    print("Reading MCP server sources…", file=sys.stderr)
    sources: dict[str, str] = {}
    for label, (path, _lang) in TEAM_SOURCES.items():
        try:
            sources[label] = read_source(path)
            print(f"  [ok] {label}: {path}", file=sys.stderr)
        except FileNotFoundError:
            print(f"  [!!] {label}: {path} NOT FOUND -- skipping", file=sys.stderr)

    current_template = read_system_template()
    current_block = read_full_template_block()

    if args.report:
        print_report(sources, current_template)
        return

    prompt = build_prompt(sources, current_template)
    response = call_claude(prompt)

    # Save raw response for debugging
    debug_path = os.path.join(_BASE, "audit_response.txt")
    with open(debug_path, "w", encoding="utf-8") as f:
        f.write(response)
    print(f"Raw Claude response saved to {debug_path}", file=sys.stderr)

    proposed_block = extract_template_block(response)

    print("\n" + "=" * 70)
    print("PROPOSED CHANGES TO _SYSTEM_TEMPLATE")
    print("=" * 70 + "\n")
    show_diff(current_block, proposed_block)

    if args.apply:
        print("\nApplying patch…")
        apply_patch(proposed_block)
        print("Done. Restart the chatbot for changes to take effect.")
    else:
        print("\nRun with --apply to patch src/session_store.py")


if __name__ == "__main__":
    main()
