/**
 * Patch for e2b JavaScript/TypeScript SDK
 *
 * This module patches the e2b SDK to use custom routing through kruise.
 *
 * Requirements:
 *   npm install e2b @e2b/code-interpreter
 *   npm install --save-dev @types/node (for TypeScript)
 *
 * Usage:
 *   import { patchE2b } from './patchE2b';
 *   patchE2b(true);  // Use HTTPS
 *   patchE2b(false); // Use HTTP
 */

// Type for SDK methods
type GetHostFn = (sandboxId: string, port: number, sandboxDomain: string) => string;
type GetSandboxUrlFn = (sandboxId: string, opts: { sandboxDomain: string; envdPort: number }) => string;
type SandboxGetHostFn = (port: number) => string;

// Constants
const JUPYTER_PORT = 49999;
const ENVD_PORT = 49983;

// Store original methods for potential restoration
let originalGetHost: GetHostFn | null = null;
let originalGetSandboxUrl: GetSandboxUrlFn | null = null;
let originalSandboxGetHost: SandboxGetHostFn | null = null;
let originalJupyterUrlDescriptor: PropertyDescriptor | undefined = undefined;
let ConnectionConfig: any = null;
let BaseSandbox: any = null;
let CodeInterpreterSandbox: any = null;
let isPatched = false;

/**
 * Initialize the SDK references lazily
 */
async function initSdkReferences(): Promise<void> {
  if (ConnectionConfig === null) {
    // Dynamic import to avoid requiring the packages at module load time
    const e2b = await import('e2b');
    ConnectionConfig = e2b.ConnectionConfig;
    BaseSandbox = e2b.Sandbox;
    originalGetHost = ConnectionConfig.prototype.getHost;
    originalGetSandboxUrl = ConnectionConfig.prototype.getSandboxUrl;
    originalSandboxGetHost = BaseSandbox.prototype.getHost;
  }

  if (CodeInterpreterSandbox === null) {
    try {
      const codeInterpreter = await import('@e2b/code-interpreter');
      CodeInterpreterSandbox = codeInterpreter.Sandbox;
      originalJupyterUrlDescriptor = Object.getOwnPropertyDescriptor(
        CodeInterpreterSandbox.prototype,
        'jupyterUrl'
      );
    } catch {
      // @e2b/code-interpreter is optional
      CodeInterpreterSandbox = null;
    }
  }
}

/**
 * Get E2B_DOMAIN from environment variable
 */
function getE2bDomain(): string {
  const domain = process.env.E2B_DOMAIN;
  if (!domain) {
    throw new Error('E2B_DOMAIN environment variable is not set');
  }
  return domain;
}

/**
 * Custom getHost implementation that uses kruise routing
 * Uses E2B_DOMAIN from environment variable
 * @param sandboxId - The sandbox ID
 * @param port - The port number
 * @param _sandboxDomain - The sandbox domain (ignored, uses E2B_DOMAIN env var)
 * @returns The formatted host URL
 */
function patchedGetHost(
  this: any,
  sandboxId: string,
  port: number,
  _sandboxDomain: string
): string {
  return `${getE2bDomain()}/kruise/${sandboxId}/${port}`;
}

/**
 * Custom getSandboxUrl implementation for HTTP (non-HTTPS) connections
 * @param sandboxId - The sandbox ID
 * @param opts - Options containing sandboxDomain and envdPort
 * @returns The formatted sandbox URL
 */
function patchedGetSandboxUrlHttp(
  this: any,
  sandboxId: string,
  opts: { sandboxDomain: string; envdPort: number }
): string {
  const host = patchedGetHost.call(this, sandboxId, ENVD_PORT, opts.sandboxDomain);
  return `http://${host}`;
}

/**
 * Custom getHost implementation for Sandbox class (instance method)
 * Uses E2B_DOMAIN from environment variable
 * @param port - The port number
 * @returns The formatted host URL
 */
function patchedSandboxGetHost(this: any, port: number): string {
  return `${getE2bDomain()}/kruise/${this.sandboxId}/${port}`;
}

/**
 * Custom jupyterUrl getter for HTTP (non-HTTPS) connections
 * @returns The formatted Jupyter URL
 */
function patchedJupyterUrlHttp(this: any): string {
  const host = patchedSandboxGetHost.call(this, JUPYTER_PORT);
  return `http://${host}`;
}

/**
 * Get the API URL based on the E2B_DOMAIN environment variable
 * @param https - Whether to use HTTPS
 * @returns The formatted API URL
 */
function getApiUrl(https: boolean): string {
  return `${https ? 'https' : 'http'}://${getE2bDomain()}/kruise/api`;
}

/**
 * Set environment variable
 */
function setEnvVar(key: string, value: string): void {
  process.env[key] = value;
}

/**
 * Delete environment variable
 */
function deleteEnvVar(key: string): void {
  delete process.env[key];
}

/**
 * Patch the e2b SDK to use custom routing through kruise
 * @param https - Whether to use HTTPS (default: true)
 */
export async function patchE2b(https: boolean = true): Promise<void> {
  // Prevent double-patching
  if (isPatched) {
    return;
  }

  // Initialize SDK references
  await initSdkReferences();

  if (ConnectionConfig === null) {
    throw new Error('e2b package is not installed. Please run: npm install e2b');
  }

  // Set the API URL environment variable
  setEnvVar('E2B_API_URL', getApiUrl(https));

  // Patch BaseSandbox.prototype.getHost (instance method)
  BaseSandbox.prototype.getHost = patchedSandboxGetHost;

  // Patch ConnectionConfig.prototype.getHost
  ConnectionConfig.prototype.getHost = patchedGetHost;

  // If not using HTTPS, also patch the sandbox URL and Jupyter URL methods
  if (!https) {
    ConnectionConfig.prototype.getSandboxUrl = patchedGetSandboxUrlHttp;

    // Patch the jupyterUrl getter on CodeInterpreterSandbox (if available)
    if (CodeInterpreterSandbox !== null) {
      Object.defineProperty(CodeInterpreterSandbox.prototype, 'jupyterUrl', {
        get: patchedJupyterUrlHttp,
        configurable: true,
      });
    }
  }

  isPatched = true;
}

/**
 * Restore the original e2b SDK methods (useful for testing or cleanup)
 */
export async function unpatchE2b(): Promise<void> {
  // Initialize SDK references if not already done
  await initSdkReferences();

  if (ConnectionConfig === null) {
    return; // Nothing to unpatch
  }

  // Restore original methods
  if (originalSandboxGetHost) {
    BaseSandbox.prototype.getHost = originalSandboxGetHost;
  }
  if (originalGetHost) {
    ConnectionConfig.prototype.getHost = originalGetHost;
  }
  if (originalGetSandboxUrl) {
    ConnectionConfig.prototype.getSandboxUrl = originalGetSandboxUrl;
  }

  // Restore original jupyterUrl getter if it existed
  if (CodeInterpreterSandbox !== null && originalJupyterUrlDescriptor) {
    Object.defineProperty(
      CodeInterpreterSandbox.prototype,
      'jupyterUrl',
      originalJupyterUrlDescriptor
    );
  }

  // Clean up environment variable
  deleteEnvVar('E2B_API_URL');

  isPatched = false;
}

export default patchE2b;
