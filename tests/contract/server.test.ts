import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';

describe('MCP Server contract', () => {
  it('responds to initialize with server info', async () => {
    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo!.name).toBe('site-use');

    await client.close();
    await server.close();
  });

  it('does not advertise tools capability when no tools registered', async () => {
    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    // No tools registered — listTools should throw "Method not found"
    // because the server does not advertise the tools capability.
    // This test will change once tools are registered in later capabilities.
    await expect(client.listTools()).rejects.toThrow('Method not found');

    await client.close();
    await server.close();
  });
});
