import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerOptions } from '../../src/server.js';

export interface ToolCall {
	text: string;
	data: Record<string, unknown> | undefined;
	isError: boolean;
}

/** A connected MCP client talking to a server built with `options`. */
export async function connectClient(options: ServerOptions) {
	const { server, close } = await createServer(options);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: 'drizzle-mcp-tests', version: '1.0.0' });
	await client.connect(clientTransport);
	return {
		client,
		async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
			const result = (await client.callTool({ name, arguments: args })) as {
				content: Array<{ type: string; text?: string }>;
				structuredContent?: Record<string, unknown>;
				isError?: boolean;
			};
			return {
				text: result.content.map((part) => part.text ?? '').join('\n'),
				data: result.structuredContent,
				isError: result.isError ?? false,
			};
		},
		async close() {
			await client.close();
			await close();
		},
	};
}
