"""
Monitoring MCP Server — queries Elasticsearch for service health, errors, and alerts.

The Monitoring team uses an ELK stack (Elasticsearch 8.17). Services publish heartbeats
and log entries to RabbitMQ; Logstash forwards them to date-based indices:
  heartbeats-YYYY.MM.dd  — one heartbeat per second per service
  logs-YYYY.MM.dd        — platform event logs (info/warning/error)

Run standalone: python -m src.mcp_servers.monitoring
or: fastmcp run src/mcp_servers/monitoring.py:mcp --transport streamable-http --port 8005
"""
import os
from typing import Any

import httpx
from fastmcp import FastMCP

mcp = FastMCP("monitoring")

_ES_URL         = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
_ES_USER        = os.getenv("ES_USERNAME")
_ES_PASS        = os.getenv("ES_PASSWORD")
# Real indices are date-based; use wildcards to query across all days
_LOGS_INDEX      = os.getenv("ES_LOGS_INDEX",      "logs-*")
_HEARTBEAT_INDEX = os.getenv("ES_HEARTBEAT_INDEX", "heartbeats-*")

_auth = (_ES_USER, _ES_PASS) if _ES_USER and _ES_PASS else None
_http = httpx.AsyncClient(timeout=10.0, auth=_auth)


async def _es_search(index: str, query: dict) -> dict:
    resp = await _http.post(f"{_ES_URL}/{index}/_search", json=query)
    resp.raise_for_status()
    return resp.json()


@mcp.tool()
async def get_service_status() -> dict[str, Any]:
    """Get the current online/offline status of all integration services based on recent heartbeats."""
    query = {
        "size": 0,
        "query": {
            "bool": {
                "filter": [{"range": {"@timestamp": {"gte": "now-2m"}}}],
            }
        },
        "aggs": {
            "by_source": {
                "terms": {"field": "header.source.keyword", "size": 20},
                "aggs": {
                    "latest": {
                        "top_hits": {
                            "size": 1,
                            "_source": ["header.source", "body.status", "body.uptime", "@timestamp"],
                            "sort": [{"@timestamp": {"order": "desc"}}],
                        }
                    },
                },
            }
        },
    }
    try:
        result = await _es_search(_HEARTBEAT_INDEX, query)
        buckets = result.get("aggregations", {}).get("by_source", {}).get("buckets", [])
        services = []
        for b in buckets:
            hits = b["latest"]["hits"]["hits"]
            src = hits[0]["_source"] if hits else {}
            body = src.get("body", {})
            header = src.get("header", {})
            services.append({
                "service": b["key"],
                "status": body.get("status", "unknown"),
                "uptime_seconds": body.get("uptime"),
                "last_seen": src.get("@timestamp"),
            })
        return {"services": services, "count": len(services)}
    except Exception as exc:
        return {"error": str(exc), "services": []}


@mcp.tool()
async def get_recent_errors(limit: int = 20) -> dict[str, Any]:
    """Get the most recent error and warning log entries across all services."""
    query = {
        "size": min(limit, 100),
        "query": {
            "terms": {"body.level.keyword": ["error", "warning", "ERROR", "WARNING"]}
        },
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": ["header.source", "header.type", "body.level", "body.message", "body.action", "@timestamp", "header.correlation_id"],
    }
    try:
        result = await _es_search(_LOGS_INDEX, query)
        hits = result.get("hits", {}).get("hits", [])
        entries = []
        for h in hits:
            s = h["_source"]
            entries.append({
                "source": s.get("header", {}).get("source", "?"),
                "level": s.get("body", {}).get("level", "?"),
                "message": s.get("body", {}).get("message", ""),
                "action": s.get("body", {}).get("action", ""),
                "@timestamp": s.get("@timestamp"),
                "correlation_id": s.get("header", {}).get("correlation_id"),
            })
        return {"errors": entries, "count": len(entries)}
    except Exception as exc:
        return {"error": str(exc), "errors": []}


@mcp.tool()
async def get_active_alerts() -> dict[str, Any]:
    """Get services that have sent offline or degraded heartbeats in the last 10 minutes."""
    query = {
        "size": 50,
        "query": {
            "bool": {
                "must": [{"terms": {"body.status.keyword": ["offline", "degraded", "error"]}}],
                "filter": [{"range": {"@timestamp": {"gte": "now-10m"}}}],
            }
        },
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": ["header.source", "body.status", "body.message", "@timestamp"],
    }
    try:
        result = await _es_search(_HEARTBEAT_INDEX, query)
        hits = result.get("hits", {}).get("hits", [])
        alerts = []
        for h in hits:
            s = h["_source"]
            alerts.append({
                "service": s.get("header", {}).get("source", "?"),
                "status": s.get("body", {}).get("status", "?"),
                "message": s.get("body", {}).get("message", ""),
                "@timestamp": s.get("@timestamp"),
            })
        return {"alerts": alerts, "count": len(alerts)}
    except Exception as exc:
        return {"error": str(exc), "alerts": []}


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=int(os.getenv("PORT", "8005")))
