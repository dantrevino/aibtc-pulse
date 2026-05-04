/**
 * LLM runner using @opencode-ai/sdk for process management.
 * Replaces raw spawn-based opencode invocation with SDK's server/client pattern.
 */

let client = null;
let server = null;

export async function initOpencode(opts = {}) {
  const { createOpencode } = await import("@opencode-ai/sdk");
  
  const opencode = await createOpencode({
    config: {
      logLevel: opts.verbose ? "debug" : "warn",
    },
    timeout: opts.timeout || 30000,
  });
  
  client = opencode.client;
  server = opencode.server;
  
  return { client, server };
}

export function getClient() {
  return client;
}

export function isReady() {
  return client !== null;
}

export async function prompt(sessionId, promptText, opts = {}) {
  if (!client) {
    throw new Error("OpenCode client not initialized. Call initOpencode() first.");
  }
  
  const { model, timeout = 120000 } = opts;
  
  const messageParts = [{ type: "text", text: promptText }];
  
  let modelConfig = undefined;
  if (model) {
    const [providerID, modelID] = model.split("/");
    if (providerID && modelID) {
      modelConfig = { providerID, modelID };
    }
  }
  
  const response = await client.session.prompt({
    body: {
      parts: messageParts,
      ...(modelConfig ? { model: modelConfig } : {}),
    },
    path: { id: sessionId },
    query: opts.directory ? { directory: opts.directory } : undefined,
  }, {
    timeout,
  });
  
  return response;
}

export async function promptAsync(sessionId, promptText, opts = {}) {
  if (!client) {
    throw new Error("OpenCode client not initialized. Call initOpencode() first.");
  }
  
  const { model, timeout = 120000 } = opts;
  
  const messageParts = [{ type: "text", text: promptText }];
  
  let modelConfig = undefined;
  if (model) {
    const [providerID, modelID] = model.split("/");
    if (providerID && modelID) {
      modelConfig = { providerID, modelID };
    }
  }
  
  const response = await client.session.promptAsync({
    body: {
      parts: messageParts,
      ...(modelConfig ? { model: modelConfig } : {}),
    },
    path: { id: sessionId },
    query: opts.directory ? { directory: opts.directory } : undefined,
  }, {
    timeout,
  });
  
  return response;
}

export function close() {
  if (server) {
    try {
      server.close();
    } catch (e) {
      console.error("Error closing opencode server:", e.message);
    }
    server = null;
    client = null;
  }
}