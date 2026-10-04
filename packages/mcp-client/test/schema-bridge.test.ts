/**
 * The JSON Schema pass-through wrapper and `prefixTools` — pure surface behavior, no wire.
 * The wrapper is internal (not exported); it is observed through the bridged tools' public
 * `inputSchema`, exactly as an agent's tool-container path consumes it.
 */
import { describe, expect, it } from 'vitest';
import { prefixTools, createMcpClient } from '@oribos/mcp-client';
import type { Tool } from '@oribos/core/tools';
import { serveLegacy } from './helpers.js';

const REMOTE_SCHEMA = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } as const;

describe('the JSON Schema pass-through wrapper', () => {
  it('always validates synchronously, returning the value as-is', async () => {
    const served = await serveLegacy({
      tools: [{ name: 'weather', description: 'Weather', inputSchema: REMOTE_SCHEMA as unknown as Record<string, unknown> }],
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      const schema = client.tools.weather?.inputSchema;
      expect(schema).toBeDefined();

      const good = schema?.['~standard'].validate({ city: 'Oslo' });
      expect(good).toEqual({ value: { city: 'Oslo' } });
      // Validation is the remote's business: anything passes here, failures come back through
      // execute as remote error results.
      const junk = schema?.['~standard'].validate({ nope: 42 });
      expect(junk).toEqual({ value: { nope: 42 } });
      await client.close();
    } finally {
      await served.close();
    }
  });

  it("returns the remote document verbatim from jsonSchema.input, target ignored, same reference", async () => {
    const served = await serveLegacy({
      tools: [{ name: 'weather', description: 'Weather', inputSchema: REMOTE_SCHEMA as unknown as Record<string, unknown> }],
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      const converter = client.tools.weather?.inputSchema?.['~standard'].jsonSchema;
      expect(converter).toBeDefined();

      const asDraft07 = converter?.input({ target: 'draft-07' });
      const as2020 = converter?.input({ target: 'draft-2020-12' });
      expect(asDraft07).toEqual(REMOTE_SCHEMA);
      expect(as2020).toBe(asDraft07); // same reference: no rewrite, no target adaptation
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('throws from jsonSchema.output: a bridged tool carries no output schema', async () => {
    const served = await serveLegacy({
      tools: [{ name: 'weather', description: 'Weather', inputSchema: REMOTE_SCHEMA as unknown as Record<string, unknown> }],
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      expect(() => client.tools.weather?.inputSchema?.['~standard'].jsonSchema.output({ target: 'draft-07' })).toThrow(
        /no output schema/,
      );
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('freezes the wrapper, its ~standard bag, the tools, and the snapshot', async () => {
    const served = await serveLegacy({
      tools: [{ name: 'weather', description: 'Weather', inputSchema: REMOTE_SCHEMA as unknown as Record<string, unknown> }],
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      const schema = client.tools.weather?.inputSchema;
      expect(Object.isFrozen(schema)).toBe(true);
      expect(Object.isFrozen(schema?.['~standard'])).toBe(true);
      expect(Object.isFrozen(client.tools.weather)).toBe(true);
      expect(Object.isFrozen(client.tools)).toBe(true);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('stamps the ~standard runtime facts: version 1, vendor oribos, frozen types {input, output} undefined', async () => {
    const served = await serveLegacy({
      tools: [{ name: 'weather', description: 'Weather', inputSchema: REMOTE_SCHEMA as unknown as Record<string, unknown> }],
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      const standard = client.tools.weather?.inputSchema?.['~standard'];

      expect(standard?.version).toBe(1);
      expect(standard?.vendor).toBe('oribos');
      // Both keys exist and are undefined at runtime: the type parameter is caller-asserted
      // (`StandardSchema<unknown, unknown>`), there is no runtime value to carry.
      expect(Object.keys(standard?.types ?? {}).sort()).toEqual(['input', 'output']);
      expect(standard?.types?.input).toBeUndefined();
      expect(standard?.types?.output).toBeUndefined();
      expect(Object.isFrozen(standard?.types)).toBe(true);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('carries no outputSchema on bridged tools', async () => {
    const served = await serveLegacy({
      tools: [{ name: 'weather', description: 'Weather', inputSchema: REMOTE_SCHEMA as unknown as Record<string, unknown> }],
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      expect('outputSchema' in (client.tools.weather ?? {})).toBe(false);
      await client.close();
    } finally {
      await served.close();
    }
  });
});

describe('prefixTools', () => {
  const tool: Tool = Object.freeze({
    description: 'does nothing',
    execute: () => 'done',
  });

  it('prefixes keys with the default separator and keeps the tool objects untouched', () => {
    const prefixed = prefixTools({ weather: tool, ping: tool }, 'remote');
    expect(Object.keys(prefixed).sort()).toEqual(['remote_ping', 'remote_weather']);
    expect(prefixed.remote_weather).toBe(tool); // same reference: the remote name never changes
    expect(Object.isFrozen(prefixed)).toBe(true);
  });

  it('honors a custom separator', () => {
    const prefixed = prefixTools({ weather: tool }, 'remote', '-');
    expect(Object.keys(prefixed)).toEqual(['remote-weather']);
  });

  it('does not mutate the input container', () => {
    const original = { weather: tool };
    prefixTools(original, 'remote');
    expect(Object.keys(original)).toEqual(['weather']);
  });
});
