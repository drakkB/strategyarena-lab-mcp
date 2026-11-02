# Strategy Arena Lab MCP connector

Connects Claude Code, Claude Desktop, Cursor or any MCP client to [Strategy Arena Lab](https://strategyarena.io/en/download), a free desktop app that backtests trading strategies on your own machine.

This repository holds only the stdio connector. The Lab itself is installed separately, and the connector does nothing without it.

## What your AI can do through it

- Search strategy settings on your GPU, or on the CPU without an NVIDIA card.
- Test a Pine v5 strategy on data kept out of the search: the sealed test period opens once.
- Get a verdict that counts every setting tried, so a lucky winner out of thousands reads as a mirage.
- Export the tested rule to Pine for TradingView.

The Lab sends no orders and connects to no broker. This is research on past data, not financial advice.

## Setup

1. Install the Lab: <https://strategyarena.io/en/download> (Windows, Linux).
2. Open the Lab and copy the connection path it gives you. Full guide: <https://strategyarena.io/en/lab-mcp>
3. Add it to your MCP client:

```json
{
  "mcpServers": {
    "strategy-arena-lab": {
      "command": "node",
      "args": ["PATH_COPIED_FROM_THE_LAB"]
    }
  }
}
```

Requires Node.js 18 or newer. The connector talks only to the Lab on `127.0.0.1`, using a session file the Lab writes on your machine.

## No install?

The [online judge](https://strategyarena.io/en/strategy-judge) tests one Pine v5 script in your browser, without an account.

## License

The connector in this repository is under the [MIT license](LICENSE). The Lab is a separate product and is not covered by it.
