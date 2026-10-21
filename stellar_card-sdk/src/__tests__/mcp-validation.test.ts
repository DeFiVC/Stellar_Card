// Unit tests for mcp.ts tool-call argument validation and JSON-RPC/MCP
// spec compliance.
//
// These tests drive the *real* request handlers registered on the
// exported `server` through an in-memory MCP transport + a real MCP
// `Client`, rather than re-implementing the dispatch logic. That way
// a bug in the actual handler (bad schema, wrong error shape, etc.)
// shows up here instead of only being caught by a parallel copy of
// the logic.
//
// Scope (per issue #726):
//   - valid / missing / malformed tool arguments
//   - tool execution errors -> standard MCP error response (isError)
//   - tool definitions match the MCP spec (name, description, inputSchema)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// mcp.ts reads CARDS402_API_KEY / OWS_WALLET_NAME at module load time and
// warns on stderr when unset — set them before import so the module under
// test behaves like a configured deployment, and stub stderr so an
// unrelated warning doesn't pollute test output.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.CARDS402_API_KEY = 'test-api-key';
  process.env.OWS_WALLET_NAME = 'test-wallet';
  delete process.env.OWS_WALLET_PASSPHRASE;
  delete process.env.OWS_VAULT_PATH;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = await import('../mcp');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('MCP tool registration (tools/list)', () => {
  it('lists at least the known tool set', async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'purchase_vcc',
          'setup_wallet',
          'check_order',
          'check_budget',
          'generate_card_payment_url',
          'get_exchange_rates',
          'get_gas_fee_estimates',
        ]),
      );
    } finally {
      await close();
    }
  });

  it.each([
    'purchase_vcc',
    'setup_wallet',
    'check_order',
    'check_budget',
    'generate_card_payment_url',
    'get_exchange_rates',
    'get_gas_fee_estimates',
  ])('tool definition for %s matches the MCP Tool spec shape', async (toolName) => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === toolName) as Tool | undefined;
      expect(tool).toBeDefined();
      expect(typeof tool!.name).toBe('string');
      expect(typeof tool!.description).toBe('string');
      expect(tool!.description!.length).toBeGreaterThan(0);
      expect(tool!.inputSchema).toBeDefined();
      expect(tool!.inputSchema.type).toBe('object');
      expect(tool!.inputSchema.properties).toBeDefined();
      // `required` must only reference keys that exist in `properties`.
      const props = Object.keys(tool!.inputSchema.properties ?? {});
      for (const req of (tool!.inputSchema.required as string[] | undefined) ?? []) {
        expect(props).toContain(req);
      }
    } finally {
      await close();
    }
  });

  it('purchase_vcc requires amount_usdc', async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'purchase_vcc')!;
      expect(tool.inputSchema.required).toEqual(['amount_usdc']);
    } finally {
      await close();
    }
  });
});

describe('Tool call: purchase_vcc — argument validation', () => {
  it('rejects malformed amount_usdc (non-numeric)', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'purchase_vcc',
        arguments: { amount_usdc: 'not-a-number' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/decimal string/i);
    } finally {
      await close();
    }
  });

  it('rejects amount_usdc below the minimum', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'purchase_vcc',
        arguments: { amount_usdc: '0.00' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/at least 0\.01/i);
    } finally {
      await close();
    }
  });

  it('rejects amount_usdc above the maximum', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'purchase_vcc',
        arguments: { amount_usdc: '10000.01' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/cannot exceed 10000/i);
    } finally {
      await close();
    }
  });

  it('rejects an invalid payment_asset', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'purchase_vcc',
        arguments: { amount_usdc: '10.00', payment_asset: 'bitcoin' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/payment_asset must be/i);
    } finally {
      await close();
    }
  });

  it('treats missing amount_usdc the same as an empty/malformed string (standard MCP error)', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'purchase_vcc',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      expect((result.content as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('surfaces a missing API key as a structured MCP error, not a thrown exception', async () => {
    delete process.env.CARDS402_API_KEY;
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'purchase_vcc',
        arguments: { amount_usdc: '10.00' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/CARDS402_API_KEY/);
    } finally {
      await close();
    }
  });

  it('surfaces a missing wallet name as a structured MCP error', async () => {
    delete process.env.OWS_WALLET_NAME;
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'purchase_vcc',
        arguments: { amount_usdc: '10.00' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/OWS_WALLET_NAME/);
    } finally {
      await close();
    }
  });
});

describe('Tool call: check_order — argument validation', () => {
  it('rejects an invalid order_id format', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'check_order',
        arguments: { order_id: '../etc/passwd' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/invalid order ID format/i);
    } finally {
      await close();
    }
  });

  it('rejects a missing order_id', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'check_order',
        arguments: {},
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('Tool call: get_exchange_rates — argument validation', () => {
  it('rejects an unknown base_asset with a structured error', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'get_exchange_rates',
        arguments: { base_asset: 'doge' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/Unknown base asset/i);
    } finally {
      await close();
    }
  });

  it('returns rates for valid default arguments', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'get_exchange_rates',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.rates).toBeDefined();
      expect(parsed.base_asset).toBe('USD');
    } finally {
      await close();
    }
  });
});

describe('Tool call: get_gas_fee_estimates — argument validation', () => {
  it('rejects an unknown operation_type', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'get_gas_fee_estimates',
        arguments: { operation_type: 'mint_nft' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/Unknown operation type/i);
    } finally {
      await close();
    }
  });

  it('returns a fee estimate for a valid operation_type', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'get_gas_fee_estimates',
        arguments: { operation_type: 'payment' },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.fee_estimate).toBeDefined();
    } finally {
      await close();
    }
  });
});

describe('Tool call: generate_card_payment_url — argument validation', () => {
  it('rejects a missing amount', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'generate_card_payment_url',
        arguments: {},
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('rejects an out-of-range amount', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'generate_card_payment_url',
        arguments: { amount: '20000.00' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('accepts a valid amount and returns a payment URL + QR data', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'generate_card_payment_url',
        arguments: { amount: '10.00', currency: 'USDC' },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.payment_url).toMatch(/^https?:\/\//);
      expect(parsed.qr_data).toMatch(/^web\+stellar:pay\?/);
      expect(parsed.order_id).toBeDefined();
    } finally {
      await close();
    }
  });
});

describe('Unknown tool call', () => {
  it('returns a standard MCP error response for an unregistered tool name', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: 'definitely_not_a_real_tool',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/Unknown tool/i);
    } finally {
      await close();
    }
  });
});

describe('JSON-RPC 2.0 / MCP protocol compliance', () => {
  it('listTools response is a well-formed MCP ListToolsResult', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.listTools();
      expect(Array.isArray(result.tools)).toBe(true);
      for (const tool of result.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  it('callTool response content is always a non-empty array of content blocks', async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: 'check_budget', arguments: {} });
      expect(Array.isArray(result.content)).toBe(true);
      expect((result.content as unknown[]).length).toBeGreaterThan(0);
      for (const block of result.content as Array<{ type: string }>) {
        expect(block.type).toBe('text');
      }
    } finally {
      await close();
    }
  });
});
