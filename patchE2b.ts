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
 *
 * Compatibility
 * -------------
 * Tested against e2b 2.27.0 + @e2b/code-interpreter (latest).
 *
 * Each prototype swap is gated on the original method existing, so older
 * SDKs without one of these methods are left untouched rather than gaining
 * a dead patched property. `@e2b/code-interpreter` is treated as an
 * optional dependency.
 *
 * The apiKey-validation bypass is additionally gated on a behavior probe
 * run once in initSdkReferences() (while prototypes are pristine): if
 * `new ApiClient(cfg, { requireApiKey: true })` with a non-conforming key
 * throws AuthenticationError, we install the accessor; otherwise we skip.
 *
 * Note: the probe checks ONE thing — whether the SDK validates the key
 * format. It does NOT independently verify that the SDK's ApiClient
 * spreads `config.headers` last (the structural property the accessor
 * relies on to override the placeholder X-API-KEY with the real key).
 * That spread-last property is a separate assumption asserted against
 * the current SDK by the regression test in
 * `tests/test_validate_api_key_bypass.ts`. Both properties happened to
 * arrive in the same SDK era; if a future version keeps the validator
 * but reorders the spread, the regression test fails loudly rather than
 * silently sending the placeholder.
 */

// Type for SDK methods
type GetHostFn = (sandboxId: string, port: number, sandboxDomain: string) => string;
type GetSandboxUrlFn = (sandboxId: string, opts: { sandboxDomain: string; envdPort: number }) => string;
type SandboxGetHostFn = (port: number) => string;

// Constants
const JUPYTER_PORT = 49999;
const ENVD_PORT = 49983;
const VALID_API_KEY_PATTERN = /^e2b_[0-9a-f]+$/;
export const PLACEHOLDER_API_KEY = 'e2b_' + '0'.repeat(40);

// Store original methods for potential restoration
let originalGetHost: GetHostFn | null = null;
let originalGetSandboxUrl: GetSandboxUrlFn | null = null;
let originalSandboxGetHost: SandboxGetHostFn | null = null;
let originalJupyterUrlDescriptor: PropertyDescriptor | undefined = undefined;
let originalApiKeyDescriptor: PropertyDescriptor | undefined = undefined;
let originalHeadersDescriptor: PropertyDescriptor | undefined = undefined;
let ConnectionConfig: any = null;
let BaseSandbox: any = null;
let ApiClient: any = null;
let CodeInterpreterSandbox: any = null;
let isPatched = false;

// Tracks whether patchApiKeyValidation() was actually applied this cycle, so
// unpatchE2b knows whether to reverse it. We skip the apiKey accessor install
// on SDK versions that have no validator to bypass (see hasApiKeyValidator).
let apiKeyValidationPatched = false;

// Result of the apiKey-validator probe, cached after the first
// initSdkReferences() call. ``null`` means "not yet probed". The probe runs
// while prototypes are still pristine so it can't be misled by our own
// patches; caching also makes repeated patchE2b() calls free.
let cachedHasApiKeyValidator: boolean | null = null;

// Captured E2B_API_URL from before patchE2b() last ran. `undefined` means
// "was unset"; any string means "restore this exact value on unpatch".
let prePatchE2bApiUrl: string | undefined = undefined;
let prePatchE2bApiUrlCaptured = false;

// Per-instance stashes so we can lie about apiKey during validation while
// still sending the real key in the X-API-KEY request header.
const apiKeyStash = new WeakMap<object, { real: string | undefined; fake: string | undefined }>();
const headersStash = new WeakMap<object, Record<string, string>>();

/**
 * Initialize the SDK references lazily
 */
