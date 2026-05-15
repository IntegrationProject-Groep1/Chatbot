"""
Monitoring MCP Server — queries Elasticsearch for service health, errors, and alerts.

The Monitoring team uses an ELK stack. Services publish heartbeats and log entries
to RabbitMQ, which Logstash forwards to Elasticsearch.

Run standalone: python -m src.mcp_servers.monitoring
or: fastmcp run src/mcp_servers/monitoring.py:mcp --transport streamable-http --port 8005
"""
import os
from typing import Any

import httpx
from fastmcp import FastMCP

mcp = FastMCP("monitoring")

_ES_URL = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
_LOGS_INDEX = os.getenv("ES_LOGS_INDEX", "logs")
_HEARTBEAT_INDEX = os.getenv("ES_HEARTBEAT_INDEX", "logs")

_http = httpx.AsyncClient(timeout=10.0)


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
                "must": [{"term": {"type": "heartbeat"}}],
                "filter": [{"range": {"@timestamp": {"gte": "now-2m"}}}],
            }
        },
        "aggs": {
            "by_source": {
                "terms": {"field": "source.keyword", "size": 20},
                "aggs": {
                    "latest": {"top_hits": {"size": 1, "_source": ["source", "status", "@timestamp"], "sort": [{"@timestamp": {"order": "desc"}}]}},
                },
            }
        },
    }
    try:
        result = await _es_search(_HEARTBEAT_INDEX, query)
        buckets = result.get("aggregations", {}).get("by_source", {}).get("buckets", [])
        services = []
        for b in buckets:
            hit = b["latest"]["hits"]["hits"]
            src = hit[0]["_source"] if hit else {}
            services.append({
                "service": b["key"],
                "status": src.get("status", "unknown"),
                "last_seen": src.get("@timestamp"),
            })
        return {"services": services, "count": len(services)}
    except Exception as exc:
        return {"error": str(exc), "services": []}


@mcp.tool()
async def get_recent_errors(limit: int = 20) -> dict[str, Any]:
    """Get the most recent error and warning log entries across all services."""
    query = {
        "size": limit,
        "query": {"terms": {"level.keyword": ["error", "warning", "ERROR", "WARNING"]}},
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": ["source", "level", "message", "@timestamp", "correlation_id"],
    }
    try:
        result = await _es_search(_LOGS_INDEX, query)
        hits = result.get("hits", {}).get("hits", [])
        entries = [h["_source"] for h in hits]
        return {"errors": entries, "count": len(entries)}
    except Exception as exc:
        return {"error": str(exc), "errors": []}


@mcp.tool()
async def get_active_alerts() -> dict[str, Any]:
    """Get active monitoring alerts (services that have been offline or in error state)."""
    query = {
        "size": 50,
        "query": {
            "bool": {
                "must": [{"terms": {"status.keyword": ["offline", "degraded", "error"]}}],
                "filter": [{"range": {"@timestamp": {"gte": "now-10m"}}}],
            }
        },
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": ["source", "status", "message", "@timestamp"],
    }
    try:
        result = await _es_search(_LOGS_INDEX, query)
        hits = result.get("hits", {}).get("hits", [])
        alerts = [h["_source"] for h in hits]
        return {"alerts": alerts, "count": len(alerts)}
    except Exception as exc:
        return {"error": str(exc), "alerts": []}


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=int(os.getenv("PORT", "8005")))
