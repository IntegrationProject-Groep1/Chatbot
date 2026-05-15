from fastmcp import FastMCP
import inspect

mcp = FastMCP("test")
print(inspect.signature(mcp.run))