async function initSdkReferences(): Promise<void> {
  if (ConnectionConfig === null) {
    // Dynamic import to avoid requiring the packages at module load time
    const e2b = await import('e2b');
    ConnectionConfig = e2b.ConnectionConfig;
    BaseSandbox = e2b.Sandbox;
    // ApiClient is needed for the validator-presence probe. Defensive cast
    // for old SDKs that may not export it; absence simply means "no probe,
    // no patch".
    ApiClient = (e2b as any).ApiClient ?? null;
    originalGetHost = ConnectionConfig.prototype.getHost;
    originalGetSandboxUrl = ConnectionConfig.prototype.getSandboxUrl;
    originalSandboxGetHost = BaseSandbox.prototype.getHost;

    // Probe NOW, while prototypes are pristine, so neither our own patches
    // nor any user monkey-patches installed later can mislead the probe.
    cachedHasApiKeyValidator = probeApiKeyValidator();
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
 * Install accessor properties on ConnectionConfig.prototype so non-conforming
 * API keys (e.g. Kruise-issued `sm-...`) survive upstream's `e2b_<hex>` regex
 * check. The validator reads `config.apiKey`; we return a valid placeholder.
 * The actual request header is injected via `config.headers`, which ApiClient
 * spreads last and therefore overrides the placeholder X-API-KEY.
 *
 * LOAD-BEARING ASSUMPTION: ApiClient must continue to spread `config.headers`
 * AFTER the `config.apiKey`-derived `X-API-KEY`. If upstream reorders these
 * (e.g. moves `config.headers` earlier in the spread chain), the placeholder
 * key will silently win and outbound requests will be unauthenticated. The
 * regression test in tests/test_validate_api_key_bypass.ts asserts this.
 */
function patchApiKeyValidation(): void {
  originalApiKeyDescriptor = Object.getOwnPropertyDescriptor(
    ConnectionConfig.prototype,
    'apiKey'
  );
  originalHeadersDescriptor = Object.getOwnPropertyDescriptor(
    ConnectionConfig.prototype,
    'headers'
  );

  Object.defineProperty(ConnectionConfig.prototype, 'apiKey', {
    configurable: true,
    enumerable: true,
    get(this: object) {
      const entry = apiKeyStash.get(this);
      return entry ? entry.fake : undefined;
    },
    set(this: object, value: string | undefined) {
      if (value && !VALID_API_KEY_PATTERN.test(value)) {
        apiKeyStash.set(this, { real: value, fake: PLACEHOLDER_API_KEY });
        const hdrs = headersStash.get(this);
        if (hdrs) hdrs['X-API-KEY'] = value;
      } else {
        apiKeyStash.set(this, { real: value, fake: value });
      }
    },
  });

  Object.defineProperty(ConnectionConfig.prototype, 'headers', {
    configurable: true,
    enumerable: true,
    get(this: object) {
      return headersStash.get(this);
    },
    set(this: object, value: Record<string, string> | undefined) {
      const obj: Record<string, string> = value || {};
      const entry = apiKeyStash.get(this);
      if (entry && entry.real && entry.real !== entry.fake) {
        obj['X-API-KEY'] = entry.real;
      }
      headersStash.set(this, obj);
    },
  });
}

/**
 * Probe whether the current e2b SDK enforces the ``e2b_<hex>`` key format.
 * Constructs a throwaway ApiClient with a deliberately non-conforming key —
 * if an AuthenticationError is raised synchronously, the validator is
 * present and patchApiKeyValidation should be applied. If no error is
 * raised, the SDK has no validator (older versions), and installing the
 * apiKey accessor would risk having a placeholder key sent on the wire
 * (the accessor relies on a separate structural property: ApiClient
 * spreading config.headers last; that property is asserted on current SDK
 * by the regression test in tests/test_validate_api_key_bypass.ts).
 *
 * Called once from initSdkReferences() before any prototype is patched, so
 * the probe always sees pristine SDK behavior.
 */
function probeApiKeyValidator(): boolean {
  if (ApiClient === null || typeof ApiClient !== 'function') return false;
  try {
    const probeCfg = new ConnectionConfig({ apiKey: 'probe-non-conforming-key' });
    new ApiClient(probeCfg, { requireApiKey: true });
    return false;
  } catch (e: any) {
    return e?.constructor?.name === 'AuthenticationError';
  }
}

function unpatchApiKeyValidation(): void {
  if (originalApiKeyDescriptor) {
    Object.defineProperty(ConnectionConfig.prototype, 'apiKey', originalApiKeyDescriptor);
  } else {
    delete ConnectionConfig.prototype.apiKey;
  }
  if (originalHeadersDescriptor) {
    Object.defineProperty(ConnectionConfig.prototype, 'headers', originalHeadersDescriptor);
  } else {
    delete ConnectionConfig.prototype.headers;
  }
  originalApiKeyDescriptor = undefined;
  originalHeadersDescriptor = undefined;
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

  // Capture any pre-existing E2B_API_URL so unpatchE2b() can restore it
  // verbatim rather than blanket-deleting.
  if (!prePatchE2bApiUrlCaptured) {
    prePatchE2bApiUrl = process.env.E2B_API_URL;
    prePatchE2bApiUrlCaptured = true;
  }

  // Set the API URL environment variable
  setEnvVar('E2B_API_URL', getApiUrl(https));

  // Patch BaseSandbox.prototype.getHost (instance method). Each swap is
  // guarded on the original existing, so older SDKs that don't have one of
  // these methods are left untouched rather than gaining a dead property.
  if (originalSandboxGetHost) {
    BaseSandbox.prototype.getHost = patchedSandboxGetHost;
  }

  // Patch ConnectionConfig.prototype.getHost
  if (originalGetHost) {
    ConnectionConfig.prototype.getHost = patchedGetHost;
  }

  // Bypass the upstream `e2b_<hex>` API key format check — but only when
  // the SDK actually has a validator to bypass. The cached probe result
  // was captured in initSdkReferences() on pristine prototypes; skipping
  // on old SDKs avoids feeding the placeholder key into legacy ApiClient
  // code paths that may not honor the `config.headers` last-spread
  // assumption.
  if (cachedHasApiKeyValidator) {
    patchApiKeyValidation();
    apiKeyValidationPatched = true;
  }

  // If not using HTTPS, also patch the sandbox URL and Jupyter URL methods
  if (!https) {
    if (originalGetSandboxUrl) {
      ConnectionConfig.prototype.getSandboxUrl = patchedGetSandboxUrlHttp;
    }

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
 * Restore the original e2b SDK methods (useful for testing or cleanup).
 *
 * If patchE2b() was never called, this is a full no-op — the function will
 * not touch any prototype methods, the validator, or the env var, so any
 * user-installed monkey-patches on the e2b SDK are left undisturbed.
 */
export async function unpatchE2b(): Promise<void> {
  if (!isPatched) {
    return;
  }

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

  // Restore jupyterUrl: either put back the original descriptor, or remove
  // the patched getter we installed (mirrors patch_e2b.py's delattr/setattr
  // branches). Without the delete branch, a patch run on an older
  // code-interpreter that lacks jupyterUrl would leak our getter onto the
  // prototype permanently.
  if (CodeInterpreterSandbox !== null) {
    if (originalJupyterUrlDescriptor) {
      Object.defineProperty(
        CodeInterpreterSandbox.prototype,
        'jupyterUrl',
        originalJupyterUrlDescriptor
      );
    } else if (
      Object.prototype.hasOwnProperty.call(
        CodeInterpreterSandbox.prototype,
        'jupyterUrl'
      )
    ) {
      delete (CodeInterpreterSandbox.prototype as any).jupyterUrl;
    }
  }

  // Restore original apiKey/headers descriptors — only if patchE2b actually
  // installed them this cycle (the probe may have decided to skip).
  if (apiKeyValidationPatched) {
    unpatchApiKeyValidation();
    apiKeyValidationPatched = false;
  }

  // Restore the pre-patch E2B_API_URL value (delete if it was previously
  // unset). If no patchE2b() ever ran, leave the env var untouched — it may
  // belong to the caller.
  if (prePatchE2bApiUrlCaptured) {
    if (prePatchE2bApiUrl === undefined) {
      deleteEnvVar('E2B_API_URL');
    } else {
      setEnvVar('E2B_API_URL', prePatchE2bApiUrl);
    }
    prePatchE2bApiUrl = undefined;
    prePatchE2bApiUrlCaptured = false;
  }

  isPatched = false;
}

export default patchE2b;
